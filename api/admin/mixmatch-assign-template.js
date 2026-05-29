/**
 * /api/admin/mixmatch-assign-template
 *
 * Wijst de Mix & Match product-template (Shopify template_suffix, bv. "pakken")
 * toe aan de producten van Mix & Match-pakketten, zodat de "koop als compleet
 * pak"-sectie op die productpagina's verschijnt.
 *
 *   POST { suffix?, scope?, ids?, commit? }
 *     suffix  template-suffix (default "pakken" → template product.pakken)
 *     scope   'active' (default) = alleen actieve pakketten · 'all' = alle
 *     ids     optioneel: specifieke pakket-id's
 *     commit  false (default) = PREVIEW (schrijft niets) · true = schrijf weg
 *
 * Schrijft naar Shopify (productUpdate.templateSuffix). LET OP: dit is een
 * catalogus-write; een SRS→Shopify product-sync kan template_suffix later
 * overschrijven. Daarom preview-first + expliciet committen.
 *
 * Auth: admin-token vereist.
 */

import { readPakketten } from '../../lib/mixmatch-store.js';
import { shopifyGraphql } from '../../lib/shopify-gift-card-client.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 60;

const clean = (v) => String(v == null ? '' : v).trim();
function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    const body = parseBody(req);
    const suffix = clean(body.suffix) || 'pakken';
    const scope = clean(body.scope) || 'active';
    const commit = body.commit === true || body.commit === '1';
    const onlyIds = Array.isArray(body.ids) ? body.ids.map(clean).filter(Boolean) : null;

    const { pakketten } = await readPakketten();
    let target = pakketten;
    if (onlyIds && onlyIds.length) target = pakketten.filter((p) => onlyIds.includes(p.id));
    else if (scope === 'active') target = pakketten.filter((p) => p.status === 'actief');

    /* Verzamel unieke product-gids uit de pakket-componenten. */
    const prodMap = new Map();
    for (const p of target) {
      for (const c of (p.components || [])) {
        const gid = clean(c.productId);
        if (!/^gid:\/\/shopify\/Product\/\d+/.test(gid)) continue;
        if (!prodMap.has(gid)) prodMap.set(gid, { id: gid, title: clean(c.title) || clean(c.artikelId), role: c.role });
      }
    }
    const products = [...prodMap.values()];

    if (!products.length) {
      return res.status(200).json({
        success: true, commit: false, suffix, count: 0, products: [],
        message: 'Geen producten met geldige Shopify-product-id gevonden. Maak een pakket via een pak-code (die vult de productId) en zet het op Actief.'
      });
    }

    if (!commit) {
      return res.status(200).json({ success: true, commit: false, suffix, count: products.length, products });
    }

    /* Schrijf template_suffix per product (sequentieel = throttle-vriendelijk). */
    const results = [];
    for (const pr of products) {
      try {
        const d = await shopifyGraphql(
          `mutation($input: ProductInput!){ productUpdate(input: $input){ product { id templateSuffix } userErrors { field message } } }`,
          { input: { id: pr.id, templateSuffix: suffix } }
        );
        const errs = d?.productUpdate?.userErrors || [];
        if (errs.length) results.push({ ...pr, ok: false, error: errs.map((e) => e.message).join(', ') });
        else results.push({ ...pr, ok: true, templateSuffix: d?.productUpdate?.product?.templateSuffix || suffix });
      } catch (e) {
        results.push({ ...pr, ok: false, error: e.message || 'fout' });
      }
    }
    const okCount = results.filter((r) => r.ok).length;
    return res.status(200).json({ success: true, commit: true, suffix, count: products.length, okCount, failed: products.length - okCount, results });
  } catch (e) {
    console.error('[admin/mixmatch-assign-template]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
