/**
 * lib/srs-dragers-import.js
 *
 * "Dragers" = fysieke verplaatsingen/transfers tussen filialen (SRS-export
 * verplaatsingen_*.csv.gz). Een drager loopt: herkomst → (tijdelijk geboekt op
 * filiaal 100 = Transfiliaal) → binnen geboekt op bestemming. De export bevat
 * alleen lopende/openstaande dragers; binnen-geboekte vallen eruit.
 *
 * Bestandsformaat (semicolon, kopregel):
 *   verplaatsing_nummer;verplaatsing_barcode;herkomst_filiaal_nummer;
 *   bestemming_filiaal_nummer;huidig_filiaal_nummer;created_at;updated_at;
 *   verplaatsing_regel_nummer;barcode
 *
 * Status per drager:
 *   binnen       huidig === bestemming (aangekomen — zeldzaam, valt eruit)
 *   transfiliaal huidig === 100 (op de transfiliaal, wacht op binnen-boeken)
 *   open         rest (aangemaakt / nog niet onderweg)
 *
 * Snapshot in blob srs/dragers.json.
 */

import zlib from 'node:zlib';
import { withSftp } from './srs-dataexport-sftp-client.js';
import { getStoreNameByBranchId } from './branch-metrics.js';
import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';
import { BUSINESS_CONFIG } from './business-config.js';
import { readProductsCache } from './shopify-products-cache.js';
import { appendClosedDragers } from './srs-dragers-history-store.js';

const PATH = 'srs/dragers.json';
const TRANSFILIAAL = '100';
const DAG = 86400000;
const HOUR = 3600000;
/* "Te laat ingeboekt" = langer onderweg dan de drager-deadline. Single source
   in business-config (default 48u, override via DRAGER_DEADLINE_HOURS) — zelfde
   drempel als de dagelijkse winkel-mail + weekrapport, zodat pagina en mail
   hetzelfde "te laat" tellen. */
const DEADLINE_HOURS = Number(process.env.DRAGER_DEADLINE_HOURS) || BUSINESS_CONFIG.deadlines.dragerHours;
const clean = (v) => String(v == null ? '' : v).trim();

/* ── CSV ── */
function parseCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ';') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur); return out;
}
function parseCsv(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]); const o = {};
    header.forEach((h, idx) => { o[h] = clean(c[idx]); });
    rows.push(o);
  }
  return rows;
}
const gunzip = (buf) => zlib.gunzipSync(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).toString('utf8');

function fileToDate(name) {
  const m = String(name).match(/_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.csv\.gz$/i);
  return m ? m[2] : '';
}
async function findLatest(sftp, basePath, prefix, maxDepth = 3) {
  const found = []; const want = prefix.toLowerCase();
  async function walk(dir, depth, isRoot) {
    let entries;
    try {
      entries = await sftp.list(dir);
    } catch (err) {
      /* Basis-map onleesbaar = echte SFTP-storing → niet maskeren als "geen
         bestand gevonden". Submap best-effort overslaan. */
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
  const mt = (v) => (typeof v === 'number' ? v : (Number.isFinite(Date.parse(v)) ? Date.parse(v) : 0));
  found.sort((a, b) => { const da = fileToDate(a.name), db = fileToDate(b.name); if (da && db && da !== db) return db.localeCompare(da); return mt(b.modifyTime) - mt(a.modifyTime); });
  return found[0];
}

function statusOf(huidig, bestemming) {
  if (huidig && huidig === bestemming) return 'binnen';
  if (huidig === TRANSFILIAAL) return 'transfiliaal';
  return 'open';
}
function daysSince(createdAt, now) {
  const t = Date.parse(String(createdAt).replace(' ', 'T'));
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / DAG)) : null;
}
function hoursSince(createdAt, now) {
  const t = Date.parse(String(createdAt).replace(' ', 'T'));
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / HOUR)) : null;
}

export async function readDragers() {
  const d = await readJsonBlob(PATH, { totals: null, list: [], refreshedAt: null });
  return (d && typeof d === 'object' && !Array.isArray(d)) ? d : { totals: null, list: [], refreshedAt: null };
}

