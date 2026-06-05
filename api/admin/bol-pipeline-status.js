/**
 * GET /api/admin/bol-pipeline-status
 *
 * Diagnose: toont per open bol-order waar 'ie in onze pipeline hangt:
 *   1. opgehaald    — staat in bol-orders cache
 *   2. naarSrs      — gepushed naar SRS (BOL-NNNN)
 *   3. label        — Sendcloud-label met reference=BOL-NNNN aanwezig
 *   4. verzonden    — DHL tracking doorgezet naar bol
 *   5. geannuleerd  — in bol-cancellations
 *
 * Per order: fase + nextAction zodat je direct ziet of het magazijn nog moet
 * picken (geen label) of dat onze sync vastloopt.
 *
 * Query:
 *   ?phase=needs-label   → alleen orders die op een Sendcloud-label wachten
 *   ?phase=needs-srs     → alleen orders nog niet in SRS
 *   ?phase=needs-ship    → label aanwezig maar nog niet verzonden naar bol
 *   ?phase=errors        → alleen orders met een geregistreerde SRS-push-fout
 *                          (incl. "geen SRS-SKU"-koppeling) + de foutreden
 */

import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { readBolOrders } from '../../lib/bol-orders.js';
import { readBolSrsPushedState } from '../../lib/bol-srs-push.js';
import { readBolShipmentsState } from '../../lib/bol-shipment-push.js';
import { readBolCancellationsState } from '../../lib/bol-cancellations-store.js';
import { getLabels } from '../../lib/sendcloud-labels-store.js';
import { readBolSrsFailures } from '../../lib/bol-srs-failures-store.js';

const clean = (v) => String(v == null ? '' : v).trim();

/* Bouw map: BOL-NNNN reference → {trackingNumber, shippingMethod}. */
function labelsByRef(labels) {
  const map = new Map();
  for (const l of (labels || [])) {
    const ref = clean(l.reference);
    if (ref && ref.toUpperCase().startsWith('BOL-') && clean(l.trackingNumber)) {
      const existing = map.get(ref);
      if (!existing || (l.createdAt && existing.createdAt && l.createdAt > existing.createdAt)) {
        map.set(ref, { trackingNumber: clean(l.trackingNumber), shippingMethod: clean(l.shippingMethod), createdAt: l.createdAt || '' });
      }
    }
  }
  return map;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (requireAdmin(req, res)) return;

  try {
    const [bolData, pushedState, shippedState, cancelState, labels, failuresState] = await Promise.all([
      readBolOrders().catch(() => null),
      readBolSrsPushedState().catch(() => ({ pushed: {} })),
      readBolShipmentsState().catch(() => ({ shipped: {} })),
      readBolCancellationsState().catch(() => ({ cancelled: {} })),
      getLabels().catch(() => []),
      readBolSrsFailures().catch(() => ({ failed: {} }))
    ]);

    const orders = Array.isArray(bolData?.orders) ? bolData.orders : [];
    const pushed = pushedState?.pushed || {};
    const shipped = shippedState?.shipped || {};
    const cancelled = cancelState?.cancelled || {};
    const failures = failuresState?.failed || {};
    const byRef = labelsByRef(labels);

    const rows = [];
    const counts = { opgehaald: 0, naarSrs: 0, label: 0, verzonden: 0, geannuleerd: 0, wachtOpLabel: 0, wachtOpSrs: 0, wachtOpShip: 0, foutBijSrs: 0 };

    for (const o of orders) {
      const bolOrderId = clean(o.orderId || o.id);
      if (!bolOrderId) continue;
      counts.opgehaald += 1;

      const isCancelled = !!cancelled[bolOrderId];
      const pushedInfo = pushed[bolOrderId];
      const srsOrderId = clean(pushedInfo?.srsOrderId);
      const hasLabel = srsOrderId ? byRef.has(srsOrderId) : false;
      const isShipped = !!shipped[bolOrderId];

      if (isCancelled) counts.geannuleerd += 1;
      if (srsOrderId) counts.naarSrs += 1;
      if (hasLabel) counts.label += 1;
      if (isShipped) counts.verzonden += 1;

      /* Bepaal fase + volgende actie. */
      let fase, nextAction;
      if (isCancelled) {
        fase = 'geannuleerd';
        nextAction = 'Geen — order is geannuleerd.';
      } else if (isShipped) {
        fase = 'verzonden';
        nextAction = 'Klaar — tracking doorgezet naar bol.';
      } else if (!srsOrderId) {
        /* Is er een geregistreerde push-fout? Dan is dit geen "nog wachten" maar
           een blokkade met reden (geen SRS-SKU, SOAP-fault, detail-fail, …). */
        const fail = failures[bolOrderId];
        if (fail) {
          fase = 'fout-bij-srs';
          nextAction = `Push geblokkeerd (${fail.attemptCount || 1}× geprobeerd): ${String(fail.error || 'onbekende fout').slice(0, 300)}`;
          counts.foutBijSrs += 1;
        } else {
          fase = 'wacht-op-srs';
          nextAction = 'bol-srs-sync moet deze nog naar SRS pushen (draait :20).';
          counts.wachtOpSrs += 1;
        }
      } else if (!hasLabel) {
        fase = 'wacht-op-label';
        nextAction = `Magazijn moet picken + Sendcloud-label printen met referentie ${srsOrderId}.`;
        counts.wachtOpLabel += 1;
      } else {
        fase = 'wacht-op-verzending';
        nextAction = 'Label gevonden — bol-shipment-sync zet tracking door (draait :40) of trigger handmatig.';
        counts.wachtOpShip += 1;
      }

      rows.push({
        bolOrderId,
        klant: clean(o.klantNaam || o.customerName || ''),
        datum: clean(o.datum || o.orderPlacedDateTime || ''),
        srsOrderId: srsOrderId || null,
        hasLabel,
        trackingNumber: hasLabel ? byRef.get(srsOrderId).trackingNumber : null,
        isShipped,
        isCancelled,
        fase,
        nextAction,
        srsFailure: failures[bolOrderId]
          ? { error: clean(failures[bolOrderId].error), attemptCount: failures[bolOrderId].attemptCount || 1, lastAttemptedAt: failures[bolOrderId].lastAttemptedAt || null }
          : null
      });
    }

    /* Sorteer: meest urgente fase eerst (wacht-op-srs > wacht-op-label > ship > verzonden). */
    const faseOrder = { 'fout-bij-srs': -1, 'wacht-op-srs': 0, 'wacht-op-label': 1, 'wacht-op-verzending': 2, 'verzonden': 3, 'geannuleerd': 4 };
    rows.sort((a, b) => (faseOrder[a.fase] - faseOrder[b.fase]) || String(a.datum).localeCompare(String(b.datum)));

    /* Optionele filter. */
    const phaseFilter = clean(req.query?.phase);
    const filterMap = { 'needs-label': 'wacht-op-label', 'needs-srs': 'wacht-op-srs', 'needs-ship': 'wacht-op-verzending', 'errors': 'fout-bij-srs' };
    const wantFase = filterMap[phaseFilter];
    const filteredRows = wantFase ? rows.filter((r) => r.fase === wantFase) : rows;

    return res.status(200).json({
      success: true,
      ordersCacheGeneratedAt: bolData?.generatedAt || bolData?.refreshedAt || null,
      counts,
      total: rows.length,
      shown: filteredRows.length,
      rows: filteredRows.slice(0, 200)
    });
  } catch (e) {
    console.error('[admin/bol-pipeline-status]', e);
    return res.status(500).json({ success: false, message: e.message || 'Pipeline-status fout.' });
  }
}
