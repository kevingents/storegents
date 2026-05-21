import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { getAuditLog } from '../../lib/permissions-audit-store.js';

/**
 * GET /api/admin/login-history?userId=X&limit=100
 *
 * Returnt login-gerelateerde audit-entries:
 *   - login-office (success zonder 2FA)
 *   - login-office-2fa-sent (na password OK, mail verstuurd)
 *   - login-office-2fa-success (na code OK, fully logged in)
 *   - login-office-2fa-failed (verkeerde code)
 *   - login-pin (admin-pincode)
 *   - login-personnel (SRS kassacode)
 *   - set-password (wachtwoord ingesteld via invite)
 *   - send-invite / resend-invite (invite verstuurd)
 *
 * Optioneel filteren op userId. Default: alle login events.
 */

const LOGIN_ACTIONS = new Set([
  'login-office',
  'login-office-2fa-sent',
  'login-office-2fa-success',
  'login-office-2fa-failed',
  'login-pin',
  'login-personnel',
  'set-password',
  'send-invite',
  'resend-invite'
]);

function clean(v) { return String(v || '').trim(); }

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (requireAdmin(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });

  const userId = clean(req.query.userId);
  const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));

  try {
    const all = await getAuditLog({ limit: 1000 });
    let entries = (all || []).filter((e) => LOGIN_ACTIONS.has(e.action));
    if (userId) {
      const targetLow = userId.toLowerCase();
      entries = entries.filter((e) =>
        String(e.targetUserId || '').toLowerCase() === targetLow ||
        String(e.actor || '').toLowerCase() === targetLow
      );
    }
    entries = entries.slice(0, limit);

    /* Tellingen per actie voor stats */
    const counts = {};
    for (const e of entries) counts[e.action] = (counts[e.action] || 0) + 1;

    /* Recente unique IPs per user (max 5 voor security-overzicht) */
    const ipsByUser = new Map();
    for (const e of entries) {
      const uid = e.targetUserId || e.actor;
      if (!uid || !e.meta?.ip) continue;
      const set = ipsByUser.get(uid) || new Set();
      set.add(e.meta.ip);
      ipsByUser.set(uid, set);
    }

    return res.status(200).json({
      success: true,
      userId: userId || null,
      total: entries.length,
      counts,
      uniqueIpsByUser: Object.fromEntries(
        Array.from(ipsByUser.entries()).map(([uid, set]) => [uid, Array.from(set).slice(0, 5)])
      ),
      entries
    });
  } catch (error) {
    console.error('[admin/login-history]', error);
    return res.status(500).json({ success: false, message: error.message || 'Login-history kon niet worden opgehaald.' });
  }
}
