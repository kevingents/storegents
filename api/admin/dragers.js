/**
 * /api/admin/dragers
 *
 * Openstaande dragers (fysieke verplaatsingen tussen filialen). Toont wat er
 * onderweg is: per route, aging, en de "blijft hangen"-lijst. Bron: de SRS
 * verplaatsingen-export (zie lib/srs-dragers-import.js).
 *
 *   GET            → laatste snapshot (blob).
 *   GET ?refresh=1 → haalt de verse verplaatsingen-export op en herberekent.
 *
 * Auth: admin-token vereist.
 */

import { readDragers, importDragers } from '../../lib/srs-dragers-import.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 60;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    const refresh = req.query?.refresh === '1' || req.query?.refresh === 'true';
    const data = refresh ? await importDragers() : await readDragers();
    return res.status(200).json({ success: true, ...data });
  } catch (e) {
    console.error('[admin/dragers]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
