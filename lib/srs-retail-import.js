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
import { mergeRetourRedenen, retourReason } from './retour-redenen-store.js';

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

/* Parse een SRS-getal naar een integer.
   - Bedragen staan in CENTEN (zie kopcommentaar), tellers zijn hele aantallen;
     in beide gevallen verwachten we dus een geheel getal en strippen we
     scheidingstekens (een eventuele Dutch-komma in centen is sowieso 0).
   - Negatief = minteken VOORAAN óf ACHTERAAN. Sommige ERP/locale-exports zetten
     het minteken achter het bedrag ("1250-"). De oude `parseInt(...replace([^0-9-]))`
     stopte bij de trailing `-` en gaf dan een POSITIEF getal terug → een retour
     werd als verkoop geteld en blies de omzet op. Nu detecteren we het teken
     expliciet vóór we de cijfers parsen. */
function toInt(v) {
  const s = String(v ?? '').trim();
  if (!s) return 0;
  const negative = /^-/.test(s) || /-\s*$/.test(s);
  const digits = s.replace(/[^0-9]/g, '');
  if (!digits) return 0;
  const n = parseInt(digits, 10);
  if (!Number.isFinite(n)) return 0;
  return negative ? -n : n;
}

/* Weborder-verwerking herkennen.
   Een weborder die door een (fysiek) filiaal wordt gepickt/verwerkt staat in de
   POS-verkopen-export als 'verkoop' ONDER dat filiaal, met memo "Weborder
   verwerking" (systeem-verkoper 999998). Die omzet hoort bij de WEBSHOP, niet
   bij de winkel — consistent met het SOAP-pad (orderNr → webshop). Filteren op
   de semantische memo raakt geen echte kassa-verkopen (die hebben lege/andere
   memo). */
function isWeborderRow(r = {}) {
  /* Afdeling 99 = MAGAZIJN = weborders: webshop-orders die vanuit het magazijn
     worden afgehandeld maar onder het winkelfiliaal-nummer in de export staan.
     Die horen bij de WEBSHOP, niet bij de winkelomzet. Het echte SRS-omzet-
     rapport telt afdeling 1 (winkelvloer); afdeling 99 zit daar niet in.
     Daarnaast de semantische memo-marker "Weborder verwerking". Beide → webshop. */
  if (String(r.afdeling_nummer || '').trim() === '99') return true;
  return /weborder/i.test(String(r.memo || ''));
}

/* Bouw winkel-retour-redenen (klacht/retour/ruiling/overig) uit verkopen-regels.
   Pure winkel: weborder-verwerking wordt uitgesloten. Returnt
   { days: { date: { fil: { reason: {regels,stuks,eur} } } }, details: [...] }. */
