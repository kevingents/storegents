/**
 * lib/srs-retail-import.js
 *
 * Haalt de nieuwste klantentellers_*.csv.gz + verkopen_*.csv.gz van de SRS
 * data-export SFTP, unzipt, parsed en bouwt een winkelprestatie-snapshot
 * (bezoekers × bonnen × omzet × conversie) per FYSIEK filiaal.
 *
 * Bestandsformaat (semicolon-gescheiden, met kopregel):
 *   klantentellers: filiaal_nummer;afdeling_nummer;datum;starttijd;eindtijd;aantal_in;aantal_uit
 *   verkopen:       bon_nummer;filiaal_nummer;afdeling_nummer;datum;tijd;...;verkoop_soort;...;
 *                   sku_code;...;aantal;kostprijs;gecalculeerde_prijs;gerealiseerd_bedrag;...
 *
 * Bedragen in verkopen staan in CENTEN; retouren staan als negatieve bedragen.
 * We rekenen op één gemeenschappelijk venster (laatste N dagen) zodat de
 * conversie (bonnen ÷ bezoekers) appels-met-appels is. Webshop/showroom/
 * magazijn vallen buiten 'fysieke winkels' en worden genegeerd.
 */

import zlib from 'node:zlib';
import { withSftp } from './srs-dataexport-sftp-client.js';
import { listBranches, getStoreNameByBranchId } from './branch-metrics.js';
import { writeRetailPerformance } from './srs-retail-store.js';
import { readVoorraadRows } from './srs-voorraad-store.js';
import { readProductsCache } from './shopify-products-cache.js';
import { computeVoorraadAdvies, VOORRAAD_ADVIES_PATH } from './voorraad-advies.js';
import { writeJsonBlob } from './json-blob-store.js';
import { mergeLedger } from './srs-retail-ledger.js';
import { mergeProductCost } from './product-cost-store.js';

const DEFAULT_WINDOW_DAYS = 14;

/* ── CSV-parser (semicolon, dubbele-quotes) ─────────────────────────────── */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false; }
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ';') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return { header: [], rows: [] };
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const obj = {};
    header.forEach((h, idx) => { obj[h] = (cells[idx] ?? '').trim(); });
    rows.push(obj);
  }
  return rows;
}

function gunzipToText(buffer) {
  return zlib.gunzipSync(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)).toString('utf8');
}

