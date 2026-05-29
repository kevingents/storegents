/**
 * lib/product-cost-store.js
 *
 * Inkoopprijs (kostprijs) per EAN/SKU, opgebouwd uit de SRS-verkopen
 * (verkopen-export, kolom `kostprijs` — ex-BTW, centen). Voedt de Channable
 * POAS-marge-feed. Stapelt zich op: nieuwe imports werken de prijs bij wanneer
 * er een nieuwere verkoopregel is; oude entries worden gesnoeid.
 *
 * Blob marketing/product-cost.json:
 *   { bySku: { '<ean>': { kostprijs, sell, btw, at } }, updatedAt, count }
 *   - kostprijs : inkoop ex-BTW (euro)
 *   - sell      : gecalculeerde verkoopprijs incl-BTW (euro) — fallback
 *   - btw       : btw-percentage (bv. 21)
 *   - at        : 'YYYY-MM-DD HH:MM:SS' van de laatste verkoopregel
 */

import { readJsonBlob, mutateJsonBlob } from './json-blob-store.js';

const PATH = 'marketing/product-cost.json';
const MAX_AGE_DAYS = 400; /* prune kostprijzen ouder dan ~13 maanden */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export async function readProductCost() {
  const d = await readJsonBlob(PATH, { bySku: {}, updatedAt: null });
  return (d && typeof d === 'object' && d.bySku) ? d : { bySku: {}, updatedAt: null };
}

/**
 * Voeg/actualiseer kostprijzen. `updates` = { ean: { kostprijs, sell, btw, at } }.
 * Houdt per EAN de nieuwste `at` aan.
 */
export async function mergeProductCost(updates) {
  /* Read-modify-write via mutateJsonBlob: conflict-detectie + retry zodat een
     overlappende import deze kostprijs-tabel niet clobbert. */
  return mutateJsonBlob(
    PATH,
    (cur0) => {
      const cur = (cur0 && typeof cur0 === 'object' && cur0.bySku) ? cur0 : { bySku: {}, updatedAt: null };
      const bySku = { ...cur.bySku };
      for (const [sku, v] of Object.entries(updates || {})) {
        if (!sku || !v) continue;
        const prev = bySku[sku];
        if (!prev || String(v.at || '') >= String(prev.at || '')) {
          bySku[sku] = {
            kostprijs: round2(v.kostprijs),
            sell: round2(v.sell),
            btw: Number(v.btw) || 21,
            at: String(v.at || '')
          };
        }
      }
      /* Prune oude entries (op datum-prefix van `at`). */
      const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 86400000).toISOString().slice(0, 10);
      for (const [sku, v] of Object.entries(bySku)) {
        const day = String(v.at || '').slice(0, 10);
        if (day && day < cutoff) delete bySku[sku];
      }
      return { bySku, updatedAt: new Date().toISOString(), count: Object.keys(bySku).length };
    },
    { fallback: { bySku: {}, updatedAt: null }, cacheMaxAge: 0 }
  );
}
