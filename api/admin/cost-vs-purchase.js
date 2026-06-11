/**
 * GET /api/admin/cost-vs-purchase
 *
 * Vergelijkt per SKU/EAN de KOSTPRIJS (uit de SRS-verkopen-export, opgeslagen in
 * marketing/product-cost.json — inkoop ex-BTW) met de INKOOPPRIJS uit de laatste
 * inkooporder (SRS GetPurchaseOrders → PurchasePrice). Markeert:
 *   - verschil  : kostprijs != inkoopprijs
 *   - kostLeeg  : geen/0 kostprijs bekend
 *   - inkoopLeeg: geen inkooporder-prijs bekend
 *
 * Query: ?days=365 (venster voor inkooporders, 30..1095).
 * Auth: admin-token.
 */
import { readProductCost } from '../../lib/product-cost-store.js';
import { getPurchaseOrders } from '../../lib/srs-purchase-orders-client.js';
import { listOrders } from '../../lib/inkoop-store.js';
import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';

export const maxDuration = 60;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (requireAdmin(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });

  try {
    const days = Math.min(1095, Math.max(7, Number(req.query.days) || 30));

    /* 1) Kostprijs per EAN/SKU uit de cost-store (uit de verkopen-export). */
    const cost = await readProductCost();
    const bySku = (cost && cost.bySku) || {};

    /* 2) Laatste inkoopprijs per barcode én sku — uit twee bronnen, nieuwste wint. */
    let poError = '';
    let ordersScanned = 0;
    let portalOrders = 0;
    const inkoopByKey = new Map(); /* key(barcode|sku) -> { inkoop, orderDate, supplier, orderNr, bron } */
    const upsert = (key, entry) => {
      if (!key || !entry.inkoop) return;
      const prev = inkoopByKey.get(key);
      if (!prev || String(entry.orderDate || '') > String(prev.orderDate || '')) inkoopByKey.set(key, entry);
    };

    /* 2a) Portal-inkooporders (inkoop-store blob): de ÉCHT ingevoerde inkoopprijs. Snel, geen SOAP. */
    try {
      const orders = await listOrders({});
      portalOrders = orders.length;
      for (const o of orders) {
        for (const l of (o.lines || [])) {
          const entry = { inkoop: Number(l.purchasePrice || 0), orderDate: o.orderDate || o.createdAt || '', supplier: o.supplierName || '', orderNr: o.orderNr || '', bron: 'portal' };
          upsert(String(l.barcode || '').trim(), entry);
          upsert(String(l.sku || '').trim(), entry);
        }
      }
    } catch (e) {
      /* portal-inkoop optioneel — geen blocker */
    }

    /* 2b) SRS-inkooporders (laatste `days`, best-effort — kan timeouten; portal-data blijft dan staan). */
    try {
      const po = await getPurchaseOrders({ days, status: 'all' });
      const orders = Array.isArray(po) ? po : (po.orders || []);
      ordersScanned = orders.length;
      for (const o of orders) {
        for (const p of (o.products || [])) {
          const entry = { inkoop: Number(p.purchasePrice || 0), orderDate: o.orderDate || '', supplier: (o.supplier && o.supplier.name) || '', orderNr: o.orderNr || '', bron: 'srs' };
          upsert(String(p.barcode || '').trim(), entry);
          upsert(String(p.sku || '').trim(), entry);
        }
      }
    } catch (e) {
      poError = (e && e.message) || 'SRS-inkooporders niet beschikbaar (portal-inkoop wel gebruikt).';
    }

    /* 3) Join: alle SKU's die in de kostprijs- OF inkoopprijs-bron voorkomen. */
    const keys = new Set([...Object.keys(bySku), ...inkoopByKey.keys()]);
    const rows = [];
    for (const k of keys) {
      const c = bySku[k];
      const kostprijs = c && c.kostprijs != null ? round2(c.kostprijs) : null;
      const poEntry = inkoopByKey.get(k);
      const inkoop = poEntry ? round2(poEntry.inkoop) : null;

      const kostLeeg = kostprijs == null || kostprijs === 0;
      const inkoopLeeg = inkoop == null || inkoop === 0;

      let verschil = null;
      let verschilPct = null;
      if (!kostLeeg && !inkoopLeeg) {
        verschil = round2(kostprijs - inkoop);
        verschilPct = inkoop ? round2(((kostprijs - inkoop) / inkoop) * 100) : null;
      }

      rows.push({
        sku: k,
        kostprijs,
        inkoop,
        verschil,
        verschilPct,
        kostLeeg,
        inkoopLeeg,
        heeftVerschil: verschil != null && Math.abs(verschil) >= 0.01,
        supplier: (poEntry && poEntry.supplier) || '',
        orderNr: (poEntry && poEntry.orderNr) || '',
        orderDate: (poEntry && poEntry.orderDate) || '',
        inkoopBron: (poEntry && poEntry.bron) || '',
        costAt: (c && c.at) || ''
      });
    }

    /* Sorteer: grootste absolute verschillen eerst, daarna lege gevallen. */
    rows.sort((a, b) => {
      const av = a.verschil == null ? -1 : Math.abs(a.verschil);
      const bv = b.verschil == null ? -1 : Math.abs(b.verschil);
      return bv - av;
    });

    const summary = {
      total: rows.length,
      beide: rows.filter((r) => !r.kostLeeg && !r.inkoopLeeg).length,
      metVerschil: rows.filter((r) => r.heeftVerschil).length,
      kostLeeg: rows.filter((r) => r.kostLeeg).length,
      inkoopLeeg: rows.filter((r) => r.inkoopLeeg).length
    };

    return res.status(200).json({
      success: true,
      days,
      ordersScanned,
      portalOrders,
      summary,
      rows: rows.slice(0, 5000),
      truncated: rows.length > 5000,
      poError,
      costUpdatedAt: (cost && cost.updatedAt) || null,
      generatedAt: new Date().toISOString()
    });
  } catch (e) {
    console.error('[admin/cost-vs-purchase]', e);
    return res.status(500).json({ success: false, message: (e && e.message) || 'Kostprijs-vergelijking mislukt.' });
  }
}
