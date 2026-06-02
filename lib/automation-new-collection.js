/**
 * lib/automation-new-collection.js
 *
 * Slimme automation: "nieuwe collectie online" → mail naar klanten die eerder
 * iets uit diezelfde hoofdgroep kochten ÉN van wie we hun maat op voorraad
 * hebben. Persoonlijk: verstuurd vanaf de winkel waar de klant zich inschreef
 * (denhaag@mail.gents.nl).
 *
 * Datajoin:
 *   - nieuwe producten = Shopify-cache met recente createdAt (per hoofdgroep,
 *     met de maten die op voorraad zijn).
 *   - klant-koophistorie = SRS-transacties; sku → Shopify-cache geeft hoofdgroep
 *     + maat (SRS-regels bevatten zelf geen hoofdgroep/maat).
 *   - voorraad per maat = SRS-voorraad per sku.
 *
 * Verstuurt ALLEEN bij dryRun=false; de cron draait alleen als enabled. Per run
 * een gemaximeerd aantal klanten (SOAP-calls), met voortgang per campagne zodat
 * opeenvolgende runs de hele basis doorlopen. Idempotent via een sent-map.
 */

import { getCustomers, getTransactions } from './srs-customers-client.js';
import { readProductsCache } from './shopify-products-cache.js';
import { readVoorraadRows } from './srs-voorraad-store.js';
import { branchIdToStoreName } from './business-config.js';
import { getStoreSenderConfig, storeFromAddress, storeReplyTo } from './resend-sender.js';
import { sendGentsMail } from './resend-mailer.js';
import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';
import { emailShell, productCard } from './automations-core.js';
import { getEmailTheme } from './email-template-store.js';

const CONFIG_PATH = 'marketing/automation-new-collection.json';
const DEFAULTS = {
  enabled: false,
  newDays: 21,          // product createdAt-venster
  lookbackDays: 540,    // koophistorie-venster
  minStock: 1,
  maxPerRun: 80,        // klanten per run (SOAP-calls)
  maxRecs: 3,           // producten per mail
  subject: 'Nieuw binnen in jouw maat',
  processed: { key: '', emails: {} }, // voortgang per campagne
  sent: {},             // email -> { key, ts }
  lastRun: null,
  lastResult: null
};

const clean = (v) => String(v == null ? '' : v).trim();
const lc = (v) => clean(v).toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEmail = (e) => { const s = lc(e); return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : ''; };
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function djb2(str) { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0; return h.toString(36); }

export async function getNcConfig() {
  const c = await readJsonBlob(CONFIG_PATH, null).catch(() => null);
  return { ...DEFAULTS, ...(c || {}), processed: { ...DEFAULTS.processed, ...(c && c.processed || {}) } };
}
export async function saveNcConfig(patch = {}) {
  const cur = await getNcConfig();
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  await writeJsonBlob(CONFIG_PATH, next);
  return next;
}

/* sku(lc) → totale (positieve) voorraad over alle filialen. */
function buildStockBySku(rows) {
  const m = new Map();
  for (const r of (rows || [])) {
    const sku = lc(r.sku);
    if (!sku) continue;
    const v = Number(r.voorraad) || 0;
    if (v > 0) m.set(sku, (m.get(sku) || 0) + v);
  }
  return m;
}

/* Nieuwe producten (recente createdAt), gegroepeerd per hoofdgroep, met alleen
   de maten die nog op voorraad zijn. */
function buildNewProducts(cache, stockBySku, { newDays, minStock }) {
  const cutoff = Date.now() - newDays * 86400000;
  const byProduct = new Map();
  for (const v of Object.values(cache.bySku || {})) {
    if (!v.createdAt || Date.parse(v.createdAt) < cutoff) continue;
    const hg = clean(v.hoofdgroepOmschrijving || v.hoofdgroep);
    if (!hg) continue;
    const sku = lc(v.sku);
    const stock = stockBySku.get(sku) || 0;
    if (stock < minStock) continue;
    const size = clean(v.size);
    const pid = v.productId || v.productHandle || v.title;
    if (!byProduct.has(pid)) {
      byProduct.set(pid, {
        productId: v.productId || '', title: v.title || 'Nieuw item', url: v.productUrl || '',
        image: v.image || (Array.isArray(v.images) ? v.images[0] : '') || '',
        hoofdgroep: hg, hgKey: lc(hg), sizes: new Set(), createdAt: v.createdAt
      });
    }
    if (size) byProduct.get(pid).sizes.add(size);
  }
  const products = Array.from(byProduct.values()).map((p) => ({ ...p, sizes: Array.from(p.sizes) }));
  const byHg = new Map();
  for (const p of products) { if (!byHg.has(p.hgKey)) byHg.set(p.hgKey, []); byHg.get(p.hgKey).push(p); }
  const key = products.length ? 'nc-' + djb2(products.map((p) => p.productId).sort().join(',')) : '';
  return { products, byHg, key };
}

/* Koopprofiel: hoofdgroep(lc) → set maten, uit transacties (via cache-lookup). */
function buildProfile(transactions, lookup, lookbackDays) {
  const cutoff = Date.now() - lookbackDays * 86400000;
  const byHg = new Map();
  for (const t of (transactions || [])) {
    if (t.dateTime && Date.parse(t.dateTime) < cutoff) continue;
    for (const it of (t.items || [])) {
      const v = lookup(lc(it.sku));
      if (!v) continue;
      const hgKey = lc(v.hoofdgroepOmschrijving || v.hoofdgroep);
      if (!hgKey) continue;
      if (!byHg.has(hgKey)) byHg.set(hgKey, new Set());
      const size = clean(v.size);
      if (size) byHg.get(hgKey).add(size);
    }
  }
  return byHg;
}

