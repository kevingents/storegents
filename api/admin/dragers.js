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

    /* Winkel-weergave (?store=): wat komt er naar deze winkel toe (bestemming),
       plus hoeveel daarvan te laat is. Read-only — geen SFTP-refresh. Matcht op
       winkelnaam of filiaal-nummer; alleen de eigen dragers terug. */
    const store = String(req.query?.store || '').trim();
    if (store) {
      const lc = store.toLowerCase();
      const list = (data.list || []).filter((d) =>
        String(d.bestemmingNaam || '').toLowerCase() === lc || String(d.bestemming || '') === store
      );
      const entry = (data.byStore || []).find((s) =>
        String(s.store || '').toLowerCase() === lc || String(s.filiaal || '') === store
      );
      return res.status(200).json({
        success: true,
        scope: 'store',
        store,
        deadlineHours: data.deadlineHours || 48,
        refreshedAt: data.refreshedAt || null,
        sourceFile: data.sourceFile || '',
        totals: {
          dragers: entry?.dragers ?? list.length,
          stuks: entry?.stuks ?? list.reduce((n, d) => n + (d.regels || 0), 0),
          teLaat: entry?.teLaat ?? list.filter((d) => d.teLaat).length
        },
        list
      });
    }

    return res.status(200).json({ success: true, ...data });
  } catch (e) {
    console.error('[admin/dragers]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
