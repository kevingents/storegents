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

import { readDragers, importDragers, enrichDragerItems } from '../../lib/srs-dragers-import.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 60;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    const refresh = req.query?.refresh === '1' || req.query?.refresh === 'true';
    const data = refresh ? await importDragers() : await readDragers();

    /* Drager-detail (?id=): klik op een drager → toon de items erin, verrijkt
       met Shopify-data (foto, titel, artikelnummer, kleur/maat). Read-only op de
       laatste snapshot. Bij ?store= wordt afgedwongen dat de drager naar die
       winkel onderweg is (geen cross-winkel inzage). */
    const dragerId = String(req.query?.id || req.query?.drager || '').trim();
    if (dragerId) {
      const d = (data.list || []).find((x) => String(x.id) === dragerId);
      if (!d) {
        return res.status(404).json({ success: false, message: 'Drager niet in de huidige snapshot gevonden.' });
      }
      const scopeStore = String(req.query?.store || '').trim();
      if (scopeStore) {
        const lc = scopeStore.toLowerCase();
        const own = String(d.bestemmingNaam || '').toLowerCase() === lc || String(d.bestemming || '') === scopeStore;
        if (!own) {
          return res.status(403).json({ success: false, message: 'Deze drager hoort niet bij jouw winkel.' });
        }
      }
      const items = await enrichDragerItems(d.itemBarcodes || []);
      return res.status(200).json({
        success: true,
        scope: 'drager',
        refreshedAt: data.refreshedAt || null,
        drager: {
          id: d.id,
          barcode: d.barcode,
          herkomst: d.herkomst,
          herkomstNaam: d.herkomstNaam,
          bestemming: d.bestemming,
          bestemmingNaam: d.bestemmingNaam,
          huidig: d.huidig,
          huidigNaam: d.huidigNaam,
          status: d.status,
          dagen: d.dagen,
          uren: d.uren,
          teLaat: d.teLaat,
          regels: d.regels
        },
        items
      });
    }

    /* Winkel-weergave (?store=): wat komt er naar deze winkel toe (bestemming),
       plus hoeveel daarvan te laat is. Read-only — geen SFTP-refresh. Matcht op
       winkelnaam of filiaal-nummer; alleen de eigen dragers terug. */
    const store = String(req.query?.store || '').trim();
    if (store) {
      const lc = store.toLowerCase();
      const list = (data.list || [])
        .filter((d) =>
          String(d.bestemmingNaam || '').toLowerCase() === lc || String(d.bestemming || '') === store
        )
        .map(({ itemBarcodes, ...d }) => d); /* barcodes alleen via ?id= */
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

    /* Admin-volledige lijst: strip per-regel barcodes uit de lijst (alleen via
       ?id= opvraagbaar) zodat de payload klein blijft. */
    const list = Array.isArray(data.list)
      ? data.list.map(({ itemBarcodes, ...d }) => d)
      : data.list;
    return res.status(200).json({ success: true, ...data, list });
  } catch (e) {
    console.error('[admin/dragers]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