/* Aanbevelingen: nieuwe producten in een gekochte hoofdgroep, in de maat van de
   klant (die op voorraad is). */
function matchRecommendations(profile, byHg, maxRecs) {
  const out = [];
  for (const [hgKey, sizeSet] of profile.entries()) {
    const candidates = byHg.get(hgKey);
    if (!candidates) continue;
    for (const p of candidates) {
      const matched = p.sizes.filter((s) => sizeSet.has(s));
      if (matched.length) out.push({ ...p, matchedSizes: matched });
      if (out.length >= maxRecs) break;
    }
    if (out.length >= maxRecs) break;
  }
  /* dedupe op productId */
  const seen = new Set();
  return out.filter((p) => (seen.has(p.productId) ? false : (seen.add(p.productId), true))).slice(0, maxRecs);
}

function buildEmail({ firstName, store, recs, unsubscribe, theme }) {
  const body = `<p style="margin:0 0 16px">Er is nieuwe collectie binnen die past bij wat je eerder bij ons koos — en we hebben jouw maat nog op voorraad. Een kleine voorsprong, speciaal voor jou:</p>`
    + recs.map((p) => productCard({ title: p.title, image: p.image, url: p.url, matchedSizes: p.matchedSizes }, theme)).join('');
  return emailShell({ store, firstName, theme, bodyHtml: body, footer: unsubscribe ? `<a href="${esc(unsubscribe)}" style="color:#999">Afmelden</a>.` : '' });
}

/**
 * @param {object} opts { dryRun=true, limit }
 */
export async function runNewCollection({ dryRun = true, limit } = {}) {
  const cfg = await getNcConfig();
  const cap = Math.max(1, Number(limit || cfg.maxPerRun || 80));

  const [cache, voorraad] = await Promise.all([readProductsCache(), readVoorraadRows().catch(() => ({ rows: [] }))]);
  const rows = Array.isArray(voorraad) ? voorraad : (voorraad?.rows || []);
  const stockBySku = buildStockBySku(rows);
  const { products, byHg, key } = buildNewProducts(cache, stockBySku, { newDays: cfg.newDays, minStock: cfg.minStock });

  if (!products.length) {
    return { ok: true, dryRun, campaignKey: '', newProducts: 0, candidates: 0, message: `Geen nieuwe producten met voorraad in de laatste ${cfg.newDays} dagen.` };
  }
  const lookup = (sku) => (cache.bySku && cache.bySku[sku]) || (cache.byBarcode && cache.byBarcode[sku]) || null;

  /* Voortgang per campagne — bij een nieuwe drop opnieuw beginnen. */
  let processed = cfg.processed && cfg.processed.key === key ? { ...cfg.processed } : { key, emails: {} };
  const sent = { ...(cfg.sent || {}) };

  const [senderCfg, theme] = await Promise.all([getStoreSenderConfig(), getEmailTheme()]);
  const candidates = [];
  let scanned = 0, processedNow = 0, pushed = 0, errors = 0;
  const perStore = {};

  /* Paginaal door opt-in klanten, sla al-verwerkte over. */
  outer:
  for (let page = 1; page <= 60 && processedNow < cap; page++) {
    let batch;
    try { batch = await getCustomers({ page, pageSize: 500 }); } catch (_) { break; }
    const custRows = Array.isArray(batch) ? batch : (batch?.customers || batch?.rows || []);
    if (!custRows.length) break;
    for (const c of custRows) {
      if (processedNow >= cap) break outer;
      const allow = c.allowMailings === true || lc(c.allowMailings) === 'true';
      const email = cleanEmail(c.email);
      if (!allow || !email) continue;
      if (processed.emails[email] || sent[email]) continue;
      scanned++;
      processed.emails[email] = Date.now();
      processedNow++;

      let recs = [];
      try {
        const tr = await getTransactions({ customerId: c.customerId });
        const transactions = (tr && (tr.transactions || tr)) || [];
        const profile = buildProfile(transactions, lookup, cfg.lookbackDays);
        recs = matchRecommendations(profile, byHg, cfg.maxRecs);
      } catch (_) { /* klant zonder historie / SOAP-fout → overslaan */ }

      if (!recs.length) continue;
      const store = branchIdToStoreName(c.registeredInBranchId) || '';
      perStore[store || 'Onbekend'] = (perStore[store || 'Onbekend'] || 0) + 1;
      const cand = { email, firstName: clean(c.firstName), store, recs };
      candidates.push(cand);

      if (!dryRun) {
        try {
          await sendGentsMail({
            to: email,
            subject: cfg.subject,
            html: buildEmail({ firstName: cand.firstName, store, recs, theme, unsubscribe: `mailto:afmelden@${senderCfg.domain}?subject=Afmelden` }),
            from: storeFromAddress(store, senderCfg),
            replyTo: storeReplyTo(store, senderCfg),
            headers: { 'List-Unsubscribe': `<mailto:afmelden@${senderCfg.domain}>` },
            type: 'automation-nieuwe-collectie',
            store,
            meta: { automation: 'nieuwe-collectie', campaignKey: key, recs: recs.map((r) => r.productId) }
          });
          sent[email] = { key, ts: Date.now() };
          pushed++;
          await sleep(200);
        } catch (_) { errors++; }
      }
    }
    if (custRows.length < 500) break;
  }

  const result = {
    ok: true, dryRun, campaignKey: key, newProducts: products.length,
    scanned, candidates: candidates.length, pushed, errors, perStore,
    sample: candidates.slice(0, 8).map((c) => ({ email: c.email, store: c.store, items: c.recs.map((r) => `${r.title} (${r.matchedSizes.join('/')})`) }))
  };

  if (!dryRun) {
    await saveNcConfig({ processed, sent, lastRun: new Date().toISOString(), lastResult: result });
  }
  return result;
}
