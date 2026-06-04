/**
 * POST /api/me/confirm-risky
 *
 * Her-bevestiging-endpoint voor risicovolle handelingen. Het frontend roept dit
 * aan VOORDAT de feitelijke risicovolle endpoint aangeroepen wordt:
 *
 *   1. UI: gebruiker klikt "Voucher uitgeven (€ 250)" → POST /api/me/confirm-risky
 *      met { actionKey: 'voucher.generate-above', payload: { amount: 250 }, kassacode }
 *   2. Server checkt: is dit risky? actieve shift? kassacode-match?
 *   3. Server geeft een **confirm-token** terug (60s geldig).
 *   4. UI roept de echte voucher-endpoint aan met header `x-confirm-token`.
 *   5. Voucher-endpoint verifieert token via lib/confirm-token-store.js.
 *
 * Body: { actionKey, kassacode, payload?: object, store? }
 */

import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { resolveAccess } from '../../lib/access-check.js';
import { getActiveShift } from '../../lib/shift-session-store.js';
import { findPersonnelForLogin } from '../../lib/srs-personnel-client.js';
import { isRiskyAction } from '../../lib/risky-actions-config.js';
import { issueConfirmToken } from '../../lib/confirm-token-store.js';

export const maxDuration = 20;

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
    const actionKey = String(body.actionKey || '').trim();
    const kassacode = String(body.kassacode || body.pin || '').trim();
    const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};

    if (!actionKey) return res.status(400).json({ success: false, message: 'actionKey verplicht.' });
    if (!kassacode) return res.status(400).json({ success: false, message: 'Kassacode verplicht.' });

    /* Check of de actie überhaupt risky is */
    const risk = await isRiskyAction(actionKey, payload);
    if (!risk.risky) {
      return res.status(200).json({
        success: true,
        risky: false,
        reason: risk.reason,
        message: 'Geen extra bevestiging nodig — handeling valt onder normale shift-autorisatie.'
      });
    }

    /* IP + actieve shift */
    const access = await resolveAccess(req);
    if (!access.ip) return res.status(400).json({ success: false, message: 'Geen IP.' });
    const store = String(body.store || access.matchedStore || '').trim();
    if (!store) return res.status(400).json({ success: false, message: 'Geen winkel-context.' });

    const shift = await getActiveShift({ ip: access.ip, store });
    if (!shift) {
      return res.status(401).json({
        success: false,
        code: 'no-active-shift',
        message: 'Geen actieve shift — start eerst je werkdag (kies medewerker + kassacode).'
      });
    }

    /* Kassacode opnieuw verifiëren tegen DE personeelnr van de actieve shift —
       geen "andere collega keurt het goed" toestaan zonder expliciete switch. */
    const verified = await findPersonnelForLogin({
      personnelId: shift.personnelId,
      posLoginCode: kassacode
    });
    if (!verified || String(verified.personnelId) !== String(shift.personnelId)) {
      return res.status(401).json({
        success: false,
        code: 'bad-kassacode',
        message: 'Kassacode klopt niet bij de actieve medewerker.'
      });
    }

    /* Geef confirm-token uit */
    const ttl = risk.ttl || 60;
    const token = issueConfirmToken({
      actionKey,
      shiftId: shift.id,
      personnelId: shift.personnelId,
      ttlSeconds: ttl
    });

    return res.status(200).json({
      success: true,
      risky: true,
      confirmToken: token,
      ttlSeconds: ttl,
      actor: { personnelId: shift.personnelId, personnelName: shift.personnelName }
    });
  } catch (e) {
    console.error('[me/confirm-risky]', e);
    return res.status(500).json({ success: false, message: e.message || 'Bevestiging mislukt.' });
  }
}
