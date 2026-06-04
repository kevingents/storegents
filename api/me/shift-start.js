/**
 * POST /api/me/shift-start
 *
 * Start een nieuwe shift-sessie voor (huidig IP, gekozen winkel). Vervangt
 * automatisch een eventuele lopende shift op dezelfde combo.
 *
 * Body: { personnelId, kassacode, store? }
 *   - personnelId: SRS personeels-ID
 *   - kassacode: posLoginCode in SRS — wordt gevalideerd door findPersonnelForLogin
 *   - store: optioneel; valt anders terug op IP-matched store
 *
 * Veiligheid:
 *   - IP moet matchen op een winkel OF op een user-whitelist (thuiswerk)
 *   - Kassacode wordt server-side bij SRS geverifieerd
 *   - Geen geldige IP-context → 403 (geen "raden" mogelijk)
 */

import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { resolveAccess } from '../../lib/access-check.js';
import { findPersonnelForLogin } from '../../lib/srs-personnel-client.js';
import { authenticateOfficeUser } from '../../lib/office-users-store.js';
import { startShift } from '../../lib/shift-session-store.js';

export const maxDuration = 20;

function clean(v) { return String(v == null ? '' : v).trim(); }

function parseBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST.' });

  try {
    const body = parseBody(req);
    /* Twee logins ondersteund:
       a) SRS-PIN: { personnelId, kassacode }     → winkelmedewerker met posLoginCode
       b) Office:  { email, password }            → kantoor/admin met emailwachtwoord
       Het frontend kiest welke flow op basis van usertype-keuze in shift-login modal. */
    const personnelId = clean(body.personnelId);
    const kassacode = clean(body.kassacode || body.pin || body.posLoginCode);
    const email = clean(body.email).toLowerCase();
    const password = String(body.password || '');
    let store = clean(body.store);

    const hasSrsCreds = Boolean(personnelId && kassacode);
    const hasOfficeCreds = Boolean(email && password);
    if (!hasSrsCreds && !hasOfficeCreds) {
      return res.status(400).json({
        success: false,
        message: 'Geef OF personnelId + kassacode, OF email + wachtwoord.'
      });
    }

    /* IP-context bepalen */
    const access = await resolveAccess(req);
    if (access.accessLevel === 'none') {
      return res.status(403).json({
        success: false,
        code: 'ip-not-allowed',
        message: 'Je IP is niet bekend. Vraag een admin om je IP te whitelisten.',
        ip: access.ip
      });
    }

    /* Default store = winkel waar IP onder valt; expliciet gevraagde store moet
       matchen met de IP-context tenzij admin (admin mag overal namens iedereen). */
    if (!store) store = access.matchedStore || '';
    if (!store) {
      return res.status(400).json({ success: false, message: 'Geen winkel-context kunnen bepalen.' });
    }
    if (access.accessLevel !== 'admin' && access.matchedStore && store !== access.matchedStore) {
      return res.status(403).json({
        success: false,
        code: 'store-ip-mismatch',
        message: `Je IP matched met ${access.matchedStore} — je kunt niet inloggen voor ${store}.`
      });
    }

    /* Pad A: SRS PIN-login */
    if (hasSrsCreds) {
      const employee = await findPersonnelForLogin({ personnelId, posLoginCode: kassacode });
      if (!employee || !employee.personnelId) {
        return res.status(401).json({ success: false, message: 'Personeelsnummer of kassacode klopt niet.' });
      }

      const empStores = Array.isArray(employee.stores) ? employee.stores : [];
      if (empStores.length && !empStores.includes(store)) {
        return res.status(403).json({
          success: false,
          code: 'personnel-store-mismatch',
          message: `Medewerker ${employee.name || personnelId} is niet gekoppeld aan winkel ${store}.`,
          employeeStores: empStores
        });
      }

      const shift = await startShift({
        ip: access.ip,
        store,
        personnelId: String(employee.personnelId),
        personnelName: employee.name || employee.externalName || employee.internalName || '',
        personnelGroupId: String(employee.personnelGroupId || ''),
        actor: 'self'
      });

      return res.status(200).json({
        success: true,
        loginType: 'srs',
        shift: {
          id: shift.id, ip: shift.ip, store: shift.store,
          personnelId: shift.personnelId,
          personnelName: employee.name || employee.externalName || personnelId,
          startedAt: shift.startedAt, expiresAt: shift.expiresAt
        }
      });
    }

    /* Pad B: Office email-login. authenticateOfficeUser returnt null bij fout. */
    const officeUser = await authenticateOfficeUser(email, password);
    if (!officeUser) {
      return res.status(401).json({ success: false, message: 'E-mail of wachtwoord klopt niet.' });
    }

    const shift = await startShift({
      ip: access.ip,
      store,
      personnelId: String(officeUser.userId || `office-${email}`),
      personnelName: officeUser.name || officeUser.fullName || officeUser.email || email,
      personnelGroupId: 'office',
      actor: 'self'
    });

    return res.status(200).json({
      success: true,
      loginType: 'office',
      shift: {
        id: shift.id, ip: shift.ip, store: shift.store,
        personnelId: shift.personnelId,
        personnelName: officeUser.name || officeUser.fullName || email,
        startedAt: shift.startedAt, expiresAt: shift.expiresAt
      }
    });
  } catch (e) {
    console.error('[me/shift-start]', e);
    return res.status(500).json({ success: false, message: e.message || 'Inloggen mislukt.' });
  }
}
