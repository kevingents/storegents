/**
 * /api/admin/beeldbank-dedup
 *
 * Dubbele productfoto's opsporen en (optioneel) verwijderen in Shopify.
 * Standaard dry-run; verwijdert pas bij apply=true.
 *
 * POST { productId, apply }                  → één product de-dupliceren
 * POST { limit?, offset?, apply? }           → batch scannen/opruimen (loop met nextOffset)
 * GET  ?productId=...                         → dry-run report voor één product
 *
 * Auth: admin-token vereist.
 */

import { corsJson, requireAdmin } from '../../lib/request-guards.js';
import { dedupeProduct, scanForDuplicates } from '../../lib/shopify-media-dedup.js';

export const maxDuration = 60;

function clean(v) { return String(v == null ? '' : v).trim(); }
function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body;
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    const body = parseBody(req);
    const productId = clean(body.productId || req.query.productId);

    if (productId) {
      const apply = Boolean(body.apply) || clean(req.query.apply) === '1';
      const r = await dedupeProduct(productId, { apply: req.method === 'POST' ? apply : false });
      return res.status(200).json({ success: true, ...r });
    }

    const limit = Math.min(Math.max(Number(body.limit ?? req.query.limit) || 6, 1), 10);
    const offset = Math.max(Number(body.offset ?? req.query.offset) || 0, 0);
    const apply = req.method === 'POST' && (Boolean(body.apply) || clean(req.query.apply) === '1');
    const r = await scanForDuplicates({ limit, offset, apply });
    return res.status(200).json({ success: true, apply, ...r });
  } catch (e) {
    console.error('[admin/beeldbank-dedup]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
