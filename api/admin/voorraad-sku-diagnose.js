/**
 * GET /api/admin/voorraad-sku-diagnose?sku=2900000252042
 *
 * Diagnose voor één SKU: dumpt ALLES wat we erover hebben in de voorraad-blob
 * + de locaties-blob + hoe we het aggregeren in de stock-reconcile. Gebruikt
 * om "waarom toont portal X maar SRS Y" mismatches te debuggen.
 *
 * Response:
 *   {
 *     sku,
 *     voorraadRows:     [{ filiaalNummer, store, voorraad, ideaal, ... }]   uit voorraad_*.csv.gz
 *     locatiesRows:     [{ filiaalNummer, store, locatie, aantal, geblokkeerd }]  uit voorraadlocaties_*.csv.gz
 *     aggregates:       { magazijn, totaal, perFiliaal, locatieAantal }
 *     warehouseConfig:  { branchIds, configured }
 *     meta:             { voorraadGeneratedAt, locatiesGeneratedAt }
 *   }
 */

import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { readVoorraadRows, readLocatiesRows } from '../../lib/srs-voorraad-store.js';
import { listBranchesFromConfig } from '../../lib/business-config.js';

const clean = (v) => String(v == null ? '' : v).trim();
const skuKey = (v) => clean(v).toLowerCase();

export const maxDuration = 30;

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (requireAdmin(req, res)) return;

  const sku = clean(req.query.sku);
  if (!sku) return res.status(400).json({ success: false, message: 'sku query-parameter verplicht.' });

  try {
    const [voorraadRows, locatieRows] = await Promise.all([
      readVoorraadRows(),
      readLocatiesRows()
    ]);

    const k = skuKey(sku);
    const matchingVoorraad = (voorraadRows || []).filter((r) => skuKey(r.sku) === k);
    const matchingLocaties = (locatieRows || []).filter((r) => skuKey(r.sku) === k);

    /* Aggregeer zoals stock-reconcile dat doet. */
    const branches = listBranchesFromConfig({ includeInternal: true });
    const warehouseIds = new Set(branches.filter((b) => b.kind === 'warehouse').map((b) => String(b.branchId)));
    const warehouseBranches = branches.filter((b) => b.kind === 'warehouse').map((b) => ({ branchId: b.branchId, store: b.store }));

    let magazijn = 0;
    let totaal = 0;
    const perFiliaal = {};
    for (const r of matchingVoorraad) {
      const v = Number(r.voorraad || 0);
      totaal += v;
      const fid = String(r.filiaalNummer || '');
      perFiliaal[fid] = perFiliaal[fid] || { store: r.store, voorraad: 0, ideaal: 0, isWarehouse: warehouseIds.has(fid) };
      perFiliaal[fid].voorraad += v;
      perFiliaal[fid].ideaal += Number(r.ideaal || 0);
      if (warehouseIds.has(fid)) magazijn += v;
    }

    /* Locatie-aggregate per filiaal voor cross-check. */
    const locatieAantal = {};
    for (const r of matchingLocaties) {
      const fid = String(r.filiaalNummer || '');
      locatieAantal[fid] = locatieAantal[fid] || { store: r.store, totaal: 0, bakken: 0, geblokkeerd: 0 };
      locatieAantal[fid].totaal += Number(r.aantal || 0);
      locatieAantal[fid].bakken += 1;
      if (r.geblokkeerd) locatieAantal[fid].geblokkeerd += Number(r.aantal || 0);
    }

    /* Verschil-detectie: voor warehouse-filialen, vergelijk voorraad vs locaties. */
    const mismatches = [];
    for (const fid of warehouseIds) {
      const v = perFiliaal[fid]?.voorraad || 0;
      const l = locatieAantal[fid]?.totaal || 0;
      if (v !== l) {
        mismatches.push({
          filiaalNummer: fid,
          store: perFiliaal[fid]?.store || locatieAantal[fid]?.store || `Filiaal ${fid}`,
          voorraadFile: v,
          locatiesFile: l,
          verschil: l - v,
          uitleg: l > v
            ? 'Locaties-bestand telt meer dan voorraad-bestand → voorraad-export laat fysieke bak-aantallen weg (geblokkeerd of niet-doorgezet).'
            : 'Voorraad-bestand telt meer dan locaties → voorraad zonder bak-toewijzing (=valt buiten Shopify-doorzet).'
        });
      }
    }

    return res.status(200).json({
      success: true,
      sku,
      voorraadRows: matchingVoorraad,
      locatiesRows: matchingLocaties,
      aggregates: {
        magazijn,
        totaal,
        perFiliaal,
        locatieAantal
      },
      mismatches,
      warehouseConfig: {
        branches: warehouseBranches,
        configured: warehouseIds.size > 0
      },
      counts: {
        voorraadRowsForSku: matchingVoorraad.length,
        locatieRowsForSku: matchingLocaties.length,
        totalVoorraadRows: (voorraadRows || []).length,
        totalLocatieRows: (locatieRows || []).length
      }
    });
  } catch (error) {
    console.error('[voorraad-sku-diagnose]', error);
    return res.status(500).json({ success: false, message: error.message || 'Diagnose mislukt.' });
  }
}
