/**
 * Office users store — Vercel Blob-backed.
 *
 * Voor kantoor-gebruikers / externen die GEEN SRS kassa-login hebben maar
 * wel toegang nodig hebben tot delen van de admin portal (finance, marketing,
 * support enz.).
 *
 * Login-flow voor deze users: ADMIN_PIN + email-match (in plaats van
 * personeelsnummer + posLoginCode).
 *
 * Storage:
 *   admin/office-users.json = {
 *     [userId]: {
 *       userId: 'office-{slug}',          // unique key
 *       name: 'Volledige naam',
 *       email: 'iemand@gents.nl',         // primary identifier voor login
 *       phone: '',
 *       department: 'Finance',
 *       active: true,
 *       createdAt: ISO,
 *       updatedAt: ISO,
 *       createdBy: 'admin'
 *     }
 *   }
 */

import { put, list } from '@vercel/blob';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const STORE_PATH = 'admin/office-users.json';
let __CACHE__ = null;
let __CACHE_AT__ = 0;
const CACHE_TTL_MS = 30 * 1000;

const scryptAsync = promisify(scrypt);
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; /* 7 dagen */

async function readBlobText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Blob read mislukt: ${response.status}`);
  return response.text();
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/@/g, '-at-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function makeOfficeUserId(email) {
  const slug = slugify(email);
  return `office-${slug || 'unknown'}`;
}

export async function getAllOfficeUsers({ refresh = false } = {}) {
  if (!refresh && __CACHE__ && (Date.now() - __CACHE_AT__) < CACHE_TTL_MS) {
    return __CACHE__;
  }
  try {
    const result = await list({ prefix: STORE_PATH, limit: 1 });
    const blob = result.blobs.find((b) => b.pathname === STORE_PATH);
    if (!blob) { __CACHE__ = {}; __CACHE_AT__ = Date.now(); return __CACHE__; }
    const raw = await readBlobText(blob.url);
    __CACHE__ = JSON.parse(raw || '{}') || {};
    __CACHE_AT__ = Date.now();
    return __CACHE__;
  } catch (error) {
    console.error('[office-users-store]', error);
    return __CACHE__ || {};
  }
}

async function writeAll(data) {
  await put(STORE_PATH, JSON.stringify(data, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
  __CACHE__ = data; __CACHE_AT__ = Date.now();
}

export async function upsertOfficeUser(input = {}, createdBy = 'admin') {
  const email = String(input.email || '').trim().toLowerCase();
  if (!email) throw new Error('email is verplicht voor een kantoor-gebruiker');
  if (!input.name) throw new Error('name is verplicht');

  const userId = input.userId || makeOfficeUserId(email);
  const all = await getAllOfficeUsers({ refresh: true });
  const existing = all[userId] || {};

  const now = new Date().toISOString();
  const updated = {
    userId,
    name: String(input.name).trim(),
    email,
    phone: input.phone ?? existing.phone ?? '',
    department: input.department ?? existing.department ?? '',
    active: input.active !== undefined ? Boolean(input.active) : (existing.active !== undefined ? existing.active : true),
    createdAt: existing.createdAt || now,
    updatedAt: now,
    createdBy: existing.createdBy || String(createdBy || 'admin')
  };
  all[userId] = updated;
  await writeAll(all);
  return updated;
}

export async function deleteOfficeUser(userId) {
  if (!userId) return false;
  const all = await getAllOfficeUsers({ refresh: true });
  if (!(userId in all)) return false;
  delete all[userId];
  await writeAll(all);
  return true;
}

export async function findOfficeUserByEmail(email) {
  if (!email) return null;
  const clean = String(email).toLowerCase().trim();
  const all = await getAllOfficeUsers();
  return Object.values(all).find((u) => String(u.email || '').toLowerCase() === clean) || null;
}

/* ─── Password + invite token support ────────────────────────────── */

/** Hash een wachtwoord met scrypt + salt. Format: 'salt:hash' (hex). */
export async function hashPassword(password) {
  if (!password || password.length < 8) throw new Error('Wachtwoord moet minimaal 8 tekens zijn.');
  const salt = randomBytes(16);
  const derived = await scryptAsync(String(password), salt, 64);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

/** Verifieer wachtwoord tegen opgeslagen hash. */
export async function verifyPassword(password, storedHash) {
  if (!password || !storedHash || !storedHash.includes(':')) return false;
  try {
    const [saltHex, hashHex] = storedHash.split(':');
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const derived = await scryptAsync(String(password), salt, expected.length);
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** Genereer een veilige invite-token (32 bytes hex = 64 chars). */
export function generateInviteToken() {
  return randomBytes(32).toString('hex');
}

/** Stel een invite-token in voor de gegeven user. Returnt {userId, token, expiresAt}. */
export async function setInviteTokenForUser(userIdOrEmail) {
  const all = await getAllOfficeUsers({ refresh: true });
  let user = all[userIdOrEmail];
  if (!user) {
    /* Probeer ook email-lookup */
    user = Object.values(all).find((u) => String(u.email || '').toLowerCase() === String(userIdOrEmail || '').toLowerCase());
  }
  if (!user) throw new Error('Gebruiker niet gevonden.');
  const token = generateInviteToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  user.inviteToken = token;
  user.inviteTokenExpiresAt = expiresAt;
  user.inviteSentAt = new Date().toISOString();
  user.updatedAt = new Date().toISOString();
  all[user.userId] = user;
  await writeAll(all);
  return { userId: user.userId, email: user.email, name: user.name, token, expiresAt };
}

/** Vind een user op basis van invite-token. Returnt null als ongeldig/verlopen. */
export async function findUserByInviteToken(token) {
  const t = String(token || '').trim();
  if (!t || t.length < 32) return null;
  const all = await getAllOfficeUsers({ refresh: true });
  const user = Object.values(all).find((u) => u.inviteToken === t);
  if (!user) return null;
  if (user.inviteTokenExpiresAt && new Date(user.inviteTokenExpiresAt).getTime() < Date.now()) return null;
  return user;
}

/** Zet wachtwoord voor user — clear invite-token na succes. */
export async function setUserPassword(userId, newPassword) {
  const all = await getAllOfficeUsers({ refresh: true });
  const user = all[userId];
  if (!user) throw new Error('Gebruiker niet gevonden.');
  const hash = await hashPassword(newPassword);
  user.passwordHash = hash;
  user.passwordSetAt = new Date().toISOString();
  user.inviteToken = null;
  user.inviteTokenExpiresAt = null;
  user.updatedAt = new Date().toISOString();
  all[userId] = user;
  await writeAll(all);
  return user;
}

/** Login: zoek user op email + verifieer password. Returnt user of null. */
export async function authenticateOfficeUser(email, password) {
  const user = await findOfficeUserByEmail(email);
  if (!user || !user.passwordHash) return null;
  if (user.active === false) return null;
  const ok = await verifyPassword(password, user.passwordHash);
  return ok ? user : null;
}

/* ─── 2FA (email-based 6-digit code) ─────────────────────────────── */

const TWO_FA_TTL_MS = 5 * 60 * 1000; /* 5 min */
const TWO_FA_MAX_ATTEMPTS = 5;

/** Genereer 6-cijferige code als string '123456'. */
export function generate2FACode() {
  /* randomBytes voor cryptographically secure */
  const n = randomBytes(4).readUInt32BE(0);
  return String(n % 1000000).padStart(6, '0');
}

/** Hash 2FA-code voor opslag — sha256 is voldoende voor kort-lopende codes. */
async function hash2FACode(code) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(String(code)).digest('hex');
}

/**
 * Stel een 2FA-code in voor de gegeven user. Returnt {code, expiresAt}.
 * De caller verstuurt de code via mail.
 */
export async function setTwoFactorCodeForUser(userId) {
  const all = await getAllOfficeUsers({ refresh: true });
  const user = all[userId];
  if (!user) throw new Error('Gebruiker niet gevonden.');
  const code = generate2FACode();
  const hash = await hash2FACode(code);
  const expiresAt = new Date(Date.now() + TWO_FA_TTL_MS).toISOString();
  user.twoFactorCodeHash = hash;
  user.twoFactorCodeExpiresAt = expiresAt;
  user.twoFactorAttempts = 0;
  user.twoFactorSentAt = new Date().toISOString();
  all[userId] = user;
  await writeAll(all);
  return { code, expiresAt };
}

/**
 * Verifieer 2FA-code. Returnt user object bij succes, of null + reason.
 * Houdt attempts bij en invalideert na MAX failed attempts.
 */
export async function verifyTwoFactorCode(userId, code) {
  const all = await getAllOfficeUsers({ refresh: true });
  const user = all[userId];
  if (!user) return { ok: false, reason: 'user-not-found' };
  if (!user.twoFactorCodeHash) return { ok: false, reason: 'no-code-active' };
  if (user.twoFactorCodeExpiresAt && new Date(user.twoFactorCodeExpiresAt).getTime() < Date.now()) {
    /* Verlopen → clear */
    user.twoFactorCodeHash = null;
    user.twoFactorCodeExpiresAt = null;
    user.twoFactorAttempts = 0;
    all[userId] = user;
    await writeAll(all);
    return { ok: false, reason: 'expired' };
  }
  const attempts = Number(user.twoFactorAttempts || 0);
  if (attempts >= TWO_FA_MAX_ATTEMPTS) {
    user.twoFactorCodeHash = null;
    user.twoFactorCodeExpiresAt = null;
    user.twoFactorAttempts = 0;
    all[userId] = user;
    await writeAll(all);
    return { ok: false, reason: 'too-many-attempts' };
  }
  const expectedHash = await hash2FACode(code);
  const ok = expectedHash === user.twoFactorCodeHash;
  if (!ok) {
    user.twoFactorAttempts = attempts + 1;
    all[userId] = user;
    await writeAll(all);
    return {
      ok: false,
      reason: 'invalid-code',
      attemptsRemaining: TWO_FA_MAX_ATTEMPTS - user.twoFactorAttempts
    };
  }
  /* Succes: clear code (one-shot) */
  user.twoFactorCodeHash = null;
  user.twoFactorCodeExpiresAt = null;
  user.twoFactorAttempts = 0;
  user.twoFactorLastVerifiedAt = new Date().toISOString();
  all[userId] = user;
  await writeAll(all);
  return { ok: true, user };
}

/** Check of 2FA enabled is voor user (default: true voor office-users). */
export function isTwoFactorEnabled(user) {
  if (!user) return false;
  /* Default aan tenzij expliciet uit */
  return user.twoFactorEnabled !== false;
}
