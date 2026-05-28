/**
 * lib/srs-voorraad-import.js
 *
 * Haalt de nieuwste voorraad_*.csv.gz + voorraadlocaties_*.csv.gz van de SRS
 * data-export SFTP (transfer.srs.nl), unzipt, parsed en schrijft een snapshot
 * via srs-voorraad-store.js.
 *
 * Bestandsformaat (semicolon-gescheiden):
 *   voorraad:        filiaal_nummer;sku_code;voorraad_aantal;ideaal_aantal
 *   voorraadlocaties: filiaal_nummer;locatie_code;sku_code;aantal;last_inventarisation;geblokkeerd
 *
 * Bestandsnaam-patroon: <type>_<from>_<to>.csv.gz (rolling 2-weeks window).
 * We pakken het nieuwste o.b.v. de 'to'-datum in de bestandsnaam.
 */

import zlib from 'node:zlib';
import { withSftp } from './srs-dataexport-sftp-client.js';
import { getStoreNameByBranchId } from './branch-metrics.js';
import { writeVoorraadSnapshot, writeLocatiesSnapshot } from './srs-voorraad-store.js';

/* ──────────────────────────────────────────────────────────────────────
 * CSV-parser — semicolon-gescheiden, ondersteunt dubbele-quotes
 * ────────────────────────────────────────────────────────────────────── */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ';') {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
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
  return { header, rows };
}

/* ──────────────────────────────────────────────────────────────────────
 * Bestand-selectie
 * ────────────────────────────────────────────────────────────────────── */

/** Extract 'to'-datum uit bestandsnaam <type>_<from>_<to>.csv.gz → 'YYYY-MM-DD' */
function fileToDate(name) {
  const m = String(name).match(/_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.csv\.gz$/i);
  return m ? m[2] : '';
}

/**
 * Kies nieuwste bestand uit een lijst entries dat met `kind` matcht.
 * Sorteert op 'to'-datum in de naam, fallback modifyTime.
 *
 * NB: 'voorraad_' matcht ook 'voorraadlocaties_' → daarom exacte prefix-check
 * met onderscheid: voorraadlocaties begint met 'voorraadlocaties_'.
 */
function pickLatestFile(entries, kind) {
  const isLocaties = kind === 'locaties';
  const matches = (entries || []).filter((e) => {
    if (e.type === 'd') return false;
    const n = e.name.toLowerCase();
    if (!n.endsWith('.csv.gz')) return false;
    if (isLocaties) return n.startsWith('voorraadlocaties_');
    return n.startsWith('voorraad_') && !n.startsWith('voorraadlocaties_');
  });
  if (!matches.length) return null;
  const mtime = (v) => {
    if (v == null) return 0;
    if (typeof v === 'number') return v;          /* ssh2-sftp-client: ms epoch */
    const p = Date.parse(v);                        /* ISO-string fallback */
    return Number.isFinite(p) ? p : 0;
  };
  matches.sort((a, b) => {
    const da = fileToDate(a.name);
    const db = fileToDate(b.name);
    if (da && db && da !== db) return db.localeCompare(da);
    return mtime(b.modifyTime) - mtime(a.modifyTime);
  });
  return matches[0];
}

/** Matcht een bestandsnaam tegen het gevraagde type. */
function nameMatchesKind(name, kind) {
  const n = String(name).toLowerCase();
  if (!n.endsWith('.csv.gz')) return false;
  if (kind === 'locaties') return n.startsWith('voorraadlocaties_');
  return n.startsWith('voorraad_') && !n.startsWith('voorraadlocaties_');
}

/**
 * Zoek recursief (binnen 1 sftp-sessie) naar het nieuwste matchende bestand.
 * Begint bij basePath en daalt af in submappen tot maxDepth.
 * Returnt { name, path, modifyTime } of null.
 */
