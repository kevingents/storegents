import SftpClient from 'ssh2-sftp-client';
import { XMLParser } from 'fast-xml-parser';
import { getStoreNameByBranchId } from './branch-metrics.js';

function env(name, fallback = '') {
  return process.env[name] || fallback;
}

function toNumber(value, fallback = 0) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const cleaned = String(value ?? '').replace(',', '.').replace(/[^0-9.-]/g, '');
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : fallback;
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function createParser() {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    removeNSPrefix: true,
    textNodeName: 'text',
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true
  });
}

function firstValue(obj, keys = []) {
  if (!obj || typeof obj !== 'object') return '';

  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && String(obj[key]).trim() !== '') {
      return obj[key];
    }
  }

  const lowerMap = Object.fromEntries(
    Object.entries(obj).map(([key, value]) => [String(key).toLowerCase(), value])
  );

  for (const key of keys) {
    const value = lowerMap[String(key).toLowerCase()];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }

  return '';
}

function pickBarcode(item) {
  const barcodes = asArray(item?.Barcodes?.Barcode || item?.Barcode || item?.barcodes?.barcode);

  const gs1 = barcodes.find((barcode) => {
    const type = String(barcode?.Type || barcode?.type || '').toLowerCase();
    return type.includes('gs1');
  });

  const preferred = gs1 || barcodes[0] || null;

  return String(
    preferred?.Id ||
    preferred?.id ||
    preferred?.text ||
    item?.Barcode ||
    item?.barcode ||
    item?.Sku ||
    item?.sku ||
    ''
  ).trim();
}

function stockTypeIsRelevant(type) {
  const value = String(type || '').toLowerCase().trim();

  if (!value) return true;

  return (
    value === 'available' ||
    value === 'stock' ||
    value === 'voorraad' ||
    value === 'physical' ||
    value === 'on_hand' ||
    value === 'onhand'
  );
}

function buildRowFromItem({ item, branchId, sourceFile, updatedAt, mode }) {
  const sku = String(firstValue(item, ['Sku', 'SKU', 'sku']) || '').trim();
  const barcode = pickBarcode(item) || sku;

  if (!branchId || !barcode) return [];

  const stockLevels = asArray(
    item?.StockLevels?.StockLevel ||
    item?.StockLevel ||
    item?.stockLevels?.stockLevel ||
    item?.stock_level
  );

  const rows = [];

  for (const level of stockLevels) {
    const type = String(firstValue(level, ['Type', 'type']) || '').trim();

    if (!stockTypeIsRelevant(type)) continue;

    const pieces = toNumber(
      firstValue(level, ['Pieces', 'pieces', 'Stock', 'stock', 'Quantity', 'quantity', 'Qty', 'qty', 'Aantal', 'aantal']),
      0
    );

    rows.push({
      branchId,
      store: getStoreNameByBranchId(branchId),
      barcode,
      sku: sku || barcode,
      articleNumber: String(
        firstValue(item, ['ArticleNumber', 'articleNumber', 'Artikelnummer']) || sku || barcode
      ).trim(),
      title: String(
        firstValue(item, ['Title', 'title', 'Name', 'name', 'ProductName', 'productName', 'Description', 'description', 'Omschrijving']) ||
        sku ||
        barcode
      ).trim(),
      color: String(firstValue(item, ['Color', 'color', 'Kleur', 'kleur']) || '').trim(),
      size: String(firstValue(item, ['Size', 'size', 'Maat', 'maat']) || '').trim(),
      pieces,
      stockType: type || 'available',
      unitPrice: toNumber(firstValue(item, ['Price', 'price', 'SalesPrice', 'salesPrice', 'Verkoopprijs', 'RetailPrice']), 0),
      source: mode || 'stock_xml',
      sourceFile: sourceFile || '',
      updatedAt: updatedAt || new Date().toISOString(),
      raw: item
    });
  }

  return rows;
}