/** Haal de nieuwste verplaatsingen-export op, bouw + schrijf de drager-snapshot. */
export async function importDragers({ remotePath = '/Dataexport' } = {}) {
  const { file, buf } = await withSftp(async (sftp) => {
    const f = await findLatest(sftp, remotePath, 'verplaatsingen');
    return { file: f, buf: f ? await sftp.get(f.path) : null };
  });
  if (!file) throw new Error('Geen verplaatsingen_*.csv.gz gevonden op de SFTP.');

  /* Lees de vorige snapshot — we hebben 'm zo nodig om afgesloten dragers
     (= verdwenen uit de export) te registreren in de history-store. */
  const prevSnapshot = await readJsonBlob(PATH, { list: [] });
  const prevById = new Map();
  for (const d of (prevSnapshot?.list || [])) {
    if (d && d.id) prevById.set(String(d.id), d);
  }

  const rows = parseCsv(gunzip(buf));
  const now = Date.now();

  /* Eén entry per verplaatsing (drager); regels = stuks. */
  const byId = new Map();
  for (const r of rows) {
    const id = clean(r.verplaatsing_nummer);
    if (!id) continue;
    let d = byId.get(id);
    if (!d) {
      d = {
        id,
        barcode: clean(r.verplaatsing_barcode),
        herkomst: clean(r.herkomst_filiaal_nummer),
        bestemming: clean(r.bestemming_filiaal_nummer),
        huidig: clean(r.huidig_filiaal_nummer),
        created: clean(r.created_at),
        regels: 0,
        /* Per-regel barcodes — zodat je op een drager kunt klikken en de
           items ziet (later verrijkt met Shopify-data, zie enrichDragerItems). */
        itemBarcodes: []
      };
      byId.set(id, d);
    }
    d.regels += 1;
    const bc = clean(r.barcode);
    if (bc) d.itemBarcodes.push(bc);
  }

  const dragers = [...byId.values()].map((d) => {
    const status = statusOf(d.huidig, d.bestemming);
    const dagen = daysSince(d.created, now);
    const uren = hoursSince(d.created, now);
    return {
      ...d,
      herkomstNaam: getStoreNameByBranchId(d.herkomst),
      bestemmingNaam: getStoreNameByBranchId(d.bestemming),
      huidigNaam: d.huidig ? getStoreNameByBranchId(d.huidig) : '',
      status,
      dagen,
      uren,
      teLaat: uren != null && uren >= DEADLINE_HOURS
    };
  });

  const open = dragers.filter((d) => d.status !== 'binnen');
  const aging = { '0-2': 0, '3-7': 0, '8-14': 0, '>14': 0 };
  for (const d of open) {
    const n = d.dagen == null ? 0 : d.dagen;
    if (n <= 2) aging['0-2'] += 1; else if (n <= 7) aging['3-7'] += 1; else if (n <= 14) aging['8-14'] += 1; else aging['>14'] += 1;
  }

  const routeMap = new Map();
  for (const d of open) {
    const key = `${d.herkomst}>${d.bestemming}`;
    let r = routeMap.get(key);
    if (!r) { r = { herkomst: d.herkomst, herkomstNaam: d.herkomstNaam, bestemming: d.bestemming, bestemmingNaam: d.bestemmingNaam, dragers: 0, stuks: 0 }; routeMap.set(key, r); }
    r.dragers += 1; r.stuks += d.regels;
  }

  /* Per bestemming-winkel: wat komt er naar ze toe + hoeveel daarvan te laat is.
     Voedt de winkel-weergave (filter op bestemming) + admin "per winkel". */
  const storeMap = new Map();
  for (const d of open) {
    const key = d.bestemming || '—';
    let s = storeMap.get(key);
    if (!s) { s = { filiaal: d.bestemming, store: d.bestemmingNaam || d.bestemming, dragers: 0, stuks: 0, teLaat: 0 }; storeMap.set(key, s); }
    s.dragers += 1; s.stuks += d.regels; if (d.teLaat) s.teLaat += 1;
  }

  const snapshot = {
    refreshedAt: new Date().toISOString(),
    sourceFile: file.name,
    deadlineHours: DEADLINE_HOURS,
    totals: {
      dragers: open.length,
      stuks: open.reduce((n, d) => n + d.regels, 0),
      opTransfiliaal: open.filter((d) => d.status === 'transfiliaal').length,
      teLaat: open.filter((d) => d.teLaat).length,
      stuck14: open.filter((d) => (d.dagen || 0) > 14).length
    },
    aging,
    byRoute: [...routeMap.values()].sort((a, b) => b.dragers - a.dragers).slice(0, 40),
    byStore: [...storeMap.values()].sort((a, b) => b.teLaat - a.teLaat || b.dragers - a.dragers).slice(0, 60),
    list: open.sort((a, b) => Number(b.teLaat) - Number(a.teLaat) || (b.uren || 0) - (a.uren || 0) || b.regels - a.regels).slice(0, 500)
  };

  await writeJsonBlob(PATH, snapshot);

  /* History: dragers die in de vorige snapshot zaten maar NIET in deze nieuwe
     zijn afgesloten (= 'binnen' geboekt door SRS en uit het export-bestand
     gevallen). Registreer ze in de history-store met doorlooptijd + te-laat-
     vlag. Best-effort — een history-fout mag de import niet breken. */
  try {
    const currentIds = new Set(dragers.map((d) => String(d.id)));
    const closed = [];
    for (const [prevId, prev] of prevById) {
      if (currentIds.has(prevId)) continue;
      const createdMs = Date.parse(String(prev.created || '').replace(' ', 'T'));
      const closedAtIso = new Date(now).toISOString();
      const durationHours = Number.isFinite(createdMs)
        ? Math.max(0, Math.floor((now - createdMs) / HOUR))
        : null;
      closed.push({
        id: prevId,
        herkomst: prev.herkomst || '',
        herkomstNaam: prev.herkomstNaam || '',
        bestemming: prev.bestemming || '',
        bestemmingNaam: prev.bestemmingNaam || '',
        created: prev.created || '',
        closedAt: closedAtIso,
        durationHours,
        wasTeLaat: durationHours != null && durationHours >= DEADLINE_HOURS,
        regels: Number(prev.regels) || 0
      });
    }
    if (closed.length) {
      await appendClosedDragers(closed);
      console.log(`[srs-dragers-import] ${closed.length} drager(s) afgesloten en gelogd in history.`);
    }
  } catch (e) {
    console.error('[srs-dragers-import] history-update faalde:', e.message);
  }

  return snapshot;
}

