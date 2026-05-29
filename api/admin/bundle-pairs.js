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

import { findBundlePairs, inspectMetafields } from '../../lib/bundle-pairing.js';
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

    return res.status(200).json({ success: true, ...data });
  } catch (e) {
    console.error('[admin/bundle-pairs]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
