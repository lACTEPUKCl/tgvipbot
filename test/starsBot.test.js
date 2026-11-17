import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { installStarsBot } from '../utils/starsBot.js';
import { createHash } from 'node:crypto';
import { resolveDiscordSupportLink } from '../utils/discordSupportLink.js';

test('Telegram private-chat purchase flow uses the chosen SteamID, amount and receipt', {
  skip: !process.env.STARS_TEST_MONGO_URL,
}, async () => {
  const client = new MongoClient(process.env.STARS_TEST_MONGO_URL);
  await client.connect();
  const db = client.db('telegram_stars_ui_test');
  const handlers = new Map(), commands = [], messages = [], invoices = [], checkouts = [];
  const bot = {
    on: (name, handler) => handlers.set(name, handler),
    onText: (regex, handler) => commands.push({ regex, handler }),
    sendMessage: async (...args) => messages.push(args),
    sendInvoice: async (...args) => invoices.push(args),
    answerPreCheckoutQuery: async (...args) => checkouts.push(args),
    _request: async () => ({ transactions: [] }),
  };
  try {
    const service = await installStarsBot(bot, db);
    const from = { id: 234567 }, chat = { id: 234567, type: 'private' };
    const token = 'a'.repeat(43), discordId = '123456789012345678';
    const steamId = '76561198000000002';
    await service.players.insertOne({ _id: steamId, discordid: discordId });
    await service.players.insertOne({ _id: '76561198000000003', telegramid: String(from.id) });
    const linkId = createHash('sha256').update(token).digest('hex');
    await db.collection('telegramSupportLinks').insertOne({ _id: linkId, discordId, steamId, expiresAt: new Date(Date.now() + 60000) });
    const start = `/start support_${token}`;
    const command = commands.find(row => row.regex.test(start));
    await command.handler({ from, chat }, start.match(command.regex));
    assert.equal(messages.length, 1);
    assert.match(messages[0][1], new RegExp(steamId));
    assert.doesNotMatch(messages[0][1], /76561198000000003/);
    assert.equal(await resolveDiscordSupportLink(db, token, from.id + 1), null);
    assert.equal(await resolveDiscordSupportLink(db, 'b'.repeat(43), from.id), null);
    await db.collection('telegramSupportLinks').updateOne({ _id: linkId }, { $set: { expiresAt: new Date(0) } });
    assert.equal(await resolveDiscordSupportLink(db, token, from.id), null);
    await db.collection('telegramSupportLinks').updateOne({ _id: linkId }, { $set: { expiresAt: new Date(Date.now() + 60000) } });
    await service.players.updateOne({ _id: steamId }, { $set: { discordid: '123456789012345679' } });
    assert.equal(await resolveDiscordSupportLink(db, token, from.id), null);
    await service.players.updateOne({ _id: steamId }, { $set: { discordid: discordId } });
    assert.equal((await service.players.findOne({ _id: steamId })).telegramid, undefined);
    // Continue the actual deep-link flow through payment and VIP delivery.
    await handlers.get('message')({ from, chat, text: '420' });
    const confirm = messages.at(-1);
    assert.match(confirm[1], /76561198000000002/);
    assert.match(confirm[1], /420 ⭐/);
    assert.doesNotMatch(confirm[1], /VIP|дн|280/);
    await handlers.get('callback_query')({ from, message: { chat }, data: 'stars_terms' });
    assert.match(messages.at(-1)[1], /350 ⭐/);
    const callback = confirm[2].reply_markup.inline_keyboard[0][0].callback_data;
    await handlers.get('callback_query')({ from: { id: 999 }, message: { chat }, data: callback });
    assert.equal(invoices.length, 0);
    await handlers.get('callback_query')({ from, message: { chat }, data: callback });
    const invoice = invoices[0];
    assert.equal(invoice[4], '');
    assert.equal(invoice[5], 'XTR');
    assert.equal(invoice[6][0].amount, 420);
    assert.equal(invoice[7].start_parameter, 'stars_vip');
    const payment = { invoice_payload: invoice[3], currency: 'XTR', total_amount: 420,
      telegram_payment_charge_id: 'ui-charge-1' };
    await handlers.get('pre_checkout_query')({ ...payment, id: 'checkout-1', from });
    assert.equal(checkouts.at(-1)[1], true);
    assert.equal((await service.players.findOne({ _id: '76561198000000002' })).vipEndDate, undefined);
    await handlers.get('successful_payment')({ from, chat, successful_payment: payment });
    const expiry = (await service.players.findOne({ _id: '76561198000000002' })).vipEndDate;
    const count = messages.length;
    await handlers.get('successful_payment')({ from, chat, successful_payment: payment });
    assert.equal(messages.length, count);
    assert.deepEqual((await service.players.findOne({ _id: '76561198000000002' })).vipEndDate, expiry);
    assert.match(messages.at(-1)[1], /добавлено 45 дн/);
  } finally {
    await db.dropDatabase();
    await client.close();
  }
});