function buildRetourData(verkopen, physical) {
  const days = {};
  const details = [];
  const blankReasons = () => ({
    klacht: { regels: 0, stuks: 0, eur: 0 }, retour: { regels: 0, stuks: 0, eur: 0 },
    ruiling: { regels: 0, stuks: 0, eur: 0 }, overig: { regels: 0, stuks: 0, eur: 0 }
  });
  for (const r of verkopen) {
    const fil = String(r.filiaal_nummer || '').trim();
    const datum = String(r.datum || '').trim();
    if (!physical.has(fil) || !datum) continue;
    if (isWeborderRow(r)) continue;
    const code = String(r.retour_code || '').trim();
    const cents = toInt(r.gerealiseerd_bedrag);
    if (!code && cents >= 0) continue; /* geen retour-regel */
    const reason = retourReason(code);
    const stuks = Math.abs(toInt(r.aantal));
    const eur = Math.round(Math.abs(cents)) / 100;
    (days[datum] = days[datum] || {});
    (days[datum][fil] = days[datum][fil] || blankReasons());
    const cell = days[datum][fil][reason];
    cell.regels += 1; cell.stuks += stuks; cell.eur = round2(cell.eur + eur);
    details.push({ date: datum, fil, store: getStoreNameByBranchId(fil), reden: reason, sku: r.sku_code || '', stuks, eur: round2(eur), origBon: r.retour_bonnummer || '', bon: r.bon_nummer || '' });
  }
  return { days, details };
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
  async function walk(dir, depth, isRoot) {
    let entries;
    try {
      entries = await sftp.list(dir);
    } catch (err) {
      /* Basis-map onleesbaar = echte SFTP-storing → niet maskeren als "geen
         bestand gevonden". Een submap die faalt slaan we best-effort over zodat
         één rotte submap de hele walk niet stopt. */
      if (isRoot) throw new Error(`SFTP-map '${dir}' niet leesbaar: ${err.message || err}`);
      return;
    }
    for (const e of entries) {
      const full = (dir === '/' ? '' : dir) + '/' + e.name;
      if (e.type === 'd') { if (depth < maxDepth) await walk(full, depth + 1, false); continue; }
      const n = e.name.toLowerCase();
      if (n.startsWith(want) && n.endsWith('.csv.gz')) found.push({ name: e.name, path: full, modifyTime: e.modifyTime });
    }
  }
  await walk(basePath === '/' ? '/' : basePath, 0, true);
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
 * READ-ONLY diagnose: haal het nieuwste verkopen-bestand op en rapporteer de
 * échte kolomkoppen + uitsplitsing per verkoop_soort (rijen + bedrag) en per
 * filiaal-type (fysiek vs niet-fysiek). Zo zien we hoe pick/fulfilment-
 * weborders in de export staan — zonder iets te wijzigen of weg te schrijven.
 */
export async function diagnoseVerkopen({ remotePath = '/Dataexport', sampleSize = 5, filiaal = '', datum = '' } = {}) {
  const { verkopenFile, verkopenBuf } = await withSftp(async (sftp) => {
    const vf = await findLatest(sftp, remotePath, 'verkopen');
    return { verkopenFile: vf, verkopenBuf: vf ? await sftp.get(vf.path) : null };
  });
  if (!verkopenFile) throw new Error('Geen verkopen_*.csv.gz gevonden op de SFTP.');

  const text = gunzipToText(verkopenBuf);
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = lines.length ? parseCsvLine(lines[0]).map((h) => h.trim()) : [];
  const verkopen = parseCsv(text);
  const physical = new Set(listBranches({ includeInternal: false }).map((b) => String(b.branchId)));

  /* Uitsplitsing per verkoop_soort: aantal regels + som(gerealiseerd_bedrag). */
  const bySoort = new Map();
  /* Per kolom met lage cardinaliteit: welke distinct-waarden komen voor (max 12)? */
  const colValues = {};
  header.forEach((h) => { colValues[h] = new Set(); });

  let physicalRows = 0;
  let physicalCents = 0;
  for (const r of verkopen) {
    const soort = String(r.verkoop_soort || '(leeg)').toLowerCase();
    const cents = toInt(r.gerealiseerd_bedrag);
    const s = bySoort.get(soort) || { soort, rows: 0, cents: 0 };
    s.rows += 1; s.cents += cents;
    bySoort.set(soort, s);
    if (physical.has(String(r.filiaal_nummer || '').trim())) { physicalRows += 1; physicalCents += cents; }
    for (const h of header) {
      const set = colValues[h];
      if (set && set.size <= 12) set.add(r[h]);
    }
  }

  /* Kolommen waarvan de naam naar een order/kanaal/web verwijst — kandidaat-markers. */
  const candidateColumns = header.filter((h) => /order|web|internet|kanaal|channel|levering|afhaal|transactie|soort|herkomst|bron/i.test(h));

  /* Retour-analyse: van de RETOUR-regels (negatief bedrag bij fysiek filiaal).
     Doel: webshop-retouren die in de winkel zijn verwerkt herkennen, zodat die
     van webshop i.p.v. winkel af gaan. We splitsen per retour_code én per
     herkomst-filiaal (uit retour_bonnummer "V<fil><bon>"); een retour die naar
     een ander/weborder-filiaal verwijst is verdacht voor "webshop-retour". */
  const origFiliaal = (rb) => { const m = String(rb || '').match(/^V?(\d{3})/); return m ? String(Number(m[1])) : ''; };
  const retour = { totalRows: 0, totalEur: 0, weborderMemo: { rows: 0, eur: 0 }, geenWeborderMemo: { rows: 0, eur: 0 }, retourCodes: new Set(), sampleNonWeborder: [] };
  const byCode = new Map();   /* retour_code → { rows, cents, sample } */
  const byOrigin = new Map(); /* herkomst-filiaal → { rows, cents } (alleen waar herkomst ≠ eigen filiaal) */
  let crossStoreRows = 0, crossStoreCents = 0; /* retour waar herkomst ≠ verwerkend filiaal */
  for (const r of verkopen) {
    const fil = String(r.filiaal_nummer || '').trim();
    if (!physical.has(fil)) continue;
    const cents = toInt(r.gerealiseerd_bedrag);
    if (cents >= 0) continue; /* alleen retouren */
    retour.totalRows += 1; retour.totalEur += cents;
    const code = String(r.retour_code || '(leeg)').trim() || '(leeg)';
    if (code !== '(leeg)') retour.retourCodes.add(code);
    const c = byCode.get(code) || { code, rows: 0, cents: 0, sample: null };
    c.rows += 1; c.cents += cents; if (!c.sample) c.sample = r; byCode.set(code, c);
    const orig = origFiliaal(r.retour_bonnummer);
    if (orig && orig !== fil) {
      crossStoreRows += 1; crossStoreCents += cents;
      const o = byOrigin.get(orig) || { origin: orig, rows: 0, cents: 0 };
      o.rows += 1; o.cents += cents; byOrigin.set(orig, o);
    }
    if (isWeborderRow(r)) { retour.weborderMemo.rows += 1; retour.weborderMemo.eur += cents; }
    else { retour.geenWeborderMemo.rows += 1; retour.geenWeborderMemo.eur += cents; if (retour.sampleNonWeborder.length < 5) retour.sampleNonWeborder.push(r); }
  }

  /* Gericht: één filiaal+dag exact uitsplitsen om te lokaliseren wélke regels
     de winkelomzet opblazen t.o.v. het echte SRS-omzetrapport. Read-only. */
  let focus = null;
  const fFil = String(filiaal || '').trim();
  const fDat = String(datum || '').trim();
  if (fFil && fDat) {
    const bump = (m, key, cents) => { const e = m.get(key) || { key, rows: 0, cents: 0 }; e.rows += 1; e.cents += cents; m.set(key, e); };
    const byAfdeling = new Map(), bySoort = new Map(), byBtw = new Map(), byRekening = new Map();
    let totalCents = 0, totalRows = 0, webCents = 0, webRows = 0, nonWebCents = 0, nonWebRows = 0;
    const samples = [];
    for (const r of verkopen) {
      if (String(r.filiaal_nummer || '').trim() !== fFil) continue;
      if (String(r.datum || '').trim() !== fDat) continue;
      const cents = toInt(r.gerealiseerd_bedrag);
      totalRows += 1; totalCents += cents;
      if (isWeborderRow(r)) { webRows += 1; webCents += cents; }
      else { nonWebRows += 1; nonWebCents += cents; }
      bump(byAfdeling, 'afdeling ' + (r.afdeling_nummer ?? '(leeg)'), cents);
      bump(bySoort, String(r.verkoop_soort || '(leeg)'), cents);
      bump(byBtw, 'btw ' + (r.btw_percentage ?? '(leeg)'), cents);
      bump(byRekening, 'rek ' + (r.rekening_nummer ?? '(leeg)'), cents);
      if (samples.length < 12) samples.push(r);
    }
    const fmt = (m) => [...m.values()].map((e) => ({ key: e.key, rows: e.rows, eur: round2(e.cents / 100) })).sort((a, b) => b.eur - a.eur);
    focus = {
      filiaal: fFil, datum: fDat,
      totaalAlleRegels: round2(totalCents / 100), regels: totalRows,
      weborderUitgesloten: { rows: webRows, eur: round2(webCents / 100) },
      winkelZoalsLedgerNuTelt: round2(nonWebCents / 100), winkelRegels: nonWebRows,
      perAfdeling: fmt(byAfdeling),
      perVerkoopSoort: fmt(bySoort),
      perBtw: fmt(byBtw),
      perRekening: fmt(byRekening),
      sampleRegels: samples
    };
  }

  return {
    success: true,
    file: verkopenFile.name,
    totalRows: verkopen.length,
    focus,
    header,
    candidateColumns,
    /* distinct-waarden voor lage-cardinaliteit kolommen (handig om de marker te spotten) */
    lowCardinalityValues: Object.fromEntries(
      Object.entries(colValues)
        .filter(([, set]) => set.size > 0 && set.size <= 12)
        .map(([h, set]) => [h, [...set]])
    ),
    verkoopSoortBreakdown: [...bySoort.values()]
      .map((s) => ({ soort: s.soort, rows: s.rows, bedragEur: round2(s.cents / 100) }))
      .sort((a, b) => b.rows - a.rows),
    physicalBranches: { rows: physicalRows, bedragEur: round2(physicalCents / 100) },
    retourAnalyse: {
      totalRows: retour.totalRows,
      totalEur: round2(retour.totalEur / 100),
      metWeborderMemo: { rows: retour.weborderMemo.rows, eur: round2(retour.weborderMemo.eur / 100) },
      zonderWeborderMemo: { rows: retour.geenWeborderMemo.rows, eur: round2(retour.geenWeborderMemo.eur / 100) },
      retourCodes: [...retour.retourCodes],
      perRetourCode: [...byCode.values()]
        .map((c) => ({ code: c.code, rows: c.rows, eur: round2(c.cents / 100), sample: c.sample }))
        .sort((a, b) => a.eur - b.eur),
      crossStore: { rows: crossStoreRows, eur: round2(crossStoreCents / 100) },
      perHerkomstFiliaal: [...byOrigin.values()]
        .map((o) => ({ herkomstFiliaal: o.origin, rows: o.rows, eur: round2(o.cents / 100) }))
        .sort((a, b) => a.eur - b.eur),
      sampleZonderWeborderMemo: retour.sampleNonWeborder
    },
    sampleRows: verkopen.slice(0, Math.max(1, Math.min(20, sampleSize)))
  };
}

/* Venster-sleutel <from>_<to> uit een export-bestandsnaam. */
function fileWindowKey(name) {
  const m = String(name).match(/_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.csv\.gz$/i);
  return m ? `${m[1]}_${m[2]}` : '';
}

/* Verzamel ALLE bestanden die met `prefix` beginnen (recursief, 1 sessie). */
async function findAllFiles(sftp, basePath, prefix, maxDepth = 3) {
  const found = [];
  const want = prefix.toLowerCase();
  async function walk(dir, depth, isRoot) {
    let entries;
    try { entries = await sftp.list(dir); }
    catch (err) { if (isRoot) throw new Error(`SFTP-map '${dir}' niet leesbaar: ${err.message || err}`); return; }
    for (const e of entries) {
      const full = (dir === '/' ? '' : dir) + '/' + e.name;
      if (e.type === 'd') { if (depth < maxDepth) await walk(full, depth + 1, false); continue; }
      const n = e.name.toLowerCase();
      if (n.startsWith(want) && n.endsWith('.csv.gz')) found.push({ name: e.name, path: full, modifyTime: e.modifyTime });
    }
  }
  await walk(basePath === '/' ? '/' : basePath, 0, true);
  return found;
}

/**
 * HISTORISCHE REBUILD: verwerk álle beschikbare export-vensters (tellers +
 * verkopen) opnieuw met de weborder-filter, zodat óók oude ledger-dagen schoon
 * worden. Per venster wordt tellers↔verkopen gekoppeld (zelfde <from>_<to>),
 * en per (filiaal, dag) wordt OVERSCHREVEN (newest-wins) — zo tellen
 * overlappende vensters niet dubbel. Eén ledger-write aan het eind.
 *
 * @param {{remotePath?:string, maxWindows?:number}} opts
 */
export async function rebuildLedger({ remotePath = '/Dataexport', maxWindows = 120 } = {}) {
  const windows = await withSftp(async (sftp) => {
    const [verkFiles, tellFiles] = await Promise.all([
      findAllFiles(sftp, remotePath, 'verkopen'),
      findAllFiles(sftp, remotePath, 'klantentellers')
    ]);
    const byKey = new Map();
    for (const f of verkFiles) { const k = fileWindowKey(f.name); if (!k) continue; (byKey.get(k) || byKey.set(k, {}).get(k)).verkopen = f; }
    for (const f of tellFiles) { const k = fileWindowKey(f.name); if (!k) continue; (byKey.get(k) || byKey.set(k, {}).get(k)).tellers = f; }
    /* Oudste → nieuwste, zodat nieuwere vensters oudere dagen overschrijven. */
    const keys = [...byKey.keys()].filter((k) => byKey.get(k).verkopen).sort();
    const take = keys.slice(-maxWindows);
    const out = [];
    for (const k of take) {
      const w = byKey.get(k);
      out.push({
        key: k,
        verkopenBuf: w.verkopen ? await sftp.get(w.verkopen.path) : null,
        tellersBuf: w.tellers ? await sftp.get(w.tellers.path) : null
      });
    }
    return out;
  });
  if (!windows.length) throw new Error('Geen verkopen_*.csv.gz vensters gevonden op de SFTP.');

  const physical = new Set(listBranches({ includeInternal: false }).map((b) => String(b.branchId)));
  const merge = {}; /* fil → date → finale dag-waarden (overschreven per venster) */
  const retourDays = {};               /* date → fil → reasons (overschreven per venster) */
  const retourDetailsByDate = new Map(); /* date → detailregels (overschreven per venster) */
  let excludedWebRows = 0, excludedWebCents = 0, processedWindows = 0;

  for (const win of windows) {
    if (!win.verkopenBuf) continue;
    let verkopen, tellers = [];
    try { verkopen = parseCsv(gunzipToText(win.verkopenBuf)); } catch { continue; }
    if (win.tellersBuf) { try { tellers = parseCsv(gunzipToText(win.tellersBuf)); } catch { tellers = []; } }

    /* Bouw dit venster in een eigen accumulator (Sets voor unieke bonnen). */
    const wAcc = {};
    const ensureW = (fil, date) => {
      (wAcc[fil] = wAcc[fil] || {});
      (wAcc[fil][date] = wAcc[fil][date] || { netCents: 0, grossCents: 0, refundCents: 0, grossItems: 0, refundItems: 0, bonnen: new Set(), refundBonnen: new Set(), bezoekers: 0 });
      return wAcc[fil][date];
    };
    for (const r of tellers) {
      const fil = String(r.filiaal_nummer || '').trim();
      const datum = String(r.datum || '').trim();
      if (!physical.has(fil) || !datum) continue;
      ensureW(fil, datum).bezoekers += toInt(r.aantal_in);
    }
    for (const r of verkopen) {
      const fil = String(r.filiaal_nummer || '').trim();
      const datum = String(r.datum || '').trim();
      if (!physical.has(fil) || !datum) continue;
      if (isWeborderRow(r)) { excludedWebRows += 1; excludedWebCents += toInt(r.gerealiseerd_bedrag); continue; }
      const cents = toInt(r.gerealiseerd_bedrag);
      const qty = Math.abs(toInt(r.aantal));
      const bon = String(r.bon_nummer || '');
      const e = ensureW(fil, datum);
      e.netCents += cents;
      if (cents >= 0) { e.grossCents += cents; e.grossItems += qty; if (String(r.verkoop_soort || '').toLowerCase() === 'verkoop' && cents > 0) e.bonnen.add(bon); }
      else { e.refundCents += -cents; e.refundItems += qty; e.refundBonnen.add(bon); }
    }
    /* OVERSCHRIJF per (fil, dag) in de globale merge (newest-wins). */
    for (const [fil, days] of Object.entries(wAcc)) {
      merge[fil] = merge[fil] || {};
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

    /* Retour-redenen: overschrijf per dag (newest-wins). */
    const { days: wRetourDays, details: wRetourDetails } = buildRetourData(verkopen, physical);
    for (const [date, fils] of Object.entries(wRetourDays)) retourDays[date] = fils;
    const wByDate = {};
    for (const d of wRetourDetails) (wByDate[d.date] = wByDate[d.date] || []).push(d);
    for (const [date, rows] of Object.entries(wByDate)) retourDetailsByDate.set(date, rows);

    processedWindows += 1;
  }

  await mergeLedger(merge);

  /* Retour-redenen ledger meeschrijven. Additief — fout breekt de rebuild niet. */
  try {
    const details = [];
    for (const rows of retourDetailsByDate.values()) details.push(...rows);
    if (Object.keys(retourDays).length) await mergeRetourRedenen({ days: retourDays, details });
  } catch (e) {
    console.error('[srs-retail-import] rebuild retour-redenen faalde:', e.message);
  }

  const filialen = Object.keys(merge);
  const allDates = new Set();
  for (const days of Object.values(merge)) for (const d of Object.keys(days)) allDates.add(d);
  const sorted = [...allDates].sort();
  return {
    success: true,
    windowsAvailable: windows.length,
    windowsProcessed: processedWindows,
    filialen: filialen.length,
    dagen: sorted.length,
    coverage: sorted.length ? { from: sorted[0], to: sorted[sorted.length - 1] } : null,
    excludedWeborder: { rows: excludedWebRows, omzet: round2(excludedWebCents / 100) }
  };
}

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

  /* Omzet (netto, incl. retouren) + bonnen per filiaal/dag.
     Weborder-verwerking (memo "Weborder verwerking") telt NIET als winkelomzet —
     dat is webshop-omzet die toevallig door een filiaal wordt gepickt. */
  let excludedWebRows = 0;
  let excludedWebCents = 0;
  for (const r of verkopen) {
    const fil = String(r.filiaal_nummer || '').trim();
    const datum = String(r.datum || '').trim();
    if (!physical.has(fil) || !inWindow(datum)) continue;
    if (isWeborderRow(r)) { excludedWebRows += 1; excludedWebCents += toInt(r.gerealiseerd_bedrag); continue; }
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
    /* Transparantie: hoeveel weborder-verwerking is uit de winkelomzet gehouden
       (deze omzet hoort bij de webshop). */
    excludedWeborder: { rows: excludedWebRows, omzet: round2(excludedWebCents / 100) },
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
      if (isWeborderRow(r)) continue; /* weborder-verwerking → webshop, niet winkel */
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

  /* Winkel-retour-redenen (klacht/retour/ruiling) per winkel/dag. Additief. */
  try {
    const { days, details } = buildRetourData(verkopen, physical);
    if (Object.keys(days).length) await mergeRetourRedenen({ days, details });
  } catch (e) {
    console.error('[srs-retail-import] retour-redenen faalde:', e.message);
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
        cache, /* volledige productcache → bredere matching (sku/artikelnr/artikel_id) */
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
