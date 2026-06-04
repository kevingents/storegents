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
    const personnelId = clean(body.personnelId);
    const kassacode = clean(body.kassacode || body.pin || body.posLoginCode);
    let store = clean(body.store);

    if (!personnelId) return res.status(400).json({ success: false, message: 'personnelId verplicht.' });
    if (!kassacode) return res.status(400).json({ success: false, message: 'Kassacode verplicht.' });

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

    /* SRS-verificatie: medewerker bestaat + kassacode klopt */
    const employee = await findPersonnelForLogin({ personnelId, posLoginCode: kassacode });
    if (!employee || !employee.personnelId) {
      return res.status(401).json({ success: false, message: 'Personeelsnummer of kassacode klopt niet.' });
    }

    /* Optioneel: check dat de medewerker daadwerkelijk aan deze winkel hangt.
       SRS-personeel.stores bevat de winkels waar zij staan ingedeeld. */
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
      shift: {
        id: shift.id,
        ip: shift.ip,
        store: shift.store,
        personnelId: shift.personnelId,
        personnelName: employee.name || employee.externalName || personnelId,
        startedAt: shift.startedAt,
        expiresAt: shift.expiresAt
      }
    });
  } catch (e) {
    console.error('[me/shift-start]', e);
    return res.status(500).json({ success: false, message: e.message || 'Inloggen mislukt.' });
  }
}
