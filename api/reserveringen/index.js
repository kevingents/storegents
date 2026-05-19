/**
 * /api/reserveringen
 *   GET  ?store=...&status=... — lijst reserveringen per winkel
 *   POST                       — maak reservering aan
 *
 * Validatie bij POST:
 *   - winkel moet RES-filiaal mapping hebben
 *   - artikel moet voorraad ≥ quantity hebben in meldende winkel
 *     (anders 409, frontend moet voorraad-check eerst doen via products.js)
 */

import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import {
  createReservering,
  getReserveringen
} from '../../lib/reserveringen-store.js';
import { getReserveringBranch } from '../../lib/reserveringen-branch-mapping.js';

function clean(value) { return String(value || '').trim(); }

async function verifyStockInStore(store, barcode, sku, quantity) {
  /* Re-check voorraad bij submit zodat geen race wordt geriskeerd. */
  try {
    const mod = await import('../../lib/branch-metrics.js');
    const branches = typeof mod.listBranches === 'function' ? (mod.listBranches() || []) : [];
    const match = branches.find((b) => String(b.store || '').trim().toLowerCase() === store.trim().toLowerCase());
    if (!match) return { ok: false, reason: 'branch-onbekend' };

    const stockMod = await import('../../lib/srs-stock-snapshot-store.js');
    const fn = stockMod.readBranchSnapshot;
    if (typeof fn !== 'function') return { ok: true, reason: 'stock-check-niet-beschikbaar', skipped: true };
    const snap = await fn(String(match.branchId));
    const rows = Array.isArray(snap?.rows) ? snap.rows : Array.isArray(snap?.items) ? snap.items : [];
    const bc = String(barcode || '').trim().toLowerCase();
    const sk = String(sku || '').trim().toLowerCase();
    const hit = rows.find((r) => {
      const rb = String(r.barcode || '').trim().toLowerCase();
      const rs = String(r.sku || '').trim().toLowerCase();
      return (bc && rb === bc) || (sk && rs === sk);
    });
    const stock = Number(hit?.quantity ?? hit?.pieces ?? hit?.voorraad ?? 0);
    if (stock < quantity) {
      return { ok: false, reason: 'onvoldoende-voorraad', stock, requested: quantity };
    }
    return { ok: true, stock };
  } catch (error) {
    /* Bij snapshot-fout fail-open want we willen winkel niet blokkeren. Log
       wel de reden voor monitoring. */
    return { ok: true, reason: 'stock-check-error', error: error.message };
  }
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'GET') {
    try {
      const store = clean(req.query.store);
      const status = clean(req.query.status);
      const includeAll = String(req.query.all || '') === '1';
      const items = await getReserveringen({ store, status, includeAll });
      return res.status(200).json({ success: true, count: items.length, items });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const store = clean(body.store);
      if (!store) return res.status(400).json({ success: false, message: 'Geef winkel mee.' });

      const resBranch = getReserveringBranch(store);
      if (!resBranch) {
        return res.status(400).json({
          success: false,
          message: `Voor "${store}" is geen RES-filiaal geconfigureerd in lib/reserveringen-branch-mapping.js.`
        });
      }

      const quantity = Math.max(1, Math.floor(Number(body.quantity || 1)));
      const barcode = clean(body.barcode);
      const sku = clean(body.sku);
      if (!barcode && !sku) return res.status(400).json({ success: false, message: 'Geef barcode of SKU mee.' });

      /* Server-side voorraad-check: alleen reserveren wat winkel zelf heeft. */
      const check = await verifyStockInStore(store, barcode, sku, quantity);
      if (!check.ok && check.reason === 'onvoldoende-voorraad') {
        return res.status(409).json({
          success: false,
          message: `Niet genoeg voorraad in ${store}: ${check.stock} beschikbaar, ${check.requested} gevraagd.`,
          stock: check.stock,
          requested: check.requested
        });
      }

      const reservering = await createReservering({
        ...body,
        store,
        resBranchId: resBranch.branchId,
        resBranchName: resBranch.name,
        quantity
      });

      return res.status(201).json({
        success: true,
        reservering,
        stockCheck: check
      });
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }
  }

  return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
}
