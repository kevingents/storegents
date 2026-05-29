/**
 * lib/mixmatch-store.js
 *
 * Opslag van zelf samengestelde Mix & Match-pakketten (custom bundles). De
 * portal is de "control tower": hier definieer je pakketten (welke artikelen,
 * 2- of 3-delig, prijsregel, tags, status). Het daadwerkelijk verkoopbaar maken
 * op de webshop (Shopify Functions/cart-transform) is een aparte fase die deze
 * definities als bron gebruikt.
 *
 * Blob: mixmatch/pakketten.json → { pakketten: [...], updatedAt }.
 *
 * Pakket-shape:
 *   {
 *     id, naam, status: 'concept'|'actief',
 *     type: '2-delig'|'3-delig',
 *     code,                       // gedeelde pak-code (artikel_id-suffix), optioneel
 *     categorie,                  // vrij label, bv. "Business" / "Casual"
 *     components: [{ role, artikelId, productId, title, image }],
 *     prijsType: 'som'|'vast'|'korting',
 *     prijsWaarde,                // bij 'vast' = bedrag, bij 'korting' = % of €
 *     tags: ['2-delig', ...],
 *     createdAt, updatedAt, updatedBy
 *   }
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';
import { readProductsCache } from './shopify-products-cache.js';

const PATH = 'mixmatch/pakketten.json';
const clean = (v) => String(v == null ? '' : v).trim();
const lc = (v) => clean(v).toLowerCase();

function genId() {
  return (globalThis.crypto?.randomUUID)
    ? globalThis.crypto.randomUUID()
    : `mm-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

const VALID_STATUS = new Set(['concept', 'actief']);
const VALID_TYPE = new Set(['2-delig', '3-delig']);
const VALID_PRIJS = new Set(['som', 'vast', 'korting']);

export async function readPakketten() {
  const d = await readJsonBlob(PATH, { pakketten: [], updatedAt: null });
  const list = Array.isArray(d?.pakketten) ? d.pakketten : [];
  return { pakketten: list, updatedAt: d?.updatedAt || null };
}

export async function getPakket(id) {
  const { pakketten } = await readPakketten();
  return pakketten.find((p) => p.id === id) || null;
}

/** Normaliseer + valideer een (deel-)pakket. Gooit Error bij ongeldige input. */
function normalizePakket(input = {}, existing = null) {
  const naam = clean(input.naam);
  if (!naam) throw new Error('Naam is verplicht.');

  const components = Array.isArray(input.components) ? input.components : (existing?.components || []);
  const comps = components
    .map((c) => ({
      role: lc(c.role) || 'overig',
      artikelId: clean(c.artikelId),
      productId: clean(c.productId),
      title: clean(c.title),
      image: clean(c.image)
    }))
    .filter((c) => c.artikelId || c.productId || c.title);
  if (comps.length < 2) throw new Error('Een pakket heeft minimaal 2 artikelen nodig.');

  const type = VALID_TYPE.has(clean(input.type)) ? clean(input.type) : (comps.length >= 3 ? '3-delig' : '2-delig');
  const status = VALID_STATUS.has(lc(input.status)) ? lc(input.status) : (existing?.status || 'concept');
  const prijsType = VALID_PRIJS.has(lc(input.prijsType)) ? lc(input.prijsType) : (existing?.prijsType || 'som');
  const prijsWaarde = Number(input.prijsWaarde);

  /* Tag-set: altijd het type-label borgen (gemaakte producten krijgen die tag). */
  const tags = Array.isArray(input.tags) ? input.tags.map(clean).filter(Boolean) : (existing?.tags || []);
  if (!tags.includes(type)) tags.push(type);

  return {
    naam,
    status,
    type,
    code: clean(input.code) || existing?.code || '',
    categorie: clean(input.categorie) || existing?.categorie || '',
    components: comps,
    prijsType,
    prijsWaarde: Number.isFinite(prijsWaarde) ? prijsWaarde : (existing?.prijsWaarde ?? 0),
    tags: [...new Set(tags)]
  };
}

/* Verrijk componenten op artikel_id met productId/titel/foto uit de Shopify-
   cache, zodat handmatig getypte artikel-id's volwaardige componenten worden
   (nodig voor weergave + template-toewijzing). */
async function enrichComponents(components) {
  const comps = Array.isArray(components) ? components : [];
  if (!comps.length) return comps;
  const cache = await readProductsCache().catch(() => null);
  const byArt = cache?.bySrsArtikelId || {};
  return comps.map((c) => {
    const out = { ...c };
    const aid = lc(c.artikelId);
    if (aid && (!out.productId || !out.title || !out.image)) {
      const v = byArt[aid];
      if (v) {
        if (!out.productId) out.productId = clean(v.productId);
        if (!out.title) out.title = clean(v.title);
        if (!out.image) out.image = clean(v.image);
      }
    }
    return out;
  });
}

export async function savePakket(input = {}, updatedBy = 'admin') {
  const { pakketten } = await readPakketten();
  const now = new Date().toISOString();
  const id = clean(input.id);
  if (Array.isArray(input.components) && input.components.length) {
    input = { ...input, components: await enrichComponents(input.components) };
  }

  if (id) {
    const idx = pakketten.findIndex((p) => p.id === id);
    if (idx === -1) throw new Error('Pakket niet gevonden.');
    const merged = normalizePakket(input, pakketten[idx]);
    pakketten[idx] = { ...pakketten[idx], ...merged, id, updatedAt: now, updatedBy };
    await writeJsonBlob(PATH, { pakketten, updatedAt: now });
    return pakketten[idx];
  }

  const created = { id: genId(), ...normalizePakket(input), createdAt: now, updatedAt: now, updatedBy };
  pakketten.unshift(created);
  await writeJsonBlob(PATH, { pakketten, updatedAt: now });
  return created;
}

export async function deletePakket(id) {
  const target = clean(id);
  if (!target) throw new Error('Geen id opgegeven.');
  const { pakketten } = await readPakketten();
  const next = pakketten.filter((p) => p.id !== target);
  const removed = next.length !== pakketten.length;
  if (removed) await writeJsonBlob(PATH, { pakketten: next, updatedAt: new Date().toISOString() });
  return { removed, remaining: next.length };
}

/** Samenvatting voor de KPI-tegels. */
export function summarize(pakketten = []) {
  return {
    totaal: pakketten.length,
    actief: pakketten.filter((p) => p.status === 'actief').length,
    concept: pakketten.filter((p) => p.status === 'concept').length,
    tweedelig: pakketten.filter((p) => p.type === '2-delig').length,
    driedelig: pakketten.filter((p) => p.type === '3-delig').length,
    artikelenInPakketten: pakketten.reduce((n, p) => n + (Array.isArray(p.components) ? p.components.length : 0), 0)
  };
}
