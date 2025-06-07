import { Telegraf, Markup } from "telegraf";
import dotenv from "dotenv";
dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN_POST);

bot.command("post", async (ctx) => {
  if (ctx.from.id.toString() !== process.env.ADMIN_ID) {
    return ctx.reply("⛔ Нет доступа.");
  }

  await ctx.reply("Публикую пост...");

  await bot.telegram.sendMessage(
    process.env.CHANNEL_USERNAME,
    "👋 Добро пожаловать на Русский Народный Сервер!\n\n" +
      "Здесь вы можете:\n" +
      "— Связаться с поддержкой или администрацией через тикет-бота\n" +
      "— Оформить VIP-статус\n" +
      "— Присоединиться к общему чату для общения с участниками\n\n" +
      "Выберите нужное действие с помощью кнопок ниже 👇",
    Markup.inlineKeyboard([
      [
        Markup.button.url("📝 Открыть тикет", "https://t.me/RNSTicket_Bot"),
        Markup.button.url("⭐ Получить VIP", "https://t.me/RNSVIPBot"),
        Markup.button.url("💬 Общий чат", "https://t.me/+DE0JG05zUT42NTlk"),
      ],
    ])
  );
});

bot.launch();
console.log(
  "Бот запущен! Напиши /post в личку боту, чтобы отправить пост в канал."
);
