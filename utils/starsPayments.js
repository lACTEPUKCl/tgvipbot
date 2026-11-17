import { randomUUID } from 'node:crypto';

export const STARS_PRICE = 280;
export const MIN_STARS = 350;
export const VIP_DAYS = 30;
const DAY = 86400000;
const PREFIX = 'rns-stars:';
const durable = { writeConcern: { w: 'majority', j: true } };
export const validSteamId = value => typeof value === 'string' && /^7656119\d{10}$/.test(value);

export function vipDuration(amount) {
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000000) throw new Error('INVALID_AMOUNT');
  return Math.floor(amount * VIP_DAYS * DAY / STARS_PRICE);
}

export function durationLabel(milliseconds) {
  const minutes = Math.floor(milliseconds / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  const rest = minutes % 60;
  return [days && `${days} дн.`, hours && `${hours} ч.`, rest && `${rest} мин.`].filter(Boolean).join(' ');
}

export function createStarsPayments(db) {
  const orders = db.collection('telegramStarsOrders');
  const players = db.collection('mainstats');
  async function init() {
    await orders.createIndex({ chargeId: 1 }, { unique: true, sparse: true });
    await orders.createIndex({ status: 1, createdAt: 1 });
    await orders.createIndex({ status: 1, notifiedAt: 1 });
  }
  async function createOrder(payerId, steamId, amount) {
    if (!validSteamId(steamId) || !/^\d+$/.test(String(payerId))) throw new Error('INVALID_IDENTITY');
    const durationMs = vipDuration(amount);
    if (amount < MIN_STARS) throw new Error('INVALID_AMOUNT');
    const order = { _id: randomUUID(), payerId: String(payerId), steamId, amount,
      durationMs, currency: 'XTR', status: 'draft', createdAt: new Date(),
      expiresAt: new Date(Date.now() + DAY) };
    // A recipient can be new to our servers. Payment must still be recoverable.
    await players.updateOne({ _id: steamId }, { $setOnInsert: { createdAt: new Date() } }, { ...durable, upsert: true });
    await orders.insertOne(order, durable);
    return order;
  }
  function matches(order, payment, payerId) {
    return order && String(payerId) === order.payerId && payment.currency === 'XTR'
      && payment.total_amount === order.amount && vipDuration(order.amount) === order.durationMs;
  }
  async function findPayment(payment, payerId) {
    if (typeof payment?.invoice_payload !== 'string' || !payment.invoice_payload.startsWith(PREFIX)) return null;
    const order = await orders.findOne({ _id: payment.invoice_payload.slice(PREFIX.length) });
    if (!matches(order, payment, payerId)) throw new Error('PAYMENT_MISMATCH');
    return order;
  }
  async function checkout(query) {
    const order = await findPayment(query, query.from?.id);
    return Boolean(order && order.status === 'invoice' && order.acceptedAt && order.expiresAt > new Date());
  }
  async function accept(orderId, payerId) {
    return orders.findOneAndUpdate({ _id: orderId, payerId: String(payerId), status: 'draft',
      expiresAt: { $gt: new Date() } }, { $set: { status: 'invoice', acceptedAt: new Date(), termsVersion: 1 } },
    { ...durable, returnDocument: 'after' });
  }
  async function fulfill(order) {
    if (!['paid', 'fulfilled'].includes(order.status) || !order.chargeId) throw new Error('UNPAID_ORDER');
    // The receipt and expiry change share ONE atomic document update. A crash
    // before the order is marked fulfilled cannot extend the VIP twice.
    const marker = `${PREFIX}${order._id}`;
    const result = await players.updateOne({ _id: order.steamId, starsVipReceipts: { $ne: order.chargeId } }, [
      { $set: {
        vipEndDate: { $add: [{ $cond: [{ $and: [
          { $eq: [{ $type: '$vipEndDate' }, 'date'] }, { $gt: ['$vipEndDate', '$$NOW'] },
        ] }, '$vipEndDate', '$$NOW'] }, order.durationMs] },
        starsVipReceipts: { $concatArrays: [{ $ifNull: ['$starsVipReceipts', []] }, [{ $literal: order.chargeId }]] },
        // The site's existing durable VIP sync worker publishes Reserved to all
        // servers. Preserve another pending purchase's synchronization marker.
        vipSyncPending: { $ifNull: ['$vipSyncPending', { $literal: marker }] },
      } },
    ], durable);
    const player = await players.findOne({ _id: order.steamId }, { projection: { vipEndDate: 1, starsVipReceipts: 1 } });
    if (!player?.starsVipReceipts?.includes(order.chargeId)) throw new Error('VIP_GRANT_PENDING');
    await orders.updateOne({ _id: order._id, chargeId: order.chargeId }, {
      $set: { status: 'fulfilled', fulfilledAt: new Date(), vipEndDate: player.vipEndDate },
    }, durable);
    return { ...order, status: 'fulfilled', vipEndDate: player.vipEndDate, newlyGranted: result.modifiedCount === 1 };
  }
  async function paid(payment, payerId) {
    const order = await findPayment(payment, payerId);
    if (!order) return null;
    const chargeId = payment.telegram_payment_charge_id;
    if (typeof chargeId !== 'string' || !chargeId || chargeId.length > 512 || !order.acceptedAt) throw new Error('INVALID_CHARGE');
    const result = await orders.updateOne({ _id: order._id, status: { $in: ['invoice', 'paid', 'fulfilled'] },
      $or: [{ chargeId: { $exists: false } }, { chargeId }] }, {
      $set: { chargeId, paidAt: new Date() },
    }, durable);
    if (!result.matchedCount) throw new Error('ORDER_ALREADY_PAID');
    // Keep fulfilled terminal, including duplicate payment notifications.
    await orders.updateOne({ _id: order._id, status: 'invoice', chargeId }, { $set: { status: 'paid' } }, durable);
    return fulfill(await orders.findOne({ _id: order._id }));
  }
  async function retry() {
    // Includes the crash boundary between persisting the charge and paid status.
    const pending = await orders.find({ status: { $in: ['invoice', 'paid'] }, chargeId: { $exists: true } })
      .sort({ createdAt: 1 }).limit(50).toArray();
    for (const order of pending) {
      try {
        await orders.updateOne({ _id: order._id, status: 'invoice' }, { $set: { status: 'paid' } }, durable);
        await fulfill({ ...order, status: 'paid' });
      } catch (error) {
        console.warn('[Stars] grant remains pending', error.code || error.name);
      }
    }
  }
  return { init, createOrder, accept, checkout, paid, retry, orders, players, payload: order => PREFIX + order._id };
}
