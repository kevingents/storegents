/**
 * /api/admin/merchandiser
 *
 * Merchandising-analyses bovenop voorraad + verkoop-advies. Eén endpoint, vier views:
 *   GET ?view=overview      → samenvatting (voorraad-gezondheid + top herverdeling/misgrijpen/doorverkoop)
 *   GET ?view=herverdeling  → winkel↔winkel verplaats-suggesties (overschot → tekort)
 *   GET ?view=misgrijpen    → SKU's out-of-stock terwijl ideaal > 0 (+ elders beschikbaar?)
 *   GET ?view=doorverkoop   → per winkel hardmover/slowmover/dekking + kansen + overvoorraad
 *   &limit=300 (max regels)
 *
 * Auth: admin. Leest alleen bestaande blobs (geen schrijf-actie, geen SRS-call).
 */

import { corsJson, requireAdmin } from '../../lib/request-guards.js';
import { buildMerchandiser } from '../../lib/merchandiser.js';

export const maxDuration = 30;

const VIEWS = new Set(['overview', 'herverdeling', 'misgrijpen', 'doorverkoop']);

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });

  try {
    const q = req.query || {};
    const view = VIEWS.has(String(q.view || '').toLowerCase()) ? String(q.view).toLowerCase() : 'overview';
    let limit = parseInt(q.limit, 10);
    if (!Number.isFinite(limit) || limit < 1) limit = 300;
    limit = Math.min(limit, 1000);

    const data = await buildMerchandiser(view, { limit });
    return res.status(200).json({ success: true, ...data });
  } catch (e) {
    console.error('[admin/merchandiser]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
