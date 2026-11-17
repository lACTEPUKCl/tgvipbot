import { createStarsPayments, durationLabel, validSteamId } from './starsPayments.js';

const SUPPORT = 'https://discord.gg/rn-server';
const TERMS = 'VIP за Telegram Stars\n\n280 ⭐ = 30 дней. Срок пропорционален сумме, остаток времени сохраняется. Действующий VIP продлевается с даты окончания.\n\nПеред оплатой проверьте SteamID. VIP получит указанный аккаунт. После подтверждения оплаты VIP начисляется автоматически, синхронизация с серверами обычно занимает до минуты.\n\nПо вопросам оплаты и возврата используйте /paysupport. Поддержка Telegram не обслуживает покупки этого бота.';

export async function installStarsBot(bot, db, { onBegin = () => {} } = {}) {
  const payments = createStarsPayments(db);
  await payments.init();
  const waiting = new Map();
  const safe = handler => (...args) => Promise.resolve(handler(...args)).catch(error => {
    // Telegram errors can contain the bot token in request URLs. Log codes only.
    console.warn('[Stars] operation failed', error.code || error.message?.match(/^[A-Z_]+$/)?.[0] || error.name);
  });
  async function chooseAmount(chatId, steamId) {
    waiting.set(chatId, { mode: 'amount', steamId });
    await bot.sendMessage(chatId, `SteamID получателя: ${steamId}\n\n280 ⭐ = 30 дней VIP. Выберите сумму или отправьте другое целое число звёзд.`, {
      reply_markup: { inline_keyboard: [
        [280, 560, 840].map(amount => ({ text: `${amount} ⭐`, callback_data: `stars_amount:${steamId}:${amount}` })),
        [{ text: 'Другой SteamID', callback_data: 'stars_steam' }],
      ] },
    });
  }
  async function begin(msg) {
    if (msg.chat.type !== 'private' || msg.chat.id !== msg.from.id) return;
    onBegin(msg.chat.id);
    const rows = await payments.players.find({ telegramid: String(msg.from.id) }).project({ _id: 1 }).limit(2).toArray();
    if (rows.length === 1 && validSteamId(rows[0]._id)) return chooseAmount(msg.chat.id, rows[0]._id);
    waiting.set(msg.chat.id, { mode: 'steam' });
    await bot.sendMessage(msg.chat.id, 'Отправьте SteamID64 получателя VIP — 17 цифр. Перед оплатой его можно будет проверить.');
  }
  async function confirm(chatId, steamId, amount) {
    const order = await payments.createOrder(chatId, steamId, amount);
    waiting.delete(chatId);
    await bot.sendMessage(chatId, `Проверьте SteamID: ${steamId}\nСумма: ${amount} ⭐\nСрок VIP: ${durationLabel(order.durationMs)}\n\n${TERMS}`, {
      reply_markup: { inline_keyboard: [[{ text: 'Согласен с условиями · Перейти к оплате', callback_data: `stars_pay:${order._id}` }],
        [{ text: 'Изменить данные', callback_data: 'stars_vip' }]] },
    });
  }
  async function notify(order) {
    const claimed = await payments.orders.findOneAndUpdate({ _id: order._id, status: 'fulfilled',
      notifiedAt: { $exists: false }, $or: [{ notificationLease: { $exists: false } }, { notificationLease: { $lt: new Date() } }] },
    { $set: { notificationLease: new Date(Date.now() + 60000) } }, { returnDocument: 'after' });
    if (!claimed) return;
    try {
      await bot.sendMessage(Number(order.payerId),
        `Оплачено ${order.amount} ⭐. SteamID: ${order.steamId}\nДобавлено ${durationLabel(order.durationMs)} VIP.\nДействует до ${order.vipEndDate.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК. Синхронизация с серверами выполняется автоматически.`);
      await payments.orders.updateOne({ _id: order._id }, { $set: { notifiedAt: new Date() }, $unset: { notificationLease: '' } });
    } catch (error) {
      await payments.orders.updateOne({ _id: order._id }, { $unset: { notificationLease: '' } });
      throw error;
    }
  }
  bot.onText(/^\/stars(?:@\w+)?(?:\s|$)/, safe(begin));
  bot.onText(/^\/terms(?:@\w+)?(?:\s|$)/, safe(msg => bot.sendMessage(msg.chat.id, TERMS)));
  bot.onText(/^\/(?:paysupport|support)(?:@\w+)?(?:\s|$)/, safe(msg => bot.sendMessage(msg.chat.id,
    `Поддержка оплаты и возвраты: ${SUPPORT}\nСоздайте тикет и приложите квитанцию Telegram и SteamID. Поддержка Telegram не обслуживает покупки этого бота.`)));
  bot.on('callback_query', safe(async query => {
    if (query.message?.chat.type !== 'private'
      || query.message.chat.id !== query.from.id) return;
    const chatId = query.from.id;
    if (!query.data?.startsWith('stars_')) { waiting.delete(chatId); return; }
    onBegin(chatId);
    if (query.data === 'stars_vip') return begin({ chat: query.message.chat, from: query.from });
    if (query.data === 'stars_steam') {
      waiting.set(chatId, { mode: 'steam' });
      return bot.sendMessage(chatId, 'Отправьте SteamID64 получателя VIP — 17 цифр.');
    }
    if (query.data.startsWith('stars_amount:')) {
      const [, steamId, rawAmount] = query.data.split(':');
      return confirm(chatId, steamId, Number(rawAmount));
    }
    if (query.data.startsWith('stars_pay:')) {
      const order = await payments.accept(query.data.slice('stars_pay:'.length), chatId);
      if (!order) return bot.sendMessage(chatId, 'Этот счёт уже открыт или истёк. Для нового счёта нажмите /stars.');
      return bot.sendInvoice(chatId, 'VIP Русского Народного Сервера',
        `SteamID ${order.steamId}. VIP на ${durationLabel(order.durationMs)}. Действующий срок продлевается.`,
        payments.payload(order), '', 'XTR', [{ label: 'VIP', amount: order.amount }], { start_parameter: 'stars_vip' });
    }
  }));
  bot.on('message', safe(async msg => {
    if (msg.chat.type !== 'private' || msg.chat.id !== msg.from?.id || !msg.text) return;
    if (msg.text.startsWith('/')) { waiting.delete(msg.chat.id); return; }
    const state = waiting.get(msg.chat.id);
    if (!state) return;
    const text = msg.text.trim();
    if (state.mode === 'steam') {
      if (!validSteamId(text)) return bot.sendMessage(msg.chat.id, 'Нужен SteamID64 — 17 цифр, начинается с 7656119.');
      return chooseAmount(msg.chat.id, text);
    }
    if (!/^\d{1,7}$/.test(text) || Number(text) < 1 || Number(text) > 1000000) {
      return bot.sendMessage(msg.chat.id, 'Введите целое число звёзд от 1 до 1000000.');
    }
    await confirm(msg.chat.id, state.steamId, Number(text));
  }));
  bot.on('pre_checkout_query', safe(async query => {
    let ok = false;
    try { ok = await payments.checkout(query); } catch { /* Reject any mismatch. */ }
    await bot.answerPreCheckoutQuery(query.id, ok, ok ? {} : { error_message: 'Счёт истёк или данные оплаты не совпадают. Создайте новый через /stars.' });
  }));
  bot.on('successful_payment', safe(async msg => {
    const result = await payments.paid(msg.successful_payment, msg.from?.id);
    if (result) await notify(result);
  }));
  let recovering = false;
  async function recover() {
    if (recovering) return;
    recovering = true;
    try {
      await payments.retry();
      const unnotified = await payments.orders.find({ status: 'fulfilled', notifiedAt: { $exists: false } }).limit(50).toArray();
      for (const order of unnotified) await notify(order);
      // Recover successful payments even if polling acknowledged the update
      // immediately before a crash. Only our persisted invoice payloads count.
      const open = await payments.orders.find({ status: 'invoice' }).project({ _id: 1, createdAt: 1 }).sort({ createdAt: 1 }).limit(1).toArray();
      if (!open.length) return;
      const oldest = open[0].createdAt.getTime() / 1000;
      for (let offset = 0; ; offset += 100) {
        const page = await bot._request('getStarTransactions', { form: { offset, limit: 100 } });
        for (const transaction of page.transactions) {
          const source = transaction.source;
          if (source?.type !== 'user' || source.transaction_type !== 'invoice_payment'
            || !source.invoice_payload?.startsWith('rns-stars:')) continue;
          await payments.paid({ currency: 'XTR', total_amount: transaction.amount,
            invoice_payload: source.invoice_payload, telegram_payment_charge_id: transaction.id }, source.user.id);
        }
        if (page.transactions.length < 100 || page.transactions.at(-1).date < oldest) break;
      }
    } finally { recovering = false; }
  }
  await safe(recover)();
  const timer = setInterval(safe(recover), 60000);
  timer.unref();
  return payments;
}
