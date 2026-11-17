import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { createStarsPayments, durationLabel, vipDuration } from '../utils/starsPayments.js';

test('proportional duration retains fractional days and validates whole Stars', () => {
  assert.equal(vipDuration(280), 30 * 86400000);
  assert.equal(vipDuration(350), 37.5 * 86400000);
  assert.equal(vipDuration(420), 45 * 86400000);
  assert.equal(vipDuration(560), 60 * 86400000);
  assert.equal(durationLabel(vipDuration(281)), '30 дн. 2 ч. 34 мин.');
  for (const amount of [0, -1, NaN, 1.1, '280', 1000001]) assert.throws(() => vipDuration(amount));
});

const uri = process.env.STARS_TEST_MONGO_URL;
test('payment lifecycle on isolated MongoDB', { skip: !uri }, async t => {
  const client = new MongoClient(uri);
  await client.connect();
  // Explicit test database. Never use the production SquadJS namespace here.
  const db = client.db('telegram_stars_test');
  const service = createStarsPayments(db);
  await service.init();
  const steamId = '76561198000000001';
  const payer = 123456;
  const receipt = order => ({ currency: 'XTR', total_amount: order.amount,
    invoice_payload: service.payload(order), telegram_payment_charge_id: `charge-${order._id}` });
  const prepare = async (amount = 350) => {
    const order = await service.createOrder(payer, steamId, amount);
    await service.accept(order._id, payer);
    return order;
  };
  try {
    await t.test('new invoices enforce 350 Stars while already issued 280-Star invoices remain payable', async () => {
      for (const amount of [1, 280, 349]) await assert.rejects(service.createOrder(payer, steamId, amount), /INVALID_AMOUNT/);
      const order = { _id: 'legacy-280', payerId: String(payer), steamId, amount: 280, durationMs: vipDuration(280),
        currency: 'XTR', status: 'invoice', acceptedAt: new Date(), createdAt: new Date(), expiresAt: new Date(Date.now() + 60000) };
      await service.orders.insertOne(order);
      assert.equal(await service.checkout({ ...receipt(order), from: { id: payer } }), true);
    });
    await t.test('only the paying user and the persisted amount pass checkout', async () => {
      const order = await prepare();
      const query = { ...receipt(order), from: { id: payer } };
      assert.equal(await service.checkout(query), true);
      await assert.rejects(service.checkout({ ...query, total_amount: 1 }), /PAYMENT_MISMATCH/);
      await assert.rejects(service.checkout({ ...query, currency: 'RUB' }), /PAYMENT_MISMATCH/);
      await assert.rejects(service.checkout({ ...query, from: { id: payer + 1 } }), /PAYMENT_MISMATCH/);
      await service.orders.updateOne({ _id: order._id }, { $set: { expiresAt: new Date(0) } });
      assert.equal(await service.checkout(query), false);
    });
    await t.test('an unaccepted draft cannot be paid or accepted by another user', async () => {
      const order = await service.createOrder(payer, steamId, 350);
      assert.equal(await service.accept(order._id, payer + 1), null);
      await assert.rejects(service.paid(receipt(order), payer), /INVALID_CHARGE/);
    });
    await t.test('new recipients get VIP and a durable sync marker', async () => {
      const order = await prepare(420);
      const start = Date.now();
      const result = await service.paid(receipt(order), payer);
      const player = await service.players.findOne({ _id: steamId });
      assert.equal(result.newlyGranted, true);
      assert.equal((await service.orders.findOne({ _id: order._id })).status, 'fulfilled');
      assert.equal(player.vipSyncPending, service.payload(order));
      assert.ok(player.vipEndDate.getTime() >= start + vipDuration(420));
    });
    await t.test('concurrent duplicate notifications extend only once', async () => {
      const prior = await service.players.findOne({ _id: steamId });
      const order = await prepare();
      await Promise.all(Array.from({ length: 20 }, () => service.paid(receipt(order), payer)));
      const player = await service.players.findOne({ _id: steamId });
      assert.equal(player.vipEndDate.getTime(), prior.vipEndDate.getTime() + vipDuration(350));
      assert.equal(player.starsVipReceipts.filter(id => id === receipt(order).telegram_payment_charge_id).length, 1);
      assert.equal(await service.checkout({ ...receipt(order), from: { id: payer } }), false);
    });
    await t.test('separate simultaneous purchases add both durations', async () => {
      const prior = await service.players.findOne({ _id: steamId });
      const a = await prepare(351), b = await prepare(560);
      await Promise.all([service.paid(receipt(a), payer), service.paid(receipt(b), payer)]);
      const player = await service.players.findOne({ _id: steamId });
      assert.equal(player.vipEndDate.getTime(), prior.vipEndDate.getTime() + vipDuration(351) + vipDuration(560));
      assert.equal(player.vipSyncPending, prior.vipSyncPending);
    });
    await t.test('recovery after grant-before-completion crash cannot double grant', async () => {
      const order = await prepare();
      await service.paid(receipt(order), payer);
      const prior = await service.players.findOne({ _id: steamId });
      await service.orders.updateOne({ _id: order._id }, { $set: { status: 'paid' } });
      await service.retry();
      assert.equal((await service.players.findOne({ _id: steamId })).vipEndDate.getTime(), prior.vipEndDate.getTime());
    });
    await t.test('recovery after persisting receipt but before paid status grants once', async () => {
      const order = await prepare();
      const prior = await service.players.findOne({ _id: steamId });
      await service.orders.updateOne({ _id: order._id }, { $set: { chargeId: receipt(order).telegram_payment_charge_id } });
      await service.retry();
      await service.retry();
      assert.equal((await service.players.findOne({ _id: steamId })).vipEndDate.getTime(), prior.vipEndDate.getTime() + vipDuration(350));
    });
    await t.test('a charge cannot pay another order or replace a paid order charge', async () => {
      const a = await prepare(), b = await prepare();
      await service.paid(receipt(a), payer);
      await assert.rejects(service.paid({ ...receipt(b), telegram_payment_charge_id: receipt(a).telegram_payment_charge_id }, payer), /E11000/);
      await assert.rejects(service.paid({ ...receipt(a), telegram_payment_charge_id: 'other-charge' }, payer), /ORDER_ALREADY_PAID/);
    });
    await t.test('expired previous VIP starts from now and wrong Steam IDs are rejected', async () => {
      await service.players.updateOne({ _id: steamId }, { $set: { vipEndDate: new Date(0) } });
      const order = await prepare(350), start = Date.now();
      const result = await service.paid(receipt(order), payer);
      assert.ok(result.vipEndDate.getTime() >= start + vipDuration(350));
      await assert.rejects(service.createOrder(payer, 76561198000000001, 280), /INVALID_IDENTITY/);
      assert.equal(await service.paid({ invoice_payload: 'foreign' }, payer), null);
    });
  } finally {
    await db.dropDatabase();
    await client.close();
  }
});
