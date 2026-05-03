import { list, put } from '@vercel/blob';
import { getStoreNameByBranchId } from './branch-metrics.js';

const CURRENT_KEY = 'stock-negative/current.json';
const HISTORY_PREFIX = 'stock-negative/history';

function nowIso() {
  return new Date().toISOString();
}

function safeJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return fallback;
  }
}

function normalizeBranchId(value) {
  return String(value || '').trim();
}

function normalizeBarcode(value) {
  return String(value || '').trim();
}

function toNumber(value, fallback = 0) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const cleaned = String(value ?? '').replace(',', '.').replace(/[^0-9.-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : fallback;
}

function cleanString(value) {
  return String(value ?? '').trim();
}

function lineKey(row) {
  return [normalizeBranchId(row.branchId), normalizeBarcode(row.barcode || row.sku)].join('::');
}

function normalizeStockLine(row = {}) {
  const branchId = normalizeBranchId(row.branchId || row.branch || row.filiaalId || row.storeId);
  const barcode = normalizeBarcode(row.barcode || row.sku || row.articleNumber || row.artikelnummer);
  const pieces = toNumber(row.pieces ?? row.stock ?? row.quantity ?? row.qty ?? row.aantal, 0);
  const unitPrice = toNumber(row.unitPrice ?? row.price ?? row.salesPrice ?? row.verkoopprijs, 0);
  const negativePieces = pieces < 0 ? Math.abs(pieces) : 0;
  const value = negativePieces * Math.max(unitPrice, 0);

  return {
    id: row.id || lineKey({ branchId, barcode }),
    branchId,
    store: cleanString(row.store || row.storeName || row.branchName || getStoreNameByBranchId(branchId) || (branchId ? `Filiaal ${branchId}` : 'SRS zonder filiaal')),
    barcode,
    sku: cleanString(row.sku || barcode),
    articleNumber: cleanString(row.articleNumber || row.artikelnummer || barcode),
    title: cleanString(row.title || row.name || row.productName || row.description || barcode || 'Onbekend artikel'),
    color: cleanString(row.color || row.kleur),
    size: cleanString(row.size || row.maat),
    pieces,
    negativePieces,
    unitPrice,
    value,
    valueLabel: value.toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' }),
    source: cleanString(row.source || ''),
    sourceFile: cleanString(row.sourceFile || ''),
    updatedAt: row.updatedAt || row.lastChangedAt || nowIso(),
    raw: row.raw || null
  };
}

function normalizeReport(input = {}) {
  const rows = Array.isArray(input.rows) ? input.rows.map(normalizeStockLine).filter((row) => row.branchId && row.barcode && row.pieces < 0) : [];
  const byStore = summarizeByStore(rows);
  return {
    version: 1,
    updatedAt: input.updatedAt || nowIso(),
    mode: input.mode || 'unknown',
    sourceFiles: Array.isArray(input.sourceFiles) ? input.sourceFiles : [],
    rows,
    totals: summarizeTotals(rows),
    byStore
  };
}

async function readBlobJson(pathname, fallback) {
  const result = await list({ prefix: pathname, limit: 1 });
  const blob = (result.blobs || []).find((item) => item.pathname === pathname) || result.blobs?.[0];
  if (!blob?.url) return fallback;
  const response = await fetch(blob.url, { cache: 'no-store' });
  if (!response.ok) return fallback;
  return safeJson(await response.text(), fallback);
}

async function writeBlobJson(pathname, data) {
  await put(pathname, JSON.stringify(data, null, 2), {
    access: 'public',
    contentType: 'application/json',
    allowOverwrite: true
  });
}

export async function getStockNegativeReport() {
  const data = await readBlobJson(CURRENT_KEY, { rows: [], updatedAt: '', totals: {}, byStore: [] });
  return normalizeReport(data);
}

export async function saveStockNegativeReport(input = {}) {
  const report = normalizeReport(input);
  await writeBlobJson(CURRENT_KEY, report);
  const day = report.updatedAt.slice(0, 10);
  await writeBlobJson(`${HISTORY_PREFIX}/${day}.json`, report);
  return report;
}

export async function applyStockDeltaRows(deltaRows = [], metadata = {}) {
  const current = await getStockNegativeReport();
  const map = new Map((current.rows || []).map((row) => [lineKey(row), row]));

  for (const raw of deltaRows || []) {
    const row = normalizeStockLine({ ...raw, updatedAt: raw.updatedAt || metadata.updatedAt || nowIso() });
    const key = lineKey(row);
    if (!row.branchId || !row.barcode) continue;
    if (row.pieces < 0) map.set(key, row);
    else map.delete(key);
  }

  return saveStockNegativeReport({
    mode: metadata.mode || 'delta',
    updatedAt: metadata.updatedAt || nowIso(),
    sourceFiles: metadata.sourceFiles || current.sourceFiles || [],
    rows: Array.from(map.values())
  });
}

export async function replaceStockNegativeRows(rows = [], metadata = {}) {
  return saveStockNegativeReport({
    mode: metadata.mode || 'full',
    updatedAt: metadata.updatedAt || nowIso(),
    sourceFiles: metadata.sourceFiles || [],
    rows
  });
}

export function summarizeTotals(rows = []) {
  const negativeRows = (rows || []).filter((row) => Number(row.pieces || 0) < 0);
  const stores = new Set(negativeRows.map((row) => row.store || row.branchId).filter(Boolean));
  return {
    negativeLineCount: negativeRows.length,
    negativeArticleCount: new Set(negativeRows.map((row) => row.barcode).filter(Boolean)).size,
    negativePieces: negativeRows.reduce((sum, row) => sum + Number(row.negativePieces || Math.abs(Math.min(Number(row.pieces || 0), 0))), 0),
    negativeValue: negativeRows.reduce((sum, row) => sum + Number(row.value || 0), 0),
    storeCount: stores.size,
    updatedAt: nowIso()
  };
}

export function summarizeByStore(rows = []) {
  const map = new Map();

  for (const row of rows || []) {
    if (Number(row.pieces || 0) >= 0) continue;
    const store = row.store || (row.branchId ? `Filiaal ${row.branchId}` : 'SRS zonder filiaal');
    if (!map.has(store)) {
      map.set(store, {
        store,
        branchId: row.branchId || '',
        negativeLineCount: 0,
        negativeArticleCount: 0,
        negativePieces: 0,
        negativeValue: 0,
        updatedAt: row.updatedAt || '',
        articles: [],
        articleKeys: new Set()
      });
    }

    const agg = map.get(store);
    agg.negativeLineCount += 1;
    agg.negativePieces += Number(row.negativePieces || Math.abs(Math.min(Number(row.pieces || 0), 0)));
    agg.negativeValue += Number(row.value || 0);
    agg.articleKeys.add(row.barcode);
    if (!agg.updatedAt || String(row.updatedAt || '') > agg.updatedAt) agg.updatedAt = row.updatedAt || '';
    agg.articles.push(row);
  }

  return Array.from(map.values())
    .map((row) => ({
      store: row.store,
      branchId: row.branchId,
      negativeLineCount: row.negativeLineCount,
      negativeArticleCount: row.articleKeys.size,
      negativePieces: row.negativePieces,
      negativeValue: row.negativeValue,
      updatedAt: row.updatedAt,
      topArticles: row.articles
        .sort((a, b) => Number(b.value || 0) - Number(a.value || 0) || Number(b.negativePieces || 0) - Number(a.negativePieces || 0))
        .slice(0, 20)
    }))
    .sort((a, b) => Number(b.negativeValue || 0) - Number(a.negativeValue || 0) || Number(b.negativeLineCount || 0) - Number(a.negativeLineCount || 0));
}

export function filterStockRowsByStore(rows = [], store = '') {
  const wanted = cleanString(store);
  if (!wanted) return rows || [];
  return (rows || []).filter((row) => row.store === wanted || row.branchId === wanted);
}
