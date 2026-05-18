/**
 * Snapshot store voor SRS stock-data.
 *
 * Strategie (zie srs.docx, niveau 1 + 2):
 *   - Niveau 1 (volledige stock XML, 1x per dag in nachtelijke run): integraal opnieuw vullen
 *   - Niveau 2 (delta stock XML, elke 5 min via SFTP):           merge in bestaande snapshot
 *
 * Voor portaal-doeleinden (bulk voorraad per winkel, dashboards, voorraad-tegels)
 * lezen we uit deze snapshot in plaats van per barcode een live SOAP-call te
 * doen. Resultaat: 1 storeinfo SFTP call per 5 min vs. honderden GetStock-roundtrips.
 *
 * Blob-layout:
 *   srs-stock-snapshot/index.json                         — { branchIds: [...], generatedAt, mode, fileCount }
 *   srs-stock-snapshot/branch-<branchId>.json             — { branchId, rows: [{ barcode, sku, pieces, updatedAt }], updatedAt }
 *
 * Rows per winkel worden gemerged op barcode (laatste wint). Een delta die
 * pieces=0 oplevert blijft in de snapshot zitten als zero-stock entry — dat
 * weerspiegelt het echte voorraadbeeld bij SRS.
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const INDEX_PATH = 'srs-stock-snapshot/index.json';
const BRANCH_PATH_PREFIX = 'srs-stock-snapshot/branch-';
const MAX_AGE_MS = Number(process.env.SRS_STOCK_SNAPSHOT_MAX_AGE_MS || 30 * 60 * 1000); /* 30 min */

function branchPath(branchId) {
  const clean = String(branchId || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!clean) throw new Error('branchPath: ongeldig branchId.');
  return `${BRANCH_PATH_PREFIX}${clean}.json`;
}

export async function readSnapshotIndex() {
  return readJsonBlob(INDEX_PATH, {
    branchIds: [],
    generatedAt: null,
    fullGeneratedAt: null,
    deltaGeneratedAt: null,
    mode: null,
    fileCount: 0,
    rowCount: 0
  });
}

export async function writeSnapshotIndex(index) {
  await writeJsonBlob(INDEX_PATH, {
    ...index,
    generatedAt: index.generatedAt || new Date().toISOString()
  });
  return index;
}

export async function readBranchSnapshot(branchId) {
  if (!branchId) return null;
  return readJsonBlob(branchPath(branchId), {
    branchId: String(branchId),
    rows: [],
    updatedAt: null,
    rowCount: 0
  });
}

/**
 * Schrijf de stock-rows van één branch naar Blob.
 *
 * @param {string|number} branchId
 * @param {Array<{ barcode: string, sku?: string, pieces: number, updatedAt?: string, title?: string, color?: string, size?: string }>} rows
 */
export async function writeBranchSnapshot(branchId, rows = []) {
  const cleanRows = (Array.isArray(rows) ? rows : []).filter((row) => row && row.barcode);
  const payload = {
    branchId: String(branchId),
    rowCount: cleanRows.length,
    rows: cleanRows,
    updatedAt: new Date().toISOString()
  };
  await writeJsonBlob(branchPath(branchId), payload);
  return payload;
}

/**
 * Merge nieuwe rows over de bestaande snapshot heen.
 * Per (barcode) wordt de nieuwste row bewaard.
 *
 * @returns {Promise<{ branchId, rowCount, updated: number, added: number, updatedAt }>}
 */
export async function mergeBranchSnapshot(branchId, incomingRows = []) {
  if (!branchId) throw new Error('mergeBranchSnapshot: branchId verplicht.');
  const existing = (await readBranchSnapshot(branchId)) || { branchId, rows: [] };
  const map = new Map();

  for (const row of existing.rows || []) {
    if (!row?.barcode) continue;
    map.set(String(row.barcode), row);
  }

  let added = 0;
  let updated = 0;
  const now = new Date().toISOString();

  for (const row of incomingRows || []) {
    if (!row?.barcode) continue;
    const key = String(row.barcode);
    const prev = map.get(key);
    const next = {
      barcode: key,
      sku: row.sku || prev?.sku || key,
      pieces: Number.isFinite(Number(row.pieces)) ? Number(row.pieces) : 0,
      title: row.title || prev?.title || '',
      color: row.color || prev?.color || '',
      size: row.size || prev?.size || '',
      articleNumber: row.articleNumber || prev?.articleNumber || '',
      unitPrice: Number.isFinite(Number(row.unitPrice)) ? Number(row.unitPrice) : (prev?.unitPrice || 0),
      updatedAt: row.updatedAt || now
    };
    if (prev) updated += 1;
    else added += 1;
    map.set(key, next);
  }

  const merged = Array.from(map.values());
  const payload = await writeBranchSnapshot(branchId, merged);

  return {
    branchId: payload.branchId,
    rowCount: payload.rowCount,
    added,
    updated,
    updatedAt: payload.updatedAt
  };
}

/**
 * Volledige overwrite (gebruik voor niveau 1 / full stock XML).
 */
export async function replaceBranchSnapshot(branchId, rows = []) {
  return writeBranchSnapshot(branchId, rows);
}

/**
 * Geef branchSnapshot terug + verse-flag.
 */
export async function getBranchSnapshotFresh(branchId) {
  const snapshot = await readBranchSnapshot(branchId);
  if (!snapshot) return { snapshot: null, fresh: false, ageMs: Infinity };

  const updated = snapshot.updatedAt ? new Date(snapshot.updatedAt).getTime() : 0;
  const ageMs = updated ? Date.now() - updated : Infinity;
  return {
    snapshot,
    fresh: ageMs < MAX_AGE_MS,
    ageMs
  };
}

/**
 * Update de index na een delta- of full-run.
 */
export async function bumpSnapshotIndex({ branchIds = [], mode = 'delta', fileCount = 0, rowCount = 0 } = {}) {
  const current = await readSnapshotIndex();
  const next = {
    ...current,
    branchIds: Array.from(new Set([...(current.branchIds || []), ...branchIds.map(String)])),
    generatedAt: new Date().toISOString(),
    mode,
    fileCount: Number(fileCount || 0),
    rowCount: Number(rowCount || 0)
  };
  if (mode === 'full') next.fullGeneratedAt = next.generatedAt;
  if (mode === 'delta') next.deltaGeneratedAt = next.generatedAt;
  await writeSnapshotIndex(next);
  return next;
}

/**
 * Filter helper voor portaal-frontend.
 */
export function pickBranchStockRows(snapshot, { onlyAvailable = true, barcode = '', sku = '' } = {}) {
  if (!snapshot?.rows) return [];
  const wantedBarcode = String(barcode || '').trim();
  const wantedSku = String(sku || '').trim();
  return snapshot.rows.filter((row) => {
    if (!row) return false;
    if (onlyAvailable && Number(row.pieces || 0) <= 0) return false;
    if (wantedBarcode && String(row.barcode) !== wantedBarcode) return false;
    if (wantedSku && String(row.sku) !== wantedSku) return false;
    return true;
  });
}
