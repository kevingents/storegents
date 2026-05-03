import SftpClient from 'ssh2-sftp-client';
import { XMLParser } from 'fast-xml-parser';
import { getStoreNameByBranchId } from './branch-metrics.js';

function env(name, fallback = '') {
  return process.env[name] || fallback;
}

function toNumber(value, fallback = 0) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const cleaned = String(value ?? '').replace(',', '.').replace(/[^0-9.-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : fallback;
}

function firstValue(obj, keys = []) {
  if (!obj || typeof obj !== 'object') return '';
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && String(obj[key]).trim() !== '') return obj[key];
  }
  const lowerMap = Object.fromEntries(Object.entries(obj).map(([k, v]) => [String(k).toLowerCase(), v]));
  for (const key of keys) {
    const value = lowerMap[String(key).toLowerCase()];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function createParser() {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    textNodeName: 'text',
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true
  });
}

function collectObjects(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, out);
    return out;
  }
  out.push(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') collectObjects(child, out);
  }
  return out;
}

function looksLikeStockLevel(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const branchId = firstValue(obj, ['BranchId', 'branchId', 'FiliaalId', 'StoreId']);
  const pieces = firstValue(obj, ['Pieces', 'pieces', 'Stock', 'stock', 'Quantity', 'quantity', 'Qty', 'qty', 'Aantal', 'aantal']);
  return String(branchId || '').trim() !== '' && String(pieces ?? '').trim() !== '';
}

function parentProductFields(obj) {
  return {
    barcode: firstValue(obj, ['Barcode', 'barcode', 'Sku', 'SKU', 'sku', 'ArticleNumber', 'articleNumber', 'Artikelnummer']),
    sku: firstValue(obj, ['Sku', 'SKU', 'sku', 'Barcode', 'barcode']),
    articleNumber: firstValue(obj, ['ArticleNumber', 'articleNumber', 'Artikelnummer', 'barcode', 'Barcode']),
    title: firstValue(obj, ['Title', 'title', 'Name', 'name', 'ProductName', 'productName', 'Description', 'description', 'Omschrijving']),
    color: firstValue(obj, ['Color', 'color', 'Kleur', 'kleur']),
    size: firstValue(obj, ['Size', 'size', 'Maat', 'maat']),
    unitPrice: firstValue(obj, ['Price', 'price', 'SalesPrice', 'salesPrice', 'Verkoopprijs', 'RetailPrice'])
  };
}

function extractStockRowsFromObject(obj, inherited = {}, rows = []) {
  if (!obj || typeof obj !== 'object') return rows;
  if (Array.isArray(obj)) {
    for (const item of obj) extractStockRowsFromObject(item, inherited, rows);
    return rows;
  }

  const product = { ...inherited, ...Object.fromEntries(Object.entries(parentProductFields(obj)).filter(([, v]) => String(v || '').trim() !== '')) };

  if (looksLikeStockLevel(obj)) {
    const branchId = String(firstValue(obj, ['BranchId', 'branchId', 'FiliaalId', 'StoreId']) || '').trim();
    const pieces = toNumber(firstValue(obj, ['Pieces', 'pieces', 'Stock', 'stock', 'Quantity', 'quantity', 'Qty', 'qty', 'Aantal', 'aantal']), 0);
    const barcode = String(firstValue(obj, ['Barcode', 'barcode', 'Sku', 'SKU', 'sku', 'ArticleNumber', 'articleNumber', 'Artikelnummer']) || product.barcode || product.sku || '').trim();

    if (branchId && barcode) {
      rows.push({
        branchId,
        store: getStoreNameByBranchId(branchId),
        barcode,
        sku: String(product.sku || barcode).trim(),
        articleNumber: String(product.articleNumber || barcode).trim(),
        title: String(product.title || barcode).trim(),
        color: String(product.color || '').trim(),
        size: String(product.size || '').trim(),
        pieces,
        unitPrice: toNumber(firstValue(obj, ['Price', 'price', 'SalesPrice', 'salesPrice', 'Verkoopprijs']) || product.unitPrice, 0),
        raw: obj
      });
    }
  }

  for (const child of Object.values(obj)) {
    if (child && typeof child === 'object') extractStockRowsFromObject(child, product, rows);
  }

  return rows;
}

