import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { authenticateOfficeUser } from '../../lib/office-users-store.js';
import { appendAuditEntry } from '../../lib/permissions-audit-store.js';

/**
 * POST /api/auth/login-office
 *
 * Body: { email, password }
 *
 * Response: { success, user: { userId, name, email, department }, message }
 *
 * Geen admin-token nodig — dit is de login zelf.
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
  const email = clean(body.email).toLowerCase();
  const password = String(body.password || '');

  if (!email || !password) return res.status(400).json({ success: false, message: 'E-mail en wachtwoord zijn verplicht.' });

  try {
    const user = await authenticateOfficeUser(email, password);
    if (!user) {
      /* Generieke fout om enumeration te voorkomen */
      return res.status(401).json({ success: false, message: 'Ongeldige e-mail of wachtwoord.' });
    }

    await appendAuditEntry({
      actor: user.userId,
      action: 'login-office',
      targetUserId: user.userId,
      targetName: user.name,
      note: `Login via email+password`
    }).catch(() => {});

    return res.status(200).json({
      success: true,
      user: {
        userId: user.userId,
        name: user.name,
        email: user.email,
        department: user.department || '',
        active: user.active !== false
      }
    });
  } catch (error) {
    console.error('[auth/login-office] error:', error);
    return res.status(500).json({ success: false, message: 'Login mislukt.' });
  }
}
