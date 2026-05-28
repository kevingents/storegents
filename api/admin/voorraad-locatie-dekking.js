/**
 * /api/admin/voorraad-locatie-dekking
 *
 * Kruist de voorraad-snapshot met de locaties-snapshot per magazijn om te
 * signaleren:
 *   - "zonder-locatie": SKU's MET voorraad (>0) maar ZONDER bin-locatie
 *                       → liggen er wel maar niet vindbaar; moeten een locatie krijgen
 *   - "spook":          SKU's MET locatie maar ZONDER voorraad (>0)
 *                       → bin-record blijft hangen terwijl voorraad op is; opruimen
 *   - "verkocht-zonder-locatie": SKU's met NEGATIEVE voorraad (<0) ZONDER bin-locatie
 *                       → verkocht/verstuurd zonder dat het ooit een locatie had.
 *                         Mag niet bij GENTS — sterkste proces-alert.
 *
 * GET                                  → { success, magazijnen: [...summary], generatedAt }
 * GET ?store=GENTS+Magazijn&type=zonder-locatie  → rows: [{ sku, voorraad, ideaal }]
 * GET ?store=GENTS+Magazijn&type=spook           → rows: [{ sku, locatie, aantal, lastInventarisation }]
 * GET ?store=GENTS+Magazijn&type=verkocht-zonder-locatie → rows: [{ sku, voorraad, ideaal }]
 *
 * Auth: admin-token vereist.
 */

