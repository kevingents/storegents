/**
 * POST /api/admin/bol-srs-repush
 *
 * Plaats één specifieke bol-order opnieuw naar SRS — handmatig vanuit de console
 * of een knop. Handig als een order de cron-push miste (bv. BOL-0008).
 *
 * Body (JSON):
 *   {
 *     srsOrderId?: "BOL-0008",   // SRS-nummer; wordt via teller-history omgezet
 *     bolOrderId?: "C00...",     // óf direct de bol-marketplace-id
 *     dryRun?: true,             // alleen XML opbouwen, niets naar SRS sturen (preview)
 *     force?: false              // ook pushen als de order al gepusht is
 *   }
 *
 * Veiligheid:
 *   - Zonder force: als de order al gepusht is, krijg je terug ONDER WELK
 *     SRS-nummer — zo zie je dat 'ie niet echt mist en maak je geen duplicaat.
 *   - force=true maakt een DUBBELE order in SRS als de order al bestaat — alleen
 *     gebruiken als je 100% zeker weet dat de order ontbreekt.
 *   - dryRun forceert intern de preview (bouwt de XML, ongeacht pushed-state).
 *
 * Auth: admin-token (header x-admin-token).
 */

import { corsJson, requireAdmin } from '../../lib/request-guards.js';
import { pushBolOrdersToSrs, readBolSrsPushedState } from '../../lib/bol-srs-push.js';
import { readBolOrderCounter } from '../../lib/bol-order-counter.js';

export const maxDuration = 60;

const clean = (v) => String(v == null ? '' : v).trim();
const truthy = (v) => v === true || v === 1 || ['1', 'true', 'yes', 'ja'].includes(String(v).toLowerCase());

export default async function handler(req, res) {
  if (corsJson(req, res, ['POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  try {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const dryRun = truthy(body.dryRun);
    const force = truthy(body.force);
    const srsOrderId = clean(body.srsOrderId);
    let bolOrderId = clean(body.bolOrderId);

    /* BOL-NNNN → bol-marketplace-id via de teller-history. */
    if (!bolOrderId && srsOrderId) {
      const counter = await readBolOrderCounter().catch(() => ({ history: [] }));
      const hit = (counter.history || []).find((h) => clean(h.orderId).toUpperCase() === srsOrderId.toUpperCase());
      if (!hit || !clean(hit.bolOrderId)) {
        return res.status(404).json({
          success: false,
          message: `Geen bol-marketplace-id gevonden voor ${srsOrderId} in de teller-history. Geef bolOrderId direct mee (zie de bol-order in het bol-dashboard).`
        });
      }
      bolOrderId = clean(hit.bolOrderId);
    }

    if (!bolOrderId) {
      return res.status(400).json({ success: false, message: 'Geef srsOrderId (BOL-NNNN) of bolOrderId mee.' });
    }

    /* Al gepusht? Meld onder welk nummer — zo zie je of de order echt mist. */
    const pushedState = await readBolSrsPushedState().catch(() => ({ pushed: {} }));
    const already = (pushedState.pushed || {})[bolOrderId];
    if (already && !force && !dryRun) {
      return res.status(200).json({
        success: true,
        skipped: true,
        bolOrderId,
        requestedSrsOrderId: srsOrderId || null,
        alreadyPushedAs: already.srsOrderId || null,
        message: `Deze bol-order staat al in SRS als ${already.srsOrderId || '(onbekend nummer)'} — hij mist dus niet. Gebruik force=true alleen als je 'm bewust dubbel wilt aanmaken.`
      });
    }

    /* dryRun → altijd preview (force intern zodat de XML wordt opgebouwd, ook als
       de order al gepusht is). Echte push gebruikt de force van de gebruiker. */
    const result = await pushBolOrdersToSrs({
      onlyBolOrderId: bolOrderId,
      force: force || dryRun,
      maxPerRun: 1,
      dryRun
    });

    /* Order niet in de bol-orders-cache (mogelijk te oud)? */
    if (result?.summary && result.summary.processed === 0) {
      return res.status(200).json({
        success: true,
        bolOrderId,
        requestedSrsOrderId: srsOrderId || null,
        notInCache: true,
        message: 'Deze order zit niet (meer) in de bol-orders-cache. Draai eerst /api/cron/bol-orders en probeer opnieuw.',
        result
      });
    }

    return res.status(200).json({ success: true, bolOrderId, requestedSrsOrderId: srsOrderId || null, dryRun, force, result });
  } catch (e) {
    console.error('[admin/bol-srs-repush]', e);
    return res.status(500).json({ success: false, message: e.message || 'Repush mislukt.' });
  }
}
