import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { installStarsBot } from '../utils/starsBot.js';

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
    await commands.find(row => row.regex.test('/stars')).handler({ from, chat });
    await handlers.get('message')({ from, chat, text: '76561198000000002' });
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
