/**
 * /api/admin/content-checks
 *
 * Content-kwaliteit checks op de Shopify-producten (alleen seizoen 2026 / NOS):
 *   - noImage  : product met voorraad>0 maar GEEN afbeelding
 *   - oneImage : product met precies 1 afbeelding
 *
 * Joint de Shopify-product-cache (images + seizoen, per variant) met de
 * SRS-voorraad-snapshot (voorraad per SKU). Groepeert per product.
 *
 * Auth: admin-token vereist.
 */

import { readProductsCache } from '../../lib/shopify-products-cache.js';
import { readVoorraadRows } from '../../lib/srs-voorraad-store.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

/* Seizoen valt binnen scope als het '2026' bevat of een los 'NOS'-token is. */
function inScope(seizoen) {
  const u = String(seizoen || '').toUpperCase();
  if (u.includes('2026')) return true;
  return u.split(/[^A-Z0-9]+/).includes('NOS');
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    const [cache, voorraadRows] = await Promise.all([
      readProductsCache(),
      readVoorraadRows().catch(() => [])
    ]);

    /* Voorraad per SKU (som over alle filialen). */
    const voorraadBySku = new Map();
    for (const r of voorraadRows) {
      const sku = String(r.sku || '');
      if (!sku) continue;
      voorraadBySku.set(sku, (voorraadBySku.get(sku) || 0) + (Number(r.voorraad) || 0));
    }

    /* Groepeer variant-cache per product. */
    const byProduct = new Map();
    for (const v of Object.values(cache.bySku || {})) {
      const pid = v.productId || v.productHandle || v.title;
      if (!pid) continue;
      if (!byProduct.has(pid)) {
        byProduct.set(pid, {
          title: v.title || '—',
          handle: v.productHandle || '',
          url: v.productUrl || '',
          seizoen: v.seizoen || '',
          vendor: v.vendor || '',
          hoofdgroep: v.hoofdgroepOmschrijving || v.hoofdgroep || '',
          imagesCount: 0,
          voorraad: 0,
          _skus: new Set()
        });
      }
      const p = byProduct.get(pid);
      const ic = Array.isArray(v.images) ? v.images.length : (v.image ? 1 : 0);
      if (ic > p.imagesCount) p.imagesCount = ic;
      if (!p.seizoen && v.seizoen) p.seizoen = v.seizoen;
      const sku = String(v.sku || '');
      if (sku && !p._skus.has(sku)) { p._skus.add(sku); p.voorraad += (voorraadBySku.get(sku) || 0); }
    }

    const products = Array.from(byProduct.values()).filter((p) => inScope(p.seizoen));
    const slim = (p) => ({
      title: p.title, handle: p.handle, url: p.url, seizoen: p.seizoen,
      vendor: p.vendor, hoofdgroep: p.hoofdgroep, imagesCount: p.imagesCount, voorraad: p.voorraad
    });

    const noImage = products.filter((p) => p.imagesCount === 0 && p.voorraad > 0).sort((a, b) => b.voorraad - a.voorraad);
    const oneImage = products.filter((p) => p.imagesCount === 1).sort((a, b) => b.voorraad - a.voorraad);

    return res.status(200).json({
      success: true,
      refreshedAt: cache.refreshedAt || null,
      seizoenScope: '2026 / NOS',
      productsInScope: products.length,
      noImage: { count: noImage.length, rows: noImage.slice(0, 250).map(slim), truncated: noImage.length > 250 },
      oneImage: { count: oneImage.length, rows: oneImage.slice(0, 250).map(slim), truncated: oneImage.length > 250 }
    });
  } catch (e) {
    console.error('[admin/content-checks]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