export function parseSrsStockXml(xmlText, metadata = {}) {
  const parser = createParser();
  const parsed = parser.parse(xmlText || '');
  const rows = extractStockRowsFromObject(parsed, {}, [])
    .map((row) => ({
      ...row,
      source: metadata.mode || 'stock_xml',
      sourceFile: metadata.sourceFile || '',
      updatedAt: metadata.updatedAt || new Date().toISOString()
    }));

  const seen = new Map();
  for (const row of rows) {
    const key = [row.branchId, row.barcode].join('::');
    seen.set(key, row);
  }
  return Array.from(seen.values());
}

function sftpConfig() {
  const host = env('SRS_STOCK_SFTP_HOST');
  const username = env('SRS_STOCK_SFTP_USER');
  const password = env('SRS_STOCK_SFTP_PASSWORD');
  const port = Number(env('SRS_STOCK_SFTP_PORT', '22')) || 22;
  if (!host || !username || !password) {
    throw new Error('SRS stock SFTP configuratie ontbreekt. Controleer SRS_STOCK_SFTP_HOST, SRS_STOCK_SFTP_USER en SRS_STOCK_SFTP_PASSWORD.');
  }
  return { host, port, username, password, readyTimeout: 30000, retries: 1 };
}

function modeFolder(mode) {
  return mode === 'full'
    ? env('SRS_STOCK_FULL_FOLDER', '/production/stock/full')
    : env('SRS_STOCK_DELTA_FOLDER', '/production/stock/delta');
}

function filePattern(mode) {
  const raw = mode === 'full' ? env('SRS_STOCK_FULL_PATTERN', '') : env('SRS_STOCK_DELTA_PATTERN', '');
  return raw ? new RegExp(raw) : /\.xml$/i;
}

export async function listStockFiles({ mode = 'delta', limit = 20 } = {}) {
  const sftp = new SftpClient();
  const folder = modeFolder(mode);
  const pattern = filePattern(mode);

  try {
    await sftp.connect(sftpConfig());
    const files = await sftp.list(folder);
    return files
      .filter((file) => file.type !== 'd' && pattern.test(file.name || ''))
      .sort((a, b) => Number(b.modifyTime || 0) - Number(a.modifyTime || 0))
      .slice(0, limit)
      .map((file) => ({
        name: file.name,
        path: `${folder.replace(/\/$/, '')}/${file.name}`,
        size: file.size || 0,
        modifyTime: file.modifyTime || 0,
        modifiedAt: file.modifyTime ? new Date(file.modifyTime).toISOString() : ''
      }));
  } finally {
    try { await sftp.end(); } catch (_error) {}
  }
}

export async function readStockFile(path) {
  const sftp = new SftpClient();
  try {
    await sftp.connect(sftpConfig());
    const buffer = await sftp.get(path);
    return Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
  } finally {
    try { await sftp.end(); } catch (_error) {}
  }
}

export async function importLatestStockXml({ mode = 'delta', maxFiles = 1 } = {}) {
  const files = await listStockFiles({ mode, limit: maxFiles });
  if (!files.length) {
    return { mode, files: [], rows: [], message: `Geen ${mode} stock XML bestanden gevonden.` };
  }

  const allRows = [];
  for (const file of files) {
    const xml = await readStockFile(file.path);
    const rows = parseSrsStockXml(xml, { mode, sourceFile: file.path, updatedAt: file.modifiedAt || new Date().toISOString() });
    allRows.push(...rows);
  }

  return { mode, files, rows: allRows };
}
