/**
 * /api/admin/mixmatch-publish-bundle
 *
 * Maakt voor één pakket de fictieve bundle-producten in Shopify aan (2-delig en,
 * als er een gilet is, 3-delig), met gedeelde maat, gecombineerde foto's en een
 * sibling-koppeling voor de 2-/3-delig-switch. Slaat de aangemaakte product-id's
 * op het pakket op.
 *
 *   POST { id }   → pakket-id
 *
 * Schrijft naar Shopify (productBundleCreate e.d.). Auth: admin-token vereist.
 */

import { getPakket, setBundleProducts } from '../../lib/mixmatch-store.js';
import { publishPakketBundles } from '../../lib/mixmatch-bundle.js';
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

    const { created, errors } = await publishPakketBundles(pakket);
    if (created.length) await setBundleProducts(id, created);

    return res.status(200).json({
      success: true,
      created,
      errors,
      message: created.length
        ? `${created.length} bundle-product(en) aangemaakt: ${created.map((c) => c.type).join(', ')}.`
        : (errors[0] || 'Geen bundle-producten aangemaakt.')
    });
  } catch (e) {
    console.error('[admin/mixmatch-publish-bundle]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