function extractRowsFromSrsStockReport(parsed, metadata = {}) {
  const report = parsed?.Report || parsed?.data?.Report || parsed;
  const body = report?.Body || report?.body || report?.Data?.Body || report?.data?.Body;
  const collections = asArray(
    body?.Collection ||
    body?.Collections?.Collection ||
    report?.Collection ||
    parsed?.Collection
  );

  const rows = [];

  for (const collection of collections) {
    const branchId = String(firstValue(collection, ['Name', 'name', 'BranchId', 'branchId']) || '').trim();

    const itemsContainer = collection?.Items || collection?.items || {};
    const items = asArray(itemsContainer?.Item || itemsContainer?.item || collection?.Item || collection?.item);

    for (const item of items) {
      rows.push(
        ...buildRowFromItem({
          item,
          branchId,
          sourceFile: metadata.sourceFile,
          updatedAt: metadata.updatedAt,
          mode: metadata.mode
        })
      );
    }
  }

  return rows;
}

function extractRowsFallback(parsed, metadata = {}) {
  const rows = [];

  function walk(value, context = {}) {
    if (!value || typeof value !== 'object') return;

    if (Array.isArray(value)) {
      for (const item of value) walk(item, context);
      return;
    }

    const branchId = String(
      firstValue(value, ['Name', 'name', 'BranchId', 'branchId']) ||
      context.branchId ||
      ''
    ).trim();

    const hasSku = Boolean(firstValue(value, ['Sku', 'SKU', 'sku']));
    const hasStockLevels = Boolean(value?.StockLevels || value?.StockLevel || value?.stockLevels || value?.stockLevel);

    if (hasSku && hasStockLevels && branchId) {
      rows.push(
        ...buildRowFromItem({
          item: value,
          branchId,
          sourceFile: metadata.sourceFile,
          updatedAt: metadata.updatedAt,
          mode: metadata.mode
        })
      );
    }

    const nextContext = branchId ? { ...context, branchId } : context;

    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') walk(child, nextContext);
    }
  }

  walk(parsed, {});

  return rows;
}

export function parseSrsStockXml(xmlText, metadata = {}) {
  const parser = createParser();
  const parsed = parser.parse(xmlText || '');

  let rows = extractRowsFromSrsStockReport(parsed, metadata);

  if (!rows.length) {
    rows = extractRowsFallback(parsed, metadata);
  }

  const seen = new Map();

  for (const row of rows) {
    const key = [
      row.branchId,
      row.barcode,
      row.stockType || 'available'
    ].join('::');

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

  return {
    host,
    port,
    username,
    password,
    readyTimeout: 30000,
    retries: 1
  };
}

function modeFolder(mode) {
  return mode === 'full'
    ? env('SRS_STOCK_FULL_FOLDER', '/production/stock/full')
    : env('SRS_STOCK_DELTA_FOLDER', '/production/stock/delta');
}

function filePattern(mode) {
  const raw = mode === 'full'
    ? env('SRS_STOCK_FULL_PATTERN', '')
    : env('SRS_STOCK_DELTA_PATTERN', '');

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
    try {
      await sftp.end();
    } catch (_error) {}
  }
}

export async function readStockFile(path) {
  const sftp = new SftpClient();

  try {
    await sftp.connect(sftpConfig());

    const buffer = await sftp.get(path);

    return Buffer.isBuffer(buffer)
      ? buffer.toString('utf8')
      : String(buffer || '');
  } finally {
    try {
      await sftp.end();
    } catch (_error) {}
  }
}

export async function importLatestStockXml({ mode = 'delta', maxFiles = 1 } = {}) {
  const files = await listStockFiles({ mode, limit: maxFiles });

  if (!files.length) {
    return {
      mode,
      files: [],
      rows: [],
      message: `Geen ${mode} stock XML bestanden gevonden.`
    };
  }

  const allRows = [];

  for (const file of files) {
    const xml = await readStockFile(file.path);

    const rows = parseSrsStockXml(xml, {
      mode,
      sourceFile: file.path,
      updatedAt: file.modifiedAt || new Date().toISOString()
    });

    allRows.push(...rows);
  }

  return {
    mode,
    files,
    rows: allRows
  };
}