async function findLatestRecursive(sftp, basePath, kind, maxDepth = 3) {
  const found = [];
  async function walk(dir, depth) {
    let entries;
    try { entries = await sftp.list(dir); } catch { return; }
    for (const e of entries) {
      const full = (dir === '/' ? '' : dir) + '/' + e.name;
      if (e.type === 'd') {
        if (depth < maxDepth) await walk(full, depth + 1);
      } else if (nameMatchesKind(e.name, kind)) {
        found.push({ name: e.name, path: full, modifyTime: e.modifyTime });
      }
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

function gunzipToText(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return zlib.gunzipSync(buf).toString('utf8');
}

function toInt(v) {
  const n = parseInt(String(v ?? '').replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

/* ──────────────────────────────────────────────────────────────────────
 * Import voorraad (actueel vs ideaal)
 *
 * Eén SFTP-sessie: list + download samen — bespaart een 2e handshake (~3-5s).
 * ────────────────────────────────────────────────────────────────────── */
export async function importVoorraad({ remotePath = '/Dataexport' } = {}) {
  const { file, content } = await withSftp(async (sftp) => {
    const f = await findLatestRecursive(sftp, remotePath, 'voorraad');
    if (!f) return { file: null, content: null };
    const buf = await sftp.get(f.path);
    return { file: f, content: buf };
  });
  if (!file) throw new Error('Geen voorraad_*.csv.gz gevonden op SFTP (ook niet in submappen).');

  const text = gunzipToText(content);
  const { rows: rawRows } = parseCsv(text);

  const rows = rawRows.map((r) => {
    const filiaalNummer = String(r.filiaal_nummer || '').trim();
    const voorraad = toInt(r.voorraad_aantal);
    const ideaal = toInt(r.ideaal_aantal);
    return {
      filiaalNummer,
      store: getStoreNameByBranchId(filiaalNummer) || `Filiaal ${filiaalNummer}`,
      sku: String(r.sku_code || '').trim(),
      voorraad,
      ideaal,
      tekort: Math.max(0, ideaal - voorraad)
    };
  }).filter((r) => r.sku);

  const meta = { sourceFile: file.name, fileTo: fileToDate(file.name) };
  const result = await writeVoorraadSnapshot(rows, meta);
  return { ...result, sourceFile: file.name, parsedRows: rows.length };
}

/* ──────────────────────────────────────────────────────────────────────
 * Import voorraadlocaties (bin-locaties)
 * ────────────────────────────────────────────────────────────────────── */
export async function importLocaties({ remotePath = '/Dataexport' } = {}) {
  const { file, content } = await withSftp(async (sftp) => {
    const f = await findLatestRecursive(sftp, remotePath, 'locaties');
    if (!f) return { file: null, content: null };
    const buf = await sftp.get(f.path);
    return { file: f, content: buf };
  });
  if (!file) throw new Error('Geen voorraadlocaties_*.csv.gz gevonden op SFTP (ook niet in submappen).');

  const text = gunzipToText(content);
  const { rows: rawRows } = parseCsv(text);

  const rows = rawRows.map((r) => {
    const filiaalNummer = String(r.filiaal_nummer || '').trim();
    return {
      filiaalNummer,
      store: getStoreNameByBranchId(filiaalNummer) || `Filiaal ${filiaalNummer}`,
      locatie: String(r.locatie_code || '').trim(),
      sku: String(r.sku_code || '').trim(),
      aantal: toInt(r.aantal),
      lastInventarisation: String(r.last_inventarisation || '').trim(),
      geblokkeerd: String(r.geblokkeerd || '').trim().toUpperCase() === 'J' ||
                   String(r.geblokkeerd || '').trim().toUpperCase() === 'Y'
    };
  }).filter((r) => r.sku && r.locatie);

  const meta = { sourceFile: file.name, fileTo: fileToDate(file.name) };
  const result = await writeLocatiesSnapshot(rows, meta);
  return { ...result, sourceFile: file.name, parsedRows: rows.length };
}

/* Beide in één keer — voor de cron */
export async function importAll({ remotePath = '/' } = {}) {
  const out = { voorraad: null, locaties: null, errors: [] };
  try { out.voorraad = await importVoorraad({ remotePath }); }
  catch (e) { out.errors.push({ kind: 'voorraad', error: e.message }); }
  try { out.locaties = await importLocaties({ remotePath }); }
  catch (e) { out.errors.push({ kind: 'locaties', error: e.message }); }
  return out;
}
