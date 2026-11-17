import { createHash } from 'node:crypto';

export async function resolveDiscordSupportLink(db, token, telegramId) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)
    || !Number.isSafeInteger(telegramId) || telegramId <= 0) return null;
  const links = db.collection('telegramSupportLinks');
  const link = await links.findOneAndUpdate({
    _id: createHash('sha256').update(token).digest('hex'), expiresAt: { $gt: new Date() },
    $or: [{ telegramId: { $exists: false } }, { telegramId: String(telegramId) }],
  }, { $set: { telegramId: String(telegramId) } },
  { returnDocument: 'after', writeConcern: { w: 'majority', j: true } });
  if (!link || !/^7656119\d{10}$/.test(link.steamId)) return null;
  // A payment link chooses a recipient; it never changes account ownership.
  // Recheck the original Discord binding in case it changed since issuance.
  const player = await db.collection('mainstats').findOne({ _id: link.steamId, discordid: link.discordId },
    { projection: { _id: 1 } });
  return player ? link.steamId : null;
}
