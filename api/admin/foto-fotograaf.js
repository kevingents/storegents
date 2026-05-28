/**
 * GET /api/admin/foto-fotograaf
 *
 * "Bij fotograaf" — producten die op filiaal 701 (Fotoshoot/uitleen) liggen,
 * met een melding hoe lang ze er al liggen (>14 dagen = te lang). Joint de
 * SRS-voorraad (filiaal 701) met de Shopify-product-cache voor titel/beeld.
 *
 * Aging via een 'sinds'-watermerk (blob): per SKU de eerste keer dat 'ie op 701
 * gezien is. Wordt lui bijgewerkt bij elke call (nieuwe SKU's krijgen 'nu',
 * verdwenen SKU's worden gesnoeid).
 *
 * Auth: admin-token vereist.
 */

import { readVoorraadRows } from '../../lib/srs-voorraad-store.js';
import { readProductsCache } from '../../lib/shopify-products-cache.js';
import { readJsonBlob, writeJsonBlob } from '../../lib/json-blob-store.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

const SEEN_PATH = 'marketing/foto-701-seen.json';
const FILIAAL = '701';
const DAG = 86400000;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    const [rows, cache] = await Promise.all([
      readVoorraadRows().catch(() => []),
      readProductsCache().catch(() => null)
    ]);

    /* Voorraad op 701 per SKU (som). */
    const at701 = new Map();
    for (const r of (rows || [])) {
      if (String(r.filiaalNummer) !== FILIAAL) continue;
      const sku = String(r.sku || '');
      if (!sku) continue;
      at701.set(sku, (at701.get(sku) || 0) + (Number(r.voorraad) || 0));
    }
    const skus = [...at701.entries()].filter(([, v]) => v > 0).map(([k]) => k);

    /* 'Sinds'-watermerk bijwerken (nieuwe SKU's → nu; verdwenen → weg). */
    const now = Date.now();
    const prev = await readJsonBlob(SEEN_PATH, { seen: {} });
    const prevSeen = (prev && prev.seen && typeof prev.seen === 'object') ? prev.seen : {};
    const seen = {};
    for (const sku of skus) seen[sku] = prevSeen[sku] || now;
    try { await writeJsonBlob(SEEN_PATH, { seen, updatedAt: new Date().toISOString() }); } catch (_) { /* best-effort */ }

    const bySku = cache?.bySku || {};
    const out = skus.map((sku) => {
      const since = seen[sku];
      const p = bySku[sku.toLowerCase()] || null;
      const images = Array.isArray(p?.images) ? p.images.filter(Boolean) : (p?.image ? [p.image] : []);
      return {
        sku,
        title: p?.title || sku,
        image: p?.image || images[0] || '',
        url: p?.productUrl || '',
        seizoen: p?.seizoen || '',
        hoofdgroep: p?.hoofdgroepOmschrijving || p?.hoofdgroep || '',
        voorraad: at701.get(sku),
        imagesCount: images.length,
        sinds: new Date(since).toISOString(),
        dagen: Math.floor((now - since) / DAG)
      };
    }).sort((a, b) => b.dagen - a.dagen || b.voorraad - a.voorraad);

    return res.status(200).json({
      success: true,
      filiaal: FILIAAL,
      refreshedAt: cache?.refreshedAt || null,
      total: out.length,
      langer14: out.filter((r) => r.dagen >= 14).length,
      rows: out.slice(0, 500),
      truncated: out.length > 500
    });
  } catch (e) {
    console.error('[admin/foto-fotograaf]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
