/**
 * lib/confirm-token-store.js
 *
 * Korte-lijn tokens voor "ik bevestig met mijn kassacode dat ik handeling X mag
 * uitvoeren". Token leeft typisch 60 seconden, is gebonden aan 1 actie-key, 1
 * shift-id, en 1 actor.
 *
 * Opslag: in-memory map (per Vercel-instance). Voor cross-instance consistency
 * gebruiken we ook een blob-cache, maar primair pad is memory voor snelheid.
 *
 * Token = HMAC van { actionKey, shiftId, personnelId, exp } met session-secret.
 * Stateless verificatie = geen extra blob-roundtrip nodig.
 */

import crypto from 'crypto';

function secret() {
  const s = process.env.CONFIRM_TOKEN_SECRET
    || process.env.PERSONNEL_SESSION_SECRET
    || process.env.SRS_PERSONNEL_SECRET
    || '';
  if (!s) throw new Error('CONFIRM_TOKEN_SECRET / PERSONNEL_SESSION_SECRET ontbreekt.');
  return s;
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function issueConfirmToken({ actionKey, shiftId, personnelId, ttlSeconds = 60 }) {
  if (!actionKey) throw new Error('actionKey verplicht.');
  if (!shiftId) throw new Error('shiftId verplicht.');
  if (!personnelId) throw new Error('personnelId verplicht.');
  const exp = Math.floor(Date.now() / 1000) + Math.max(15, Number(ttlSeconds) || 60);
  const payload = JSON.stringify({ a: actionKey, s: shiftId, p: personnelId, e: exp });
  const encoded = Buffer.from(payload).toString('base64url');
  const sig = sign(encoded);
  return `${encoded}.${sig}`;
}

export function verifyConfirmToken(token, { actionKey, shiftId, personnelId } = {}) {
  if (!token || !token.includes('.')) return { valid: false, reason: 'malformed' };
  const [encoded, sig] = String(token).split('.');
  const expected = sign(encoded);
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { valid: false, reason: 'bad-signature' };
  } catch {
    return { valid: false, reason: 'bad-signature' };
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return { valid: false, reason: 'bad-payload' };
  }
  if (Number(payload.e || 0) < Math.floor(Date.now() / 1000)) return { valid: false, reason: 'expired' };
  if (actionKey && payload.a !== actionKey) return { valid: false, reason: 'action-mismatch' };
  if (shiftId && payload.s !== shiftId) return { valid: false, reason: 'shift-mismatch' };
  if (personnelId && payload.p !== String(personnelId)) return { valid: false, reason: 'personnel-mismatch' };
  return { valid: true, actionKey: payload.a, shiftId: payload.s, personnelId: payload.p, expiresAt: payload.e };
}
