import fs from "fs";
import { exec } from "child_process";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

const ADMINS_CFG_PATH = process.env.ADMINS_CFG_PATH || "./Admins.cfg";
const ADMINS_CFG_BACKUPS = process.env.ADMINS_CFG_BACKUPS || "./backups";
const SYNC_CONFIG_PATH = process.env.SYNC_CONFIG_PATH || "";

const getUserRegExp = (steamID) =>
  new RegExp(
    `Admin=${steamID}:Reserved [//]* DiscordID (?<discordId>[0-9]*) do (?<date>[0-9]{2}\\.[0-9]{2}\\.[0-9]{4})`
  );

function addDaysToDate(startDate, days) {
  const d = new Date(startDate);
  d.setDate(d.getDate() + days);
  return d;
}

function formatDateRu(dateObj) {
  const dd = String(dateObj.getDate()).padStart(2, "0");
  const mm = String(dateObj.getMonth() + 1).padStart(2, "0");
  const yyyy = dateObj.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

const vipCreater = async (steamID, nickname, days, telegramId) => {
  const discordId = telegramId;
  let data;
  try {
    data = fs.readFileSync(ADMINS_CFG_PATH, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") data = "";
    else throw err;
  }
  if (!data.match(/\r\n/gm)) data = data.replace(/\n/gm, "\r\n");

  let updated = false;
  let nData = data
    .split("\r\n")
    .map((line) => {
      const match = line.match(getUserRegExp(steamID));
      if (match && match.groups) {
        // продлеваем VIP (к существующей дате добавляем days)
        updated = true;
        let oldDateStr = match.groups.date; // dd.mm.yyyy
        let [dd, mm, yyyy] = oldDateStr.split(".");
        let oldDate = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
        const now = new Date();
        let baseDate = oldDate > now ? oldDate : now;
        let newDate = addDaysToDate(baseDate, days);
        return `Admin=${steamID}:Reserved // DiscordID ${discordId} do ${formatDateRu(
          newDate
        )}`;
      }
      return line;
    })
    .filter((e) => e.length > 0);

  if (!updated) {
    // если записи не было — даём +days от сегодня
    let baseDate = addDaysToDate(new Date(), days);
    nData.push(
      `Admin=${steamID}:Reserved // DiscordID ${discordId} do ${formatDateRu(
        baseDate
      )}`
    );
  }
  const newData = nData.join("\r\n") + "\r\n";
  fs.writeFileSync(ADMINS_CFG_PATH, newData);

  // backup
  const backupName = `AdminsBackup${new Date()
    .toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })
    .replace(/[: ]/g, "_")}.cfg`;
  const backupPath = path.join(ADMINS_CFG_BACKUPS, backupName);
  fs.writeFileSync(backupPath, data);

  if (SYNC_CONFIG_PATH) {
    exec(`${SYNC_CONFIG_PATH}syncconfig.sh`, (err, stdout, stderr) => {
      if (err) console.error("[vipCreater] Ошибка syncconfig.sh:", err);
      else console.log("[vipCreater] syncconfig.sh stdout:", stdout);
    });
  }

  console.log(
    `[vipCreater] User ${nickname} (${steamID}) продлён/добавлен до актуальной даты`
  );
};

export default vipCreater;
