/**
 * /api/admin/mixmatch-publish-bundle
 *
 * Maakt voor één pakket één FICTIEF pak-product in Shopify aan — een gewoon
 * product (geen native bundle) met template 'mix-and-match', gecombineerde
 * foto's, tags en metafields. De verkoop loopt via de Mix & Match-widget op dat
 * product (losse producten, eigen maat per onderdeel, 2-/3-delig switch). Slaat
 * het aangemaakte product-id op het pakket op.
 *
 *   POST { id }   → pakket-id
 *
 * Schrijft naar Shopify (productCreate e.d.). Auth: admin-token vereist.
 */

import { getPakket, setBundleProducts } from '../../lib/mixmatch-store.js';
import { publishPakketFictief } from '../../lib/mixmatch-fictief.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 60;

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    const body = readBody(req);
    const id = String(body.id || '').trim();
    if (!id) return res.status(400).json({ success: false, message: 'Geen pakket-id.' });

    const pakket = await getPakket(id);
    if (!pakket) return res.status(404).json({ success: false, message: 'Pakket niet gevonden.' });

    const { created, errors } = await publishPakketFictief(pakket);
    if (created.length) await setBundleProducts(id, created);

    return res.status(200).json({
      success: true,
      created,
      errors,
      message: created.length
        ? `Fictief pak-product aangemaakt (${created.map((c) => c.type).join(', ')}). Wijs de Mix & Match-widget toe en publiceer.`
        : (errors[0] || 'Geen pak-product aangemaakt.')
    });
  } catch (e) {
    console.error('[admin/mixmatch-publish-bundle]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
