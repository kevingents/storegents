import { handleCors, setCorsHeaders, requireAdmin } from '../../../lib/cors.js';
import { getStock } from '../../../lib/srs-stock-client.js';
import {
  readBranchSnapshot,
  writeBranchSnapshot
} from '../../../lib/srs-stock-snapshot-store.js';
import { isFeatureEnabled } from '../../../lib/feature-flags-store.js';
import { listAllBranches } from '../../../lib/branch-metrics.js';

/**
 * POST /api/admin/suitconcer/refresh-stock
 *
 * Bouwt de Blob stock-snapshot voor branches 702 (verkoop) en 704 (magazijn)
 * via live SOAP GetStock calls. Nodig zolang SRS deze branches niet meeneemt
 * in de SFTP nightly-export.
 *
 * Werking:
 * 1. Verzamel alle unieke barcodes uit bestaande snapshots van ALLE
 *    GENTS retail-branches. Dat is onze "kandidaat-lijst" om voor 702/704
 *    te checken.
 * 2. Per barcode: call GetStock met branchId=702 en/of branchId=704.
 *    Hou tellingen bij van pieces, plus eventuele lookup error.
 * 3. Bouw rows-array met alleen items waar pieces > 0 (anders veel ruis).
 * 4. Schrijf weg via writeBranchSnapshot voor 702 en 704.
 *
 * Body (optioneel):
 *   { branchId: '702' | '704' | 'both' (default both), barcodes?: [...], limit?: number }
 *   - barcodes: expliciete lijst (override de GENTS-snapshot lookup)
 *   - limit: max aantal SKUs (default 500 om Vercel 60s budget niet te verbranden)
 *
 * Response:
 *   { success, branchResults: { '702': {written, withStock}, '704': {...} }, errors: [...] }
 *
 * LET OP: Deze refresh is duur (1 SOAP call per SKU per branch). Voor productie
 * is het beter dat SRS de branches in de SFTP-export opneemt — dan vervalt deze
 * endpoint. Tot die tijd: handmatig of via een aparte cron.
 */

const SUITCONCER_BRANCHES = ['702', '704'];
const DEFAULT_LIMIT = Number(process.env.SUITCONCER_STOCK_REFRESH_LIMIT || 500);
const ABSOLUTE_MAX_LIMIT = 2000;
const PARALLEL_PER_BATCH = 8; /* concurrent SOAP calls — geen overload */

function clean(v) { return String(v || '').trim(); }

async function collectKnownBarcodes() {
  /* Lees alle GENTS branch-snapshots en verzamel unieke barcodes met
     wat metadata (sku, title, color, size). Skip 702/704 zelf. */
  const branches = listAllBranches();
  const candidates = branches.filter((b) => !SUITCONCER_BRANCHES.includes(String(b.branchId)));

  const seen = new Map(); /* barcode -> { sku, title, color, size } */

  for (const b of candidates) {
    try {
      const snap = await readBranchSnapshot(b.branchId);
      for (const r of (snap?.rows || [])) {
        const barcode = clean(r.barcode);
        if (!barcode || seen.has(barcode)) continue;
        seen.set(barcode, {
          sku: clean(r.sku || barcode),
          title: clean(r.title || ''),
          color: clean(r.color || ''),
          size: clean(r.size || '')
        });
      }
    } catch (error) {
      /* skip branch */
    }
  }

  return Array.from(seen.entries()).map(([barcode, meta]) => ({ barcode, ...meta }));
}

async function fetchStockForBranch(barcodes, branchId, errors) {
  const rows = [];
  /* Batch parallel om SOAP niet te overbelasten */
  for (let i = 0; i < barcodes.length; i += PARALLEL_PER_BATCH) {
    const batch = barcodes.slice(i, i + PARALLEL_PER_BATCH);
    const results = await Promise.all(batch.map(async (item) => {
      try {
        const r = await getStock({ barcode: item.barcode, branchId });
        const pieces = Number(r.pieces || 0);
        return { ...item, pieces, branchId };
      } catch (error) {
        errors.push({ branchId, barcode: item.barcode, message: error.message });
        return null;
      }
    }));
    for (const r of results) {
      if (r && r.pieces > 0) {
        rows.push({
          barcode: r.barcode,
          sku: r.sku,
          title: r.title,
          color: r.color,
          size: r.size,
          pieces: r.pieces,
          updatedAt: new Date().toISOString()
        });
      }
    }
  }
  return rows;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST.' });
  if (requireAdmin(req, res)) return;

  if (!(await isFeatureEnabled('suitconcer'))) {
    return res.status(403).json({ success: false, message: 'Suitconcer is uitgeschakeld.' });
  }

  const body = req.body || {};
  const branchInput = clean(body.branchId || 'both').toLowerCase();
  const limit = Math.min(Math.max(Number(body.limit || DEFAULT_LIMIT), 10), ABSOLUTE_MAX_LIMIT);
  const customBarcodes = Array.isArray(body.barcodes) ? body.barcodes.map(clean).filter(Boolean) : null;

  const targetBranches = branchInput === '702' ? ['702']
    : branchInput === '704' ? ['704']
    : SUITCONCER_BRANCHES;

  const startedAt = Date.now();
  const errors = [];
  const branchResults = {};

  try {
    /* Verzamel SKU-lijst */
    let candidates;
    if (customBarcodes) {
      candidates = customBarcodes.slice(0, limit).map((bc) => ({ barcode: bc, sku: bc, title: '', color: '', size: '' }));
    } else {
      const all = await collectKnownBarcodes();
      candidates = all.slice(0, limit);
    }

    if (!candidates.length) {
      return res.status(200).json({
        success: false,
        message: 'Geen SKUs gevonden. Vul handmatig barcodes mee in body of vul eerst de GENTS-snapshots.',
        branchResults: {},
        errors: []
      });
    }

    /* Voor elke target-branch: GetStock per SKU + write snapshot */
    for (const bid of targetBranches) {
      const rows = await fetchStockForBranch(candidates, bid, errors);
      const written = await writeBranchSnapshot(bid, rows);
      branchResults[bid] = {
        candidatesChecked: candidates.length,
        withStock: rows.length,
        savedAt: written.updatedAt
      };
    }

    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    return res.status(200).json({
      success: true,
      candidatesChecked: candidates.length,
      branchResults,
      errors: errors.slice(0, 50), /* truncate noisy errors */
      errorCount: errors.length,
      elapsedSec: elapsed,
      hint: 'Voor automatische sync vraag SRS om branches 702/704 mee te nemen in de SFTP nightly-export.'
    });
  } catch (error) {
    console.error('[suitconcer/refresh-stock] fatal:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Stock refresh faalde.',
      errors: errors.slice(0, 50)
    });
  }
}