import { readVoorraadRows, readLocaties } from '../../lib/srs-voorraad-store.js';
import { isExcludedFromVoorraadHealth } from '../../lib/business-config.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET.' });
  }

  try {
    const [voorraadRows, locData] = await Promise.all([readVoorraadRows(), readLocaties()]);
    const locRows = Array.isArray(locData?.rows) ? locData.rows : [];

    if (!voorraadRows.length || !locData?.generatedAt) {
      return res.status(200).json({
        success: true,
        empty: true,
        magazijnen: [],
        message: 'Voorraad- of locaties-snapshot ontbreekt. Trigger /api/cron/srs-voorraad-import.'
      });
    }

    /* Magazijnen = filialen die in de locaties-data voorkomen (daar worden
       bin-locaties getrackt). Excludeer niet-relevante filialen (webshop,
       Suitconcern magazijn, …) zodat ze niet in de gezondheids-view komen. */
    const magazijnFilialen = new Set(
      locRows.map((r) => r.filiaalNummer).filter((id) => !isExcludedFromVoorraadHealth(id))
    );

    /* Index locaties per (filiaal → set sku's) en per (filiaal → sku → rows) */
    const locByFiliaal = new Map();      /* filiaal → Set<sku> */
    const locRowsByFilSku = new Map();   /* `${filiaal}|${sku}` → [rows] */
    for (const r of locRows) {
      if (!locByFiliaal.has(r.filiaalNummer)) locByFiliaal.set(r.filiaalNummer, new Set());
      locByFiliaal.get(r.filiaalNummer).add(r.sku);
      const key = `${r.filiaalNummer}|${r.sku}`;
      if (!locRowsByFilSku.has(key)) locRowsByFilSku.set(key, []);
      locRowsByFilSku.get(key).push(r);
    }

    /* Index voorraad per (filiaal → sku → voorraad) */
    const vrdByFilSku = new Map();       /* `${filiaal}|${sku}` → { voorraad, ideaal, store } */
    const vrdSkusByFiliaal = new Map();  /* filiaal → Set<sku met voorraad>0> */
    const negSkusByFiliaal = new Map();  /* filiaal → Set<sku met voorraad<0> (verkocht/verstuurd zonder inboeken) */
    const storeNameByFiliaal = new Map();
    for (const r of voorraadRows) {
      if (!magazijnFilialen.has(r.filiaalNummer)) continue;
      storeNameByFiliaal.set(r.filiaalNummer, r.store);
      vrdByFilSku.set(`${r.filiaalNummer}|${r.sku}`, { voorraad: r.voorraad, ideaal: r.ideaal, store: r.store });
      if (r.voorraad > 0) {
        if (!vrdSkusByFiliaal.has(r.filiaalNummer)) vrdSkusByFiliaal.set(r.filiaalNummer, new Set());
        vrdSkusByFiliaal.get(r.filiaalNummer).add(r.sku);
      } else if (r.voorraad < 0) {
        if (!negSkusByFiliaal.has(r.filiaalNummer)) negSkusByFiliaal.set(r.filiaalNummer, new Set());
        negSkusByFiliaal.get(r.filiaalNummer).add(r.sku);
      }
    }

    const store = String(req.query?.store || '').trim();
    const type = String(req.query?.type || '').trim();

    /* Drill-down: lijst van rijen voor 1 magazijn + type */
    if (store && type) {
      /* Vind filiaalNummer bij store-naam */
      let targetFiliaal = null;
      for (const [fil, name] of storeNameByFiliaal.entries()) {
        if (name === store) { targetFiliaal = fil; break; }
      }
      if (!targetFiliaal) {
        return res.status(404).json({ success: false, message: `Magazijn "${store}" niet gevonden in voorraad-data.` });
      }
      const locSkus = locByFiliaal.get(targetFiliaal) || new Set();
      const vrdSkus = vrdSkusByFiliaal.get(targetFiliaal) || new Set();
      const negSkus = negSkusByFiliaal.get(targetFiliaal) || new Set();

      if (type === 'verkocht-zonder-locatie') {
        const rows = [];
        for (const sku of negSkus) {
          if (!locSkus.has(sku)) {
            const v = vrdByFilSku.get(`${targetFiliaal}|${sku}`) || {};
            rows.push({ sku, voorraad: v.voorraad || 0, ideaal: v.ideaal || 0 });
          }
        }
        rows.sort((a, b) => a.voorraad - b.voorraad); /* meest negatief eerst */
        return res.status(200).json({ success: true, store, type, count: rows.length, rows: rows.slice(0, 500), truncated: rows.length > 500, generatedAt: locData.generatedAt });
      }

      if (type === 'zonder-locatie') {
        const rows = [];
        for (const sku of vrdSkus) {
          if (!locSkus.has(sku)) {
            const v = vrdByFilSku.get(`${targetFiliaal}|${sku}`) || {};
            rows.push({ sku, voorraad: v.voorraad || 0, ideaal: v.ideaal || 0 });
          }
        }
        rows.sort((a, b) => b.voorraad - a.voorraad);
        return res.status(200).json({ success: true, store, type, count: rows.length, rows: rows.slice(0, 500), truncated: rows.length > 500, generatedAt: locData.generatedAt });
      }

      if (type === 'spook') {
        const rows = [];
        for (const sku of locSkus) {
          const hasStock = vrdSkus.has(sku);
          if (!hasStock) {
            const locs = locRowsByFilSku.get(`${targetFiliaal}|${sku}`) || [];
            locs.forEach((l) => rows.push({ sku, locatie: l.locatie, aantal: l.aantal, lastInventarisation: l.lastInventarisation }));
          }
        }
        rows.sort((a, b) => String(a.locatie).localeCompare(String(b.locatie), 'nl'));
        return res.status(200).json({ success: true, store, type, count: rows.length, rows: rows.slice(0, 500), truncated: rows.length > 500, generatedAt: locData.generatedAt });
      }

      return res.status(400).json({ success: false, message: 'type moet zonder-locatie, spook of verkocht-zonder-locatie zijn.' });
    }

    /* Default: per-magazijn summary */
    const magazijnen = [];
    for (const fil of magazijnFilialen) {
      const locSkus = locByFiliaal.get(fil) || new Set();
      const vrdSkus = vrdSkusByFiliaal.get(fil) || new Set();
      const negSkus = negSkusByFiliaal.get(fil) || new Set();
      let zonderLocatie = 0, zonderLocatieStuks = 0, spook = 0;
      let verkochtZonderLocatie = 0, verkochtZonderLocatieStuks = 0;
      for (const sku of vrdSkus) {
        if (!locSkus.has(sku)) {
          zonderLocatie += 1;
          zonderLocatieStuks += (vrdByFilSku.get(`${fil}|${sku}`)?.voorraad || 0);
        }
      }
      for (const sku of negSkus) {
        if (!locSkus.has(sku)) {
          verkochtZonderLocatie += 1;
          verkochtZonderLocatieStuks += Math.abs(vrdByFilSku.get(`${fil}|${sku}`)?.voorraad || 0);
        }
      }
      for (const sku of locSkus) {
        if (!vrdSkus.has(sku)) spook += 1;
      }
      magazijnen.push({
        filiaalNummer: fil,
        store: storeNameByFiliaal.get(fil) || `Filiaal ${fil}`,
        skusMetVoorraad: vrdSkus.size,
        skusMetLocatie: locSkus.size,
        zonderLocatie,
        zonderLocatieStuks,
        verkochtZonderLocatie,
        verkochtZonderLocatieStuks,
        spook,
        dekkingPct: vrdSkus.size ? Math.round(((vrdSkus.size - zonderLocatie) / vrdSkus.size) * 100) : 100
      });
    }
    /* Sorteer: verkocht-zonder-locatie (zwaarste overtreding) eerst, dan zonder-locatie */
    magazijnen.sort((a, b) => {
      if (b.verkochtZonderLocatie !== a.verkochtZonderLocatie) return b.verkochtZonderLocatie - a.verkochtZonderLocatie;
      return b.zonderLocatie - a.zonderLocatie;
    });

    return res.status(200).json({
      success: true,
      magazijnen,
      generatedAt: locData.generatedAt,
      sourceFile: locData.sourceFile || null
    });
  } catch (e) {
    console.error('[admin/voorraad-locatie-dekking]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
