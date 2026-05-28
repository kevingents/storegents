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
import { listDirectory, downloadFile } from './srs-dataexport-sftp-client.js';
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
 * Vind nieuwste bestand dat met `prefix` begint (bv. 'voorraad_' of
 * 'voorraadlocaties_'). Sorteert op 'to'-datum in de naam, fallback modifyTime.
 *
 * NB: 'voorraad_' matcht ook 'voorraadlocaties_' → daarom exacte prefix-check
 * met onderscheid: voorraadlocaties begint met 'voorraadlocaties_'.
 */
async function findLatestFile(remotePath, kind) {
  const { entries } = await listDirectory(remotePath);
  const isLocaties = kind === 'locaties';
  const matches = entries.filter((e) => {
    if (e.type === 'd') return false;
    const n = e.name.toLowerCase();
    if (!n.endsWith('.csv.gz')) return false;
    if (isLocaties) return n.startsWith('voorraadlocaties_');
    return n.startsWith('voorraad_') && !n.startsWith('voorraadlocaties_');
  });
  if (!matches.length) return null;
  matches.sort((a, b) => {
    const da = fileToDate(a.name);
    const db = fileToDate(b.name);
    if (da && db && da !== db) return db.localeCompare(da);
    return (Number(b.modifyTime ? Date.parse(b.modifyTime) : 0)) - (Number(a.modifyTime ? Date.parse(a.modifyTime) : 0));
  });
  return matches[0];
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
 * ────────────────────────────────────────────────────────────────────── */
export async function importVoorraad({ remotePath = '/' } = {}) {
  const file = await findLatestFile(remotePath, 'voorraad');
  if (!file) throw new Error('Geen voorraad_*.csv.gz gevonden op SFTP.');

  const fullPath = (remotePath === '/' ? '' : remotePath) + '/' + file.name;
  const { content } = await downloadFile(fullPath);
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
export async function importLocaties({ remotePath = '/' } = {}) {
  const file = await findLatestFile(remotePath, 'locaties');
  if (!file) throw new Error('Geen voorraadlocaties_*.csv.gz gevonden op SFTP.');

  const fullPath = (remotePath === '/' ? '' : remotePath) + '/' + file.name;
  const { content } = await downloadFile(fullPath);
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
