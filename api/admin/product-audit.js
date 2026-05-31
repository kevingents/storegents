/**
 * GET /api/admin/product-audit
 *
 * Product-zichtbaarheid-audit van de Shopify-webshop. Toont producten die
 * voorraad + afbeelding hebben maar niet zichtbaar zijn (draft/archived/niet op
 * Online Store), producten zonder sales channel, en producten zonder categorie.
 *
 * Query:
 *   ?refresh=1   → forceer een live Shopify-scan (anders gecachte audit, ≤6u oud)
 *   ?bucket=...  → geef alleen die bucket terug (counts blijven volledig)
 *
 * Read-only: schrijft niets naar Shopify. Auth: admin-token vereist.
 */

import { runProductAudit, readProductAudit, isAuditFresh } from '../../lib/shopify-product-audit.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 60;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });

  try {
    const refresh = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());
    let audit = refresh ? null : await readProductAudit();
    let cached = Boolean(audit);
    if (!audit || !isAuditFresh(audit)) {
      audit = await runProductAudit();
      cached = false;
    }

    /* Optioneel één bucket teruggeven (kleinere payload voor de UI). */
    const only = String(req.query.bucket || '').trim();
    if (only && audit.buckets && audit.buckets[only]) {
      audit = { ...audit, buckets: { [only]: audit.buckets[only] } };
    }

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({ success: true, cached, ...audit });
  } catch (error) {
    console.error('[admin/product-audit]', error);
    return res.status(500).json({ success: false, message: error.message || 'Product-audit mislukt.' });
  }
}
