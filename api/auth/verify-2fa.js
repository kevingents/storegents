import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { verifyTwoFactorCode } from '../../lib/office-users-store.js';
import { getUserPermissions } from '../../lib/user-permissions-store.js';
import { resolveAfdelingForDepartment } from '../../lib/department-afdeling-map.js';
import { appendAuditEntry } from '../../lib/permissions-audit-store.js';

/**
 * POST /api/auth/verify-2fa
 *
 * Body: { userId, code }
 *
 * Verifieert de 6-cijferige 2FA-code die via login-office is gemaild.
 * - Bij succes: returnt full user-object (login complete)
 * - Bij faal: clear error + attemptsRemaining
 * - Bij verlopen / te veel pogingen: 401 + reden, user moet opnieuw inloggen
 *
 * Geen admin-token nodig — auth via { userId + verse code }.
 */

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

function clean(v) { return String(v || '').trim(); }

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST.' });

  const body = parseBody(req);
  const userId = clean(body.userId);
  const code = clean(body.code).replace(/[^0-9]/g, '');

  if (!userId || !code) return res.status(400).json({ success: false, message: 'userId en code zijn verplicht.' });
  if (code.length !== 6) return res.status(400).json({ success: false, message: 'Code moet 6 cijfers zijn.' });

  try {
    const result = await verifyTwoFactorCode(userId, code);

    if (!result.ok) {
      const reasonMessages = {
        'user-not-found': 'Gebruiker niet gevonden.',
        'no-code-active': 'Geen actieve code. Log opnieuw in om een nieuwe code te ontvangen.',
        'expired': 'Code is verlopen (5 min). Log opnieuw in voor een nieuwe code.',
        'too-many-attempts': 'Te veel verkeerde pogingen. Log opnieuw in voor een nieuwe code.',
        'invalid-code': `Onjuiste code. Nog ${result.attemptsRemaining ?? 0} ${result.attemptsRemaining === 1 ? 'poging' : 'pogingen'} over.`
      };
      await appendAuditEntry({
        actor: userId,
        action: 'login-office-2fa-failed',
        targetUserId: userId,
        targetName: '',
        note: `2FA verify faalde: ${result.reason}`,
        request: req
      }).catch(() => {});
      return res.status(401).json({
        success: false,
        reason: result.reason,
        attemptsRemaining: result.attemptsRemaining,
        message: reasonMessages[result.reason] || 'Verificatie mislukt.'
      });
    }

    const user = result.user;
    await appendAuditEntry({
      actor: user.userId,
      action: 'login-office-2fa-success',
      targetUserId: user.userId,
      targetName: user.name,
      note: 'Login compleet met 2FA',
      request: req
    }).catch(() => {});

    /* Lees user-permissions + bepaal defaultAfdeling. Expliciet afdeling-veld
       wint van department-name mapping. */
    const perm = await getUserPermissions(user.userId).catch(() => null);
    const allowedStores = Array.isArray(perm?.allowedStoresOverride) ? perm.allowedStoresOverride : [];
    const department = perm?.department || user.department || '';
    const defaultAfdeling = clean(perm?.afdeling) || resolveAfdelingForDepartment(department) || '';
    const groups = Array.isArray(perm?.groups) ? perm.groups : [];

    return res.status(200).json({
      success: true,
      user: {
        userId: user.userId,
        name: user.name,
        email: user.email,
        department,
        active: user.active !== false,
        allowedStores,
        defaultAfdeling,
        groups,
        role: perm?.role || 'office'
      }
    });
  } catch (error) {
    console.error('[auth/verify-2fa] error:', error);
    return res.status(500).json({ success: false, message: 'Verificatie mislukt.' });
  }
}