/**
 * Verrijk de regel-barcodes van één drager met Shopify-product-data, zodat je
 * bij het openklappen ziet WAT er in de drager zit (foto, titel, artikelnummer,
 * kleur/maat). Identieke barcodes worden geaggregeerd tot één regel met `aantal`.
 *
 * @param {string[]} barcodes  itemBarcodes uit de snapshot (één entry per stuk)
 * @returns {Promise<Array>}   gesorteerd op aantal (meeste eerst)
 */
export async function enrichDragerItems(barcodes) {
  const cache = await readProductsCache();
  const byBarcode = cache?.byBarcode || {};
  const grouped = new Map();
  for (const raw of (barcodes || [])) {
    const bc = clean(raw);
    const key = bc || '__leeg';
    const g = grouped.get(key);
    if (g) { g.aantal += 1; continue; }
    const v = bc ? byBarcode[bc.toLowerCase()] : null;
    grouped.set(key, {
      barcode: bc,
      aantal: 1,
      found: Boolean(v),
      artikelId: v?.srsArtikelId || '',
      articleNumber: v?.articleNumber || v?.sku || '',
      title: v?.title || '',
      color: v?.color || '',
      size: v?.size || '',
      vendor: v?.vendor || '',
      price: v?.price || '',
      image: v?.image || '',
      productUrl: v?.productUrl || ''
    });
  }
  return [...grouped.values()].sort((a, b) => b.aantal - a.aantal);
}
