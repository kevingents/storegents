/**
 * /api/admin/derving
 *
 * Derving-monitor onder Voorraad. Combineert drie beelden:
 *   1. meldingen  — voorraad-correcties die als derving tellen (bestemming
 *                   afkeur/herstel óf een derving-reden), met winkel-herkomst,
 *                   reden, aantal en status. Dé herkomst-bron.
 *   2. bak        — SRS-voorraad die nu op 708 (afkeur, weg) en 707 (klachten/
 *                   herstel, komt terug) ligt — puur als telling/controle.
 *   3. onverklaard— wat op 708/707 ligt zónder bijbehorende melding = blinde
 *                   derving (alarmsignaal).
 *
 *   GET                       → { meldingen, bak, onverklaard, samenvatting }
 *   POST ?action=set-herstel-status { id, status } → herstel-status zetten
 *
 * Auth: admin-token vereist.
 */

import {
  listRequests, setHerstelStatus, getReasonLabel,
  DERVING_BESTEMMINGEN, HERSTEL_STATUSES
} from '../../lib/stock-corrections-store.js';
import { readVoorraadRows } from '../../lib/srs-voorraad-store.js';
import { readProductsCache } from '../../lib/shopify-products-cache.js';
import { getStoreNameByBranchId } from '../../lib/branch-metrics.js';
import { readDragers } from '../../lib/srs-dragers-import.js';
import { readDragersHistory } from '../../lib/srs-dragers-history-store.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

const clean = (v) => String(v == null ? '' : v).trim();
const lc = (v) => clean(v).toLowerCase();
const BAK = { 708: 'Afkeur / derving', 707: 'Klachten / herstel' };

/* Herkomst-attributie uit de verplaatsingen (dragers): welke winkel stuurde
   voorraad naar afkeur (708) of herstel (707). Combineert lopende dragers met
   de history (afgesloten dragers, rolling 365 dagen). Geeft de retroactieve
   herkomst die de derving-meldingen missen. */
