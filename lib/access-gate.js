/**
 * lib/access-gate.js
 *
 * Hard-blokkade voor onbekende IPs. Bedoeld als middleware-helper voor alle
 * publieke/portal-endpoints (NIET voor admin-endpoints met x-admin-token,
 * die hebben hun eigen check). Strikte modus: geen IP-match → 403.
 *
 * Bypass-paden (in volgorde):
 *   1. Admin-token in request → altijd toegestaan (admin bypasses overal)
 *   2. IP matched een winkel uit store-ip-config
 *   3. IP matched een gebruiker zijn whitelist (thuiswerk)
 *   4. Cron-requests (x-vercel-cron header) → toegestaan zonder IP-check
 *   5. Geen match → 403
 *
 * Configureerbaar via env STRICT_IP_GATE=false om tijdelijk uit te schakelen
 * (voor migratie-fase / testen).
 */

import { resolveAccess } from './access-check.js';

const STRICT_IP_GATE_DEFAULT = true;

function isStrict() {
  const v = String(process.env.STRICT_IP_GATE || '').toLowerCase().trim();
  if (v === 'false' || v === '0' || v === 'off') return false;
  if (v === 'true' || v === '1' || v === 'on') return true;
  return STRICT_IP_GATE_DEFAULT;
}

function isCronRequest(req) {
  /* Vercel zet x-vercel-cron op cron-triggers, en we gebruiken een CRON_SECRET
     elders. Daar vertrouwen we op want cron is server-naar-server. */
  if (req.headers && req.headers['x-vercel-cron']) return true;
  const auth = String(req.headers.authorization || '').trim();
  const cronSecret = process.env.CRON_SECRET || '';
  if (cronSecret && auth === `Bearer ${cronSecret}`) return true;
  return false;
}

/**
 * Middleware-style guard. Geeft `false` terug als de request OK is — caller
 * gaat verder. Geeft `true` terug als de request al beantwoord is (403/etc.) —
 * caller moet returnen.
 *
 * @returns {Promise<boolean>} true = response al verstuurd, false = ga verder
 */
export async function gateRequest(req, res, { allowWhitelistedOnly = false } = {}) {
  if (!isStrict()) return false; /* gate uit via env */

  if (isCronRequest(req)) return false;

  const access = await resolveAccess(req);

  if (access.accessLevel === 'admin') return false;
  if (access.accessLevel === 'store') return false;
  if (access.accessLevel === 'whitelist') return false;

  /* Geen toegestane access-level → blokkeer */
  res.status(403).json({
    success: false,
    code: 'ip-not-allowed',
    message: 'Je IP-adres is niet bekend bij GENTS. Vraag een admin om je IP toe te voegen aan de whitelist.',
    ip: access.ip || null,
    accessLevel: access.accessLevel,
    reason: access.reason
  });
  return true;
}

/**
 * Lichtere variant: voeg access-info aan de request toe zonder te blokkeren.
 * Voor endpoints die de info willen gebruiken zonder hard-deny.
 */
export async function attachAccessInfo(req) {
  const access = await resolveAccess(req);
  req.__access = access;
  return access;
}
