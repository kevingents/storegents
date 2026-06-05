/**
 * GET /api/admin/bol-orders-history
 *
 * Volledige geschiedenis van ALLE bol-marketplace orders die door de pijplijn
 * zijn gegaan — niet alleen de openstaande (die staan op de Bestellingen-pagina,
 * en verdwijnen zodra ze verzonden zijn).
 *
 * Bron: counter-history (alle uitgegeven BOL-NNNN) + pushed/shipped/cancelled/
 * failures-state + de open-orders-cache (voor klantnaam van nog-open orders).
 *
 * Per order: srsOrderId (BOL-NNNN), bolOrderId, klant, datum, fase, tracking,
 * transporter, reden (bij fout). Plus counts per fase. Optioneel ?phase= filter.
 *
 * Auth: admin-token.
 */

import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { readBolOrderCounter } from '../../lib/bol-order-counter.js';
import { readBolSrsPushedState } from '../../lib/bol-srs-push.js';
import { readBolShipmentsState } from '../../lib/bol-shipment-push.js';
import { readBolCancellationsState } from '../../lib/bol-cancellations-store.js';
import { readBolSrsFailures } from '../../lib/bol-srs-failures-store.js';
import { readBolOrders } from '../../lib/bol-orders.js';

const clean = (v) => String(v == null ? '' : v).trim();

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (requireAdmin(req, res)) return;

  try {
    const [counter, pushedState, shippedState, cancelState, failuresState, openData] = await Promise.all([
      readBolOrderCounter().catch(() => ({ history: [] })),
      readBolSrsPushedState().catch(() => ({ pushed: {} })),
      readBolShipmentsState().catch(() => ({ shipped: {} })),
      readBolCancellationsState().catch(() => ({ cancelled: {} })),
      readBolSrsFailures().catch(() => ({ failed: {} })),
      readBolOrders().catch(() => null)
    ]);

    const pushed = pushedState?.pushed || {};
    const shipped = shippedState?.shipped || {};
    const cancelled = cancelState?.cancelled || {};
    const failures = failuresState?.failed || {};
    const history = Array.isArray(counter?.history) ? counter.history : [];
    const openOrders = Array.isArray(openData?.orders) ? openData.orders : [];

    /* Klant + datum uit de open-cache (alleen voor nog-open orders beschikbaar). */
    const openByBolId = new Map();
    for (const o of openOrders) {
      const id = clean(o.orderId || o.id);
      if (id) openByBolId.set(id, o);
    }

    /* srsOrderId + tijdstip per bolOrderId uit de teller-history (laatste wint). */
    const srsByBolId = new Map();
    const atByBolId = new Map();
    for (const h of history) {
      const id = clean(h.bolOrderId);
      if (!id) continue;
      if (clean(h.orderId)) srsByBolId.set(id, clean(h.orderId));
      if (h.at) atByBolId.set(id, h.at);
    }

    /* Master-set van alle bolOrderIds die we ooit gezien hebben. */
    const ids = new Set();
    for (const h of history) { const id = clean(h.bolOrderId); if (id) ids.add(id); }
    for (const id of Object.keys(pushed)) ids.add(clean(id));
    for (const id of Object.keys(failures)) ids.add(clean(id));
    for (const id of Object.keys(cancelled)) ids.add(clean(id));
    for (const id of openByBolId.keys()) ids.add(id);
    ids.delete('');

    const rows = [];
    const counts = { verzonden: 0, geannuleerd: 0, fout: 0, wachtVerzending: 0, wachtSrs: 0 };

    for (const bolOrderId of ids) {
      const open = openByBolId.get(bolOrderId);
      const sh = shipped[bolOrderId];
      const isCancelled = !!cancelled[bolOrderId];
      const fail = failures[bolOrderId];
      const push = pushed[bolOrderId];
      const srsOrderId = clean(push?.srsOrderId) || srsByBolId.get(bolOrderId) || clean(sh?.srsOrderId) || null;

      /* Fase-prioriteit: verzonden > geannuleerd > fout > wacht-verzending > wacht-srs. */
      let fase, faseLabel, reden = null;
      if (sh) { fase = 'verzonden'; faseLabel = 'Verzonden'; counts.verzonden += 1; }
      else if (isCancelled) { fase = 'geannuleerd'; faseLabel = 'Geannuleerd'; counts.geannuleerd += 1; }
      else if (fail) { fase = 'fout'; faseLabel = 'Fout bij SRS'; reden = clean(fail.error).slice(0, 300); counts.fout += 1; }
      else if (push) { fase = 'wacht-verzending'; faseLabel = 'Wacht op verzending'; counts.wachtVerzending += 1; }
      else { fase = 'wacht-srs'; faseLabel = 'Wacht op SRS'; counts.wachtSrs += 1; }

      const klant = open
        ? clean(open.klantNaam || open.customerName || `${open.firstName || ''} ${open.surname || ''}`.trim())
        : clean(push?.klant);
      const datum = clean(open?.datum || open?.orderPlacedDateTime || push?.at || atByBolId.get(bolOrderId) || '');

      rows.push({
        bolOrderId,
        srsOrderId,
        klant: klant || '—',
        datum,
        fase,
        faseLabel,
        reden,
        trackingNumber: sh ? clean(sh.trackAndTrace) : null,
        transporterCode: sh ? clean(sh.transporterCode) : null,
        total: push?.total ?? null,
        itemCount: push?.itemCount ?? null
      });
    }

    rows.sort((a, b) => String(b.datum).localeCompare(String(a.datum)) || String(b.srsOrderId).localeCompare(String(a.srsOrderId)));

    const phase = clean(req.query?.phase);
    const filtered = phase ? rows.filter((r) => r.fase === phase) : rows;

    return res.status(200).json({
      success: true,
      counts,
      total: rows.length,
      shown: filtered.length,
      generatedAt: openData?.generatedAt || openData?.refreshedAt || null,
      rows: filtered.slice(0, 500)
    });
  } catch (e) {
    console.error('[admin/bol-orders-history]', e);
    return res.status(500).json({ success: false, message: e.message || 'Geschiedenis ophalen mislukt.' });
  }
}