function buildHerkomst(openList, closedList) {
  const map = new Map();
  const add = (d, isOpen) => {
    const best = clean(d.bestemming);
    if (best !== '708' && best !== '707') return;
    const hk = clean(d.herkomst) || '?';
    let e = map.get(hk);
    if (!e) {
      e = { filiaal: hk, store: clean(d.herkomstNaam) || getStoreNameByBranchId(hk) || `Filiaal ${hk}`,
        afkeurStuks: 0, afkeurDragers: 0, herstelStuks: 0, herstelDragers: 0, lopend: 0, afgesloten: 0 };
      map.set(hk, e);
    }
    const stuks = Number(d.regels) || 0;
    if (best === '708') { e.afkeurStuks += stuks; e.afkeurDragers += 1; }
    else { e.herstelStuks += stuks; e.herstelDragers += 1; }
    if (isOpen) e.lopend += 1; else e.afgesloten += 1;
  };
  for (const d of (openList || [])) add(d, true);
  for (const d of (closedList || [])) add(d, false);
  return [...map.values()]
    .map((e) => ({ ...e, totaalStuks: e.afkeurStuks + e.herstelStuks, totaalDragers: e.afkeurDragers + e.herstelDragers }))
    .sort((a, b) => b.totaalStuks - a.totaalStuks);
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

function piecesOf(request) {
  let n = 0;
  for (const a of (request.articles || [])) for (const s of (a.sizes || [])) n += Math.abs(Number(s.count) || 0);
  return n;
}

/* Verzamel alle gemelde SKU's/barcodes (voor onverklaard-match). */
function reportedSkus(requests) {
  const set = new Set();
  for (const r of requests) {
    for (const a of (r.articles || [])) {
      if (a.sku) set.add(lc(a.sku));
      if (a.barcode) set.add(lc(a.barcode));
      for (const s of (a.sizes || [])) { if (s.sku) set.add(lc(s.sku)); if (s.barcode) set.add(lc(s.barcode)); }
    }
  }
  return set;
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    if (req.method === 'POST') {
      const action = clean(req.query?.action);
      const body = parseBody(req);
      if (action === 'set-herstel-status') {
        const updated = await setHerstelStatus(clean(body.id), clean(body.status), body.actor || { name: 'admin' });
        return res.status(200).json({ success: true, request: updated });
      }
      return res.status(400).json({ success: false, message: `Onbekende actie: ${action}` });
    }

    const from = clean(req.query?.from);
    const to = clean(req.query?.to);
    const [requests, voorraadRows, cache, dragersSnap, dragersHist] = await Promise.all([
      listRequests({ derving: true, from: from || undefined, to: to || undefined }).catch(() => []),
      readVoorraadRows().catch(() => []),
      readProductsCache().catch(() => null),
      readDragers().catch(() => ({ list: [] })),
      readDragersHistory().catch(() => ({ closed: [] }))
    ]);
    const byBarcode = cache?.byBarcode || {};
    const info = (sku) => byBarcode[lc(sku)] || {};

    /* ── 1. Meldingen ── */
    const byStore = {}, byReason = {}, byStatus = {}, byBestemming = { afkeur: 0, herstel: 0, overig: 0 };
    const meldingen = requests.map((r) => {
      const stuks = piecesOf(r);
      const storeKey = r.store || 'onbekend';
      byStore[storeKey] = byStore[storeKey] || { store: storeKey, meldingen: 0, stuks: 0, afkeur: 0, herstel: 0 };
      byStore[storeKey].meldingen += 1;
      byStore[storeKey].stuks += stuks;
      byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      const best = clean(r.bestemming) || 'overig';
      byBestemming[best] = (byBestemming[best] || 0) + 1;
      if (best === 'afkeur') byStore[storeKey].afkeur += stuks;
      if (best === 'herstel') byStore[storeKey].herstel += stuks;
      const redenen = [...new Set((r.articles || []).map((a) => a.reasonCode).filter(Boolean))];
      for (const code of redenen) byReason[code] = (byReason[code] || 0) + 1;
      return {
        id: r.id,
        requestNumber: r.requestNumber,
        store: r.store,
        door: r.requestedBy?.name || '—',
        datum: r.requestedAt || r.createdAt,
        status: r.status,
        bestemming: clean(r.bestemming),
        herstelStatus: clean(r.herstelStatus),
        redenen: redenen.map((c) => ({ code: c, label: getReasonLabel(c) })),
        artikelen: (r.articles || []).map((a) => ({
          title: a.title || a.sku || a.barcode, sku: a.sku, color: a.color,
          stuks: (a.sizes || []).reduce((n, s) => n + Math.abs(Number(s.count) || 0), 0)
        })),
        stuks
      };
    });

    /* ── 2. De bak (708 + 707) ── */
    const bak = {};
    for (const k of Object.keys(BAK)) bak[k] = { filiaal: k, label: BAK[k], stuks: 0, regels: 0, items: [] };
    for (const r of (voorraadRows || [])) {
      const fil = clean(r.filiaalNummer);
      if (!bak[fil]) continue;
      const v = Number(r.voorraad) || 0;
      if (v === 0) continue;
      const i = info(r.sku);
      bak[fil].regels += 1;
      bak[fil].stuks += v;
      bak[fil].items.push({
        sku: r.sku,
        title: clean(i.title) || r.sku,
        article: clean(i.articleNumber),
        size: clean(i.size),
        color: clean(i.color),
        voorraad: v
      });
    }
    for (const k of Object.keys(bak)) bak[k].items.sort((a, b) => b.voorraad - a.voorraad).splice(300);
    const bakAvailable = (voorraadRows || []).some((r) => bak[clean(r.filiaalNummer)]);

    /* ── 3. Onverklaard: op de bak maar nooit gemeld ── */
    const reported = reportedSkus(requests);
    const onverklaard = [];
    for (const k of Object.keys(bak)) {
      for (const it of bak[k].items) {
        if (!reported.has(lc(it.sku))) onverklaard.push({ ...it, filiaal: k, bakLabel: BAK[k] });
      }
    }
    onverklaard.sort((a, b) => b.voorraad - a.voorraad);

    /* ── 4. Herkomst uit verplaatsingen (welke winkel stuurde naar 708/707) ── */
    const openDragers = dragersSnap?.list || [];
    const closedDragers = dragersHist?.closed || [];
    const herkomstRows = buildHerkomst(openDragers, closedDragers);
    const historyVanaf = closedDragers.reduce((min, c) => (c.closedAt && (!min || c.closedAt < min)) ? c.closedAt : min, null);

    return res.status(200).json({
      success: true,
      generatedAt: new Date().toISOString(),
      bestemmingen: DERVING_BESTEMMINGEN,
      herstelStatuses: HERSTEL_STATUSES,
      meldingen: {
        total: meldingen.length,
        stuks: meldingen.reduce((n, m) => n + m.stuks, 0),
        byStore: Object.values(byStore).sort((a, b) => b.stuks - a.stuks),
        byReason: Object.entries(byReason).map(([code, n]) => ({ code, label: getReasonLabel(code), meldingen: n })).sort((a, b) => b.meldingen - a.meldingen),
        byStatus,
        byBestemming,
        list: meldingen.slice(0, 300)
      },
      bak: {
        available: bakAvailable,
        filialen: Object.values(bak),
        stuks: Object.values(bak).reduce((n, b) => n + b.stuks, 0)
      },
      onverklaard: {
        total: onverklaard.length,
        stuks: onverklaard.reduce((n, x) => n + x.voorraad, 0),
        items: onverklaard.slice(0, 300)
      },
      herkomst: {
        beschikbaar: (openDragers.length + closedDragers.length) > 0,
        rows: herkomstRows,
        totaalStuks: herkomstRows.reduce((n, r) => n + r.totaalStuks, 0),
        totaalAfkeur: herkomstRows.reduce((n, r) => n + r.afkeurStuks, 0),
        totaalHerstel: herkomstRows.reduce((n, r) => n + r.herstelStuks, 0),
        lopend: openDragers.filter((d) => d.bestemming === '708' || d.bestemming === '707').length,
        historyVanaf
      }
    });
  } catch (e) {
    console.error('[admin/derving]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