function toInt(v) {
  const n = parseInt(String(v ?? '').replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

/* 'to'-datum uit <type>_<from>_<to>.csv.gz */
function fileToDate(name) {
  const m = String(name).match(/_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.csv\.gz$/i);
  return m ? m[2] : '';
}

/* Zoek recursief (binnen 1 sessie) het nieuwste bestand dat met `prefix` begint. */
async function findLatest(sftp, basePath, prefix, maxDepth = 3) {
  const found = [];
  const want = prefix.toLowerCase();
  async function walk(dir, depth) {
    let entries;
    try { entries = await sftp.list(dir); } catch { return; }
    for (const e of entries) {
      const full = (dir === '/' ? '' : dir) + '/' + e.name;
      if (e.type === 'd') { if (depth < maxDepth) await walk(full, depth + 1); continue; }
      const n = e.name.toLowerCase();
      if (n.startsWith(want) && n.endsWith('.csv.gz')) found.push({ name: e.name, path: full, modifyTime: e.modifyTime });
    }
  }
  await walk(basePath === '/' ? '/' : basePath, 0);
  if (!found.length) return null;
  const mtime = (v) => (typeof v === 'number' ? v : (Number.isFinite(Date.parse(v)) ? Date.parse(v) : 0));
  found.sort((a, b) => {
    const da = fileToDate(a.name), db = fileToDate(b.name);
    if (da && db && da !== db) return db.localeCompare(da);
    return mtime(b.modifyTime) - mtime(a.modifyTime);
  });
  return found[0];
}

/* datum (YYYY-MM-DD) − dagen → YYYY-MM-DD */
function minusDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

/**
 * Bouw + schrijf de winkelprestatie-snapshot.
 * @returns het snapshot-object (ook weggeschreven naar de blob).
 */
export async function importRetailPerformance({ remotePath = '/Dataexport', windowDays = DEFAULT_WINDOW_DAYS } = {}) {
  const { tellersFile, tellersBuf, verkopenFile, verkopenBuf } = await withSftp(async (sftp) => {
    const tf = await findLatest(sftp, remotePath, 'klantentellers');
    const vf = await findLatest(sftp, remotePath, 'verkopen');
    return {
      tellersFile: tf, tellersBuf: tf ? await sftp.get(tf.path) : null,
      verkopenFile: vf, verkopenBuf: vf ? await sftp.get(vf.path) : null
    };
  });
  if (!tellersFile) throw new Error('Geen klantentellers_*.csv.gz gevonden op de SFTP.');
  if (!verkopenFile) throw new Error('Geen verkopen_*.csv.gz gevonden op de SFTP.');

  const tellers = parseCsv(gunzipToText(tellersBuf));
  const verkopen = parseCsv(gunzipToText(verkopenBuf));

  /* Alleen fysieke winkels (geen webshop/showroom/magazijn). */
  const physical = new Set(listBranches({ includeInternal: false }).map((b) => String(b.branchId)));

  /* Gemeenschappelijk venster: laatste N dagen t/m de nieuwste teller-datum. */
  let maxDate = '';
  for (const r of tellers) { const d = r.datum || ''; if (d > maxDate) maxDate = d; }
  if (!maxDate) throw new Error('Klantentellers bevat geen datums.');
  const fromDate = minusDays(maxDate, windowDays - 1);
  const inWindow = (d) => d >= fromDate && d <= maxDate;

  /* Per filiaal accumuleren. */
  const acc = new Map();
  const ensure = (fil) => {
    if (!acc.has(fil)) acc.set(fil, { bezoekers: 0, omzetCents: 0, bonnen: new Set() });
    return acc.get(fil);
  };
  const dayMap = new Map(); /* datum → { bezoekers, omzetCents } */
  const ensureDay = (d) => {
    if (!dayMap.has(d)) dayMap.set(d, { bezoekers: 0, omzetCents: 0 });
    return dayMap.get(d);
  };

  /* Bezoekers (aantal_in) per filiaal/dag. */
  for (const r of tellers) {
    const fil = String(r.filiaal_nummer || '').trim();
    const datum = String(r.datum || '').trim();
    if (!physical.has(fil) || !inWindow(datum)) continue;
    const inn = toInt(r.aantal_in);
    ensure(fil).bezoekers += inn;
    ensureDay(datum).bezoekers += inn;
  }

  /* Omzet (netto, incl. retouren) + bonnen per filiaal/dag. */
  for (const r of verkopen) {
    const fil = String(r.filiaal_nummer || '').trim();
    const datum = String(r.datum || '').trim();
    if (!physical.has(fil) || !inWindow(datum)) continue;
    const bedragCents = toInt(r.gerealiseerd_bedrag);
    const a = ensure(fil);
    a.omzetCents += bedragCents;
    ensureDay(datum).omzetCents += bedragCents;
    /* Bon = afgerekende transactie: tel unieke bon_nummers met een échte verkoopregel. */
    const soort = String(r.verkoop_soort || '').toLowerCase();
    if (soort === 'verkoop' && bedragCents > 0) a.bonnen.add(String(r.bon_nummer || ''));
  }

  /* Filialen die in één van beide bronnen voorkomen. */
  const filialen = [...acc.entries()].map(([filiaalNummer, x]) => {
    const omzet = round2(x.omzetCents / 100);
    const bonnen = x.bonnen.size;
    const bezoekers = x.bezoekers;
    const heeftTeller = bezoekers > 0;
    return {
      filiaalNummer,
      store: getStoreNameByBranchId(filiaalNummer),
      bezoekers,
      bonnen,
      omzet,
      conversie: heeftTeller ? round1((bonnen / bezoekers) * 100) : null,
      gemBesteding: bonnen ? round2(omzet / bonnen) : 0,
      heeftTeller
    };
  }).filter((f) => f.bezoekers || f.bonnen || f.omzet)
    .sort((a, b) => b.omzet - a.omzet);

  const totBez = filialen.reduce((n, f) => n + f.bezoekers, 0);
  const totBon = filialen.reduce((n, f) => n + f.bonnen, 0);
  const totOmz = round2(filialen.reduce((n, f) => n + f.omzet, 0));
  const totBezConv = filialen.reduce((n, f) => n + (f.heeftTeller ? f.bezoekers : 0), 0);
  const totBonConv = filialen.reduce((n, f) => n + (f.heeftTeller ? f.bonnen : 0), 0);

  const days = [...dayMap.entries()]
    .map(([datum, x]) => ({ datum, bezoekers: x.bezoekers, omzet: round2(x.omzetCents / 100) }))
    .sort((a, b) => a.datum.localeCompare(b.datum));

  const snapshot = {
    refreshedAt: new Date().toISOString(),
    window: { from: fromDate, to: maxDate, dagen: windowDays },
    sources: { tellers: tellersFile.name, verkopen: verkopenFile.name },
    totals: {
      bezoekers: totBez,
      bonnen: totBon,
      omzet: totOmz,
      conversie: totBezConv ? round1((totBonConv / totBezConv) * 100) : null,
      gemBesteding: totBon ? round2(totOmz / totBon) : 0,
      winkels: filialen.length
    },
    filialen,
    days
  };

  await writeRetailPerformance(snapshot);

  /* Dagelijkse ledger (per filiaal per datum, ÁLLE datums in de export) zodat het
     dashboard elke periode kan tonen. Additief — fout mag niets breken. */
  try {
    const ld = {};
    const ensureLD = (fil, date) => {
      (ld[fil] = ld[fil] || {});
      (ld[fil][date] = ld[fil][date] || { netCents: 0, grossCents: 0, refundCents: 0, grossItems: 0, refundItems: 0, bonnen: new Set(), refundBonnen: new Set(), bezoekers: 0 });
      return ld[fil][date];
    };
    for (const r of tellers) {
      const fil = String(r.filiaal_nummer || '').trim();
      const datum = String(r.datum || '').trim();
      if (!physical.has(fil) || !datum) continue;
      ensureLD(fil, datum).bezoekers += toInt(r.aantal_in);
    }
    for (const r of verkopen) {
      const fil = String(r.filiaal_nummer || '').trim();
      const datum = String(r.datum || '').trim();
      if (!physical.has(fil) || !datum) continue;
      const cents = toInt(r.gerealiseerd_bedrag);
      const qty = Math.abs(toInt(r.aantal));
      const bon = String(r.bon_nummer || '');
      const e = ensureLD(fil, datum);
      e.netCents += cents;
      if (cents >= 0) { e.grossCents += cents; e.grossItems += qty; if (String(r.verkoop_soort || '').toLowerCase() === 'verkoop' && cents > 0) e.bonnen.add(bon); }
      else { e.refundCents += -cents; e.refundItems += qty; e.refundBonnen.add(bon); }
    }
    const merge = {};
    for (const [fil, days] of Object.entries(ld)) {
      merge[fil] = {};
      for (const [date, v] of Object.entries(days)) {
        merge[fil][date] = {
          omzet: round2(v.netCents / 100),
          gross: round2(v.grossCents / 100),
          refund: round2(v.refundCents / 100),
          bonnen: v.bonnen.size,
          refundBonnen: v.refundBonnen.size,
          grossItems: v.grossItems,
          refundItems: v.refundItems,
          bezoekers: v.bezoekers
        };
      }
    }
    await mergeLedger(merge);
  } catch (e) {
    console.error('[srs-retail-import] ledger-merge faalde:', e.message);
  }

  /* Inkoopprijs per EAN uit de verkopen (kolom kostprijs, ex-BTW) → POAS-feed.
     Houd de nieuwste verkoopregel per EAN aan. Additief — fout breekt niets. */
  try {
    const cost = {};
    for (const r of verkopen) {
      if (String(r.verkoop_soort || '').toLowerCase() !== 'verkoop') continue;
      const sku = String(r.sku_code || '').trim();
      const kostCents = toInt(r.kostprijs);
      if (!sku || kostCents <= 0) continue;
      const at = `${String(r.datum || '').trim()} ${String(r.tijd || '').trim()}`.trim();
      const prev = cost[sku];
      if (!prev || at >= prev.at) {
        cost[sku] = {
          kostprijs: round2(kostCents / 100),
          sell: round2(toInt(r.gecalculeerde_prijs) / 100),
          btw: Number(String(r.btw_percentage || '21').replace(',', '.')) || 21,
          at
        };
      }
    }
    if (Object.keys(cost).length) await mergeProductCost(cost);
  } catch (e) {
    console.error('[srs-retail-import] product-cost faalde:', e.message);
  }

  /* Rijk voorraad-advies (verkopen ⋈ voorraad ⋈ productcache → maat). Additief:
     een fout hier mag de winkelprestatie-snapshot niet ongedaan maken. */
  try {
    const [voorraadRows, cache] = await Promise.all([
      readVoorraadRows().catch(() => []),
      readProductsCache().catch(() => null)
    ]);
    if (Array.isArray(voorraadRows) && voorraadRows.length) {
      const advies = computeVoorraadAdvies({
        verkopen,
        voorraadRows,
        byBarcode: cache?.byBarcode || {},
        physical,
        window: { from: fromDate, to: maxDate },
        windowDays
      });
      await writeJsonBlob(VOORRAAD_ADVIES_PATH, advies);
      snapshot.adviesFilialen = advies.filialen.length;
    }
  } catch (e) {
    console.error('[srs-retail-import] voorraad-advies faalde:', e.message);
  }

  return snapshot;
}
