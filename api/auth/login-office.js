import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import {
  authenticateOfficeUser,
  setTwoFactorCodeForUser,
  isTwoFactorEnabled
} from '../../lib/office-users-store.js';
import { getUserPermissions } from '../../lib/user-permissions-store.js';
import { resolveAfdelingForDepartment } from '../../lib/department-afdeling-map.js';
import { appendAuditEntry } from '../../lib/permissions-audit-store.js';
import { sendMail, baseMailHtml } from '../../lib/gents-mailer.js';

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

    /* 2FA flow: als enabled → genereer code + mail, return requires2FA */
    if (isTwoFactorEnabled(user)) {
      const { code, expiresAt } = await setTwoFactorCodeForUser(user.userId);
      let mailWarning = null;
      try {
        await sendMail({
          to: user.email,
          subject: `GENTS Portaal — 2FA code: ${code}`,
          html: baseMailHtml({
            title: 'Verifieer je login',
            intro: `Hallo ${user.name || ''}, vul deze code in om in te loggen op het GENTS Portaal.`,
            bodyHtml: `
              <div style="text-align:center;padding:24px;background:#f5f5f2;border-radius:12px;margin-bottom:18px">
                <div style="font-size:11px;color:#3a4a5a;letter-spacing:.18em;font-weight:700;text-transform:uppercase;margin-bottom:8px">Jouw verificatie-code</div>
                <div style="font-size:48px;font-weight:700;letter-spacing:.16em;color:#0a1f33;font-family:'SF Mono',Menlo,monospace">${code}</div>
                <div style="margin-top:10px;font-size:12px;color:#3a4a5a">Geldig tot ${new Date(expiresAt).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}</div>
              </div>
              <p style="margin:0;font-size:13px;color:#3a4a5a;line-height:1.55">Heb jij niet zojuist geprobeerd in te loggen? Negeer deze mail en wijzig direct je wachtwoord via je beheerder.</p>
            `,
            footer: 'Code is 5 minuten geldig. Max 5 pogingen.'
          })
        });
      } catch (mailErr) {
        console.warn('[login-office] 2FA mail send failed:', mailErr.message);
        mailWarning = mailErr.message;
      }

      await appendAuditEntry({
        actor: user.userId,
        action: 'login-office-2fa-sent',
        targetUserId: user.userId,
        targetName: user.name,
        note: '2FA-code verstuurd na succesvolle password-verify',
        request: req
      }).catch(() => {});

      return res.status(200).json({
        success: true,
        requires2FA: true,
        userId: user.userId,
        emailMasked: maskEmail(user.email),
        message: mailWarning
          ? `Code kon niet gemaild worden: ${mailWarning}. Vraag admin om hulp.`
          : `We hebben een 6-cijferige code gestuurd naar ${maskEmail(user.email)}. Vul deze in.`
      });
    }

    /* Geen 2FA: direct doorlaten (alleen voor admins die 't expliciet hebben uitgezet) */
    await appendAuditEntry({
      actor: user.userId,
      action: 'login-office',
      targetUserId: user.userId,
      targetName: user.name,
      note: 'Login via email+password (2FA uit)',
      request: req
    }).catch(() => {});

    /* Lees user-permissions voor allowedStoresOverride + bepaal defaultAfdeling */
    const perm = await getUserPermissions(user.userId).catch(() => null);
    const allowedStores = Array.isArray(perm?.allowedStoresOverride) ? perm.allowedStoresOverride : [];
    const department = perm?.department || user.department || '';
    const defaultAfdeling = resolveAfdelingForDepartment(department);

    return res.status(200).json({
      success: true,
      requires2FA: false,
      user: {
        userId: user.userId,
        name: user.name,
        email: user.email,
        department,
        active: user.active !== false,
        allowedStores,
        defaultAfdeling, /* bv. 'Supplychain' bij department='Logistiek / magazijn' */
        role: perm?.role || 'office'
      }
    });
  } catch (error) {
    console.error('[auth/login-office] error:', error);
    return res.status(500).json({ success: false, message: 'Login mislukt.' });
  }
}

function maskEmail(email) {
  const e = String(email || '');
  const [local, domain] = e.split('@');
  if (!local || !domain) return e;
  const visible = local.slice(0, 2);
  const masked = '*'.repeat(Math.max(0, local.length - 2));
  return `${visible}${masked}@${domain}`;
}
