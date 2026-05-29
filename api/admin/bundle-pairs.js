/**
 * /api/admin/bundle-pairs
 *
 * Verkenning voor Shopify-bundles: koppelt losse colberts aan broeken (+ gilet)
 * via SRSERP.artikel_id (COL-xxx ↔ PAN-xxx) en laat zien welke metavelden de
 * producten hebben. Read-only — maakt nog géén bundles aan.
 *
 *   GET            → kandidaat-pakken + prefix-overzicht + metafield-inspectie.
 *   GET ?inspect=0 → sla de live metafield-steekproef over (sneller).
 *
 * Auth: admin-token vereist.
 */

import { findBundlePairs, inspectMetafields, findExistingBundles } from '../../lib/bundle-pairing.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 60;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    const data = await findBundlePairs();

    /* Live metafield-steekproef (om o.a. "stof" te vinden) — alleen als er
       pakken zijn en niet expliciet uitgezet. Pakt de eerste paren. */
    const inspect = String(req.query?.inspect ?? '1') !== '0';
    if (inspect && data.pairs.length) {
      const ids = [];
      for (const p of data.pairs.slice(0, 8)) {
        if (p.colbert?.productId) ids.push(p.colbert.productId);
        if (p.broek?.productId) ids.push(p.broek.productId);
      }
      data.metafieldInspectie = await inspectMetafields(ids).catch((e) => ({
        configured: true, error: e.message || 'inspectie faalde', products: [], keys: []
      }));
    }

    /* Check of er al een Shopify-bundle bestaat met deze producten (voorkomt
       dubbele aanmaak). Annotateert elk stuk + pak met de gevonden bundle(s). */
    const bundleCheck = await findExistingBundles().catch((e) => ({
      checked: false, error: e.message || 'bundle-check faalde', byComponent: {}, bundles: [], count: 0
    }));
    const byComp = bundleCheck.byComponent || {};
    let pakkenMetBundle = 0;
    for (const p of (data.pairs || [])) {
      const annotate = (piece) => { if (piece && piece.productId && byComp[piece.productId]) piece.inBundle = byComp[piece.productId]; };
      annotate(p.colbert); annotate(p.broek); annotate(p.gilet);
      p.bundleExists = Boolean((p.colbert && p.colbert.inBundle) || (p.broek && p.broek.inBundle) || (p.gilet && p.gilet.inBundle));
      if (p.bundleExists) pakkenMetBundle += 1;
    }
    data.bundleCheck = {
      checked: bundleCheck.checked,
      error: bundleCheck.error || '',
      count: bundleCheck.count || 0,
      truncated: Boolean(bundleCheck.truncated),
      pakkenMetBundle
    };

    return res.status(200).json({ success: true, ...data });
  } catch (e) {
    console.error('[admin/bundle-pairs]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
