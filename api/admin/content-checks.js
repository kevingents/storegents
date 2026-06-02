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
          productId: v.productId || '',
          title: v.title || '—',
          handle: v.productHandle || '',
          url: v.productUrl || '',
          seizoen: v.seizoen || '',
          vendor: v.vendor || '',
          hoofdgroep: v.hoofdgroepOmschrijving || v.hoofdgroep || '',
          imagesCount: 0,
          voorraad: 0,
          createdAt: v.createdAt || '',
          hasLongDescription: !!v.hasLongDescription,
          hasComplementary: !!v.hasComplementary,
          _skus: new Set()
        });
      }
      const p = byProduct.get(pid);
      const ic = Array.isArray(v.images) ? v.images.length : (v.image ? 1 : 0);
      if (ic > p.imagesCount) p.imagesCount = ic;
      if (!p.seizoen && v.seizoen) p.seizoen = v.seizoen;
      if (!p.createdAt && v.createdAt) p.createdAt = v.createdAt;
      if (v.hasLongDescription) p.hasLongDescription = true;
      if (v.hasComplementary) p.hasComplementary = true;
      const sku = String(v.sku || '');
      if (sku && !p._skus.has(sku)) { p._skus.add(sku); p.voorraad += (voorraadBySku.get(sku) || 0); }
    }

    const allProducts = Array.from(byProduct.values());

    /* Debug-lookup: ?debug=<barcode|sku|artikelnummer> → waaróm staat dit artikel
       wel/niet in het rapport? (niet in cache / seizoen buiten scope / SKU-join
       geeft voorraad 0 / heeft tóch een afbeelding). */
    const debugQ = String(req.query.debug || '').trim();
    if (debugQ) {
      const k = debugQ.toLowerCase();
      let entry = (cache.byBarcode && cache.byBarcode[k])
        || (cache.bySku && cache.bySku[k])
        || (cache.bySrsArtikelId && cache.bySrsArtikelId[k])
        || (cache.bySrsRveArtikelnummer && cache.bySrsRveArtikelnummer[k])
        || (cache.bySrsArticleNumber && cache.bySrsArticleNumber[k])
        || null;
      let via = entry ? 'index' : null;
      /* Lineaire fallback (bv. artikelnummer-zoekopdracht). */
      if (!entry) {
        for (const v of Object.values(cache.bySku || {})) {
          const fields = [v.sku, v.barcode, v.articleNumber, v.srsArtikelId, v.srsRveArtikelnummer].map((x) => String(x || '').toLowerCase());
          if (fields.includes(k)) { entry = v; via = 'scan'; break; }
        }
      }
      const voorraadRowsForQuery = voorraadRows.filter((r) => String(r.sku || '').toLowerCase() === k).slice(0, 30);
      let product = null, reason;
      if (!entry) {
        reason = 'Niet gevonden in de Shopify-product-cache. Staat dit product wel op Shopify met deze barcode/SKU? Zo ja: de cache is mogelijk verouderd — draai de cron shopify-products-refresh.';
      } else {
        const pid = entry.productId || entry.productHandle || entry.title;
        product = byProduct.get(pid) || null;
        const variantImages = Array.isArray(entry.images) ? entry.images.length : (entry.image ? 1 : 0);
        const imagesCount = product ? product.imagesCount : variantImages;
        const voorraad = product ? product.voorraad : (voorraadBySku.get(String(entry.sku || '')) || 0);
        const seizoen = (product && product.seizoen) || entry.seizoen || '';
        if (imagesCount > 0) reason = `Heeft ${imagesCount} afbeelding(en) op Shopify → valt daarom niet onder "geen afbeelding".`;
        else if (!inScope(seizoen)) reason = `Seizoen "${seizoen || '(leeg)'}" valt buiten de scope 2026/NOS → uitgefilterd uit dit rapport.`;
        else if (!(voorraad > 0)) reason = `Voorraad ${voorraad} (join op variant-SKU "${entry.sku || '(leeg)'}"). Geen voorraad>0 → valt niet onder "wél voorraad". Controleer of de SRS-voorraad-SKU exact gelijk is aan de Shopify-variant-SKU.`;
        else reason = 'Voldoet aan alle voorwaarden — zou in "geen afbeelding — wél voorraad" moeten staan. Ververs de pagina/cache.';
      }
      return res.status(200).json({
        success: true,
        debug: {
          query: debugQ,
          foundInCache: !!entry,
          via,
          variant: entry ? {
            productId: entry.productId, title: entry.title, sku: entry.sku, barcode: entry.barcode,
            articleNumber: entry.articleNumber, srsArtikelId: entry.srsArtikelId, seizoen: entry.seizoen,
            imagesOnVariant: Array.isArray(entry.images) ? entry.images.length : (entry.image ? 1 : 0), url: entry.productUrl
          } : null,
          product: product ? {
            title: product.title, seizoen: product.seizoen, inScope: inScope(product.seizoen),
            imagesCount: product.imagesCount, voorraad: product.voorraad, url: product.url
          } : null,
          voorraadRowsForQuery,
          reason
        }
      });
    }

    const products = allProducts.filter((p) => inScope(p.seizoen));
    const slim = (p) => ({
      productId: p.productId, title: p.title, handle: p.handle, url: p.url, seizoen: p.seizoen,
      vendor: p.vendor, hoofdgroep: p.hoofdgroep, imagesCount: p.imagesCount, voorraad: p.voorraad
    });

    const noImage = products.filter((p) => p.imagesCount === 0 && p.voorraad > 0).sort((a, b) => b.voorraad - a.voorraad);
    const oneImage = products.filter((p) => p.imagesCount === 1).sort((a, b) => b.voorraad - a.voorraad);

    /* Nieuw op Shopify (laatste 14 dagen) zonder afbeelding — over ALLE producten
       (een vers product heeft soms nog geen seizoen-metafield). */
    const cutoff = Date.now() - 14 * 86400000;
    const newNoImage = allProducts
      .filter((p) => p.imagesCount === 0 && p.createdAt && Date.parse(p.createdAt) >= cutoff)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map((p) => ({ ...slim(p), createdAt: p.createdAt }));

    /* long_description + complementary — alleen tonen als de metafield überhaupt
       leesbaar is (anders zou álles "ontbreekt" tonen → misleidend). */
    /* custom.long_description is een eigen (custom) metafield dat we zélf
       schrijven — altijd "beschikbaar", ook als nog geen enkel product het
       gevuld heeft (anders verbergen we de generator juist als je 'm nodig hebt). */
    const longReadable = true;
    const compReadable = products.some((p) => p.hasComplementary);
    const missingLong = longReadable ? products.filter((p) => !p.hasLongDescription).sort((a, b) => b.voorraad - a.voorraad) : [];
    const missingComp = compReadable ? products.filter((p) => !p.hasComplementary).sort((a, b) => b.voorraad - a.voorraad) : [];

    return res.status(200).json({
      success: true,
      refreshedAt: cache.refreshedAt || null,
      seizoenScope: '2026 / NOS',
      productsInScope: products.length,
      noImage: { count: noImage.length, rows: noImage.slice(0, 250).map(slim), truncated: noImage.length > 250 },
      oneImage: { count: oneImage.length, rows: oneImage.slice(0, 250).map(slim), truncated: oneImage.length > 250 },
      newNoImage: { count: newNoImage.length, rows: newNoImage.slice(0, 100) },
      longDescription: { available: longReadable, count: missingLong.length, rows: missingLong.slice(0, 250).map(slim), truncated: missingLong.length > 250 },
      complementary: { available: compReadable, count: missingComp.length, rows: missingComp.slice(0, 250).map(slim), truncated: missingComp.length > 250 }
    });
  } catch (e) {
    console.error('[admin/content-checks]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
