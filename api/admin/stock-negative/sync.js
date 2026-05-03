import { handleCors, setCorsHeaders } from '../../../lib/cors.js';
import { importLatestStockXml } from '../../../lib/srs-stock-sftp-client.js';
import { applyStockDeltaRows, replaceStockNegativeRows } from '../../../lib/stock-negative-store.js';

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || '12345';
  const syncSecret = process.env.STOCK_NEGATIVE_SYNC_SECRET || '';
  const incoming = String(req.headers['x-admin-token'] || req.query.adminToken || '').trim();
  const secret = String(req.headers.authorization || req.query.secret || '').replace(/^Bearer\s+/i, '').trim();
  return incoming === adminToken || (syncSecret && secret === syncSecret);
}

function bool(value) {
  return ['1', 'true', 'yes', 'ja'].includes(String(value || '').toLowerCase());
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ success: false, message: 'Alleen GET/POST is toegestaan.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const enabled = String(process.env.SRS_STOCK_NEGATIVE_SYNC_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) return res.status(400).json({ success: false, message: 'Min-voorraad sync staat uit via SRS_STOCK_NEGATIVE_SYNC_ENABLED=false.' });

  const mode = String(req.query.mode || req.body?.mode || 'delta').toLowerCase() === 'full' ? 'full' : 'delta';
  const dryRun = bool(req.query.dryRun || req.body?.dryRun);
  const maxFiles = Math.max(1, Math.min(Number(req.query.maxFiles || req.body?.maxFiles || 1), 10));

  try {
    const imported = await importLatestStockXml({ mode, maxFiles });
    const negativeRows = imported.rows.filter((row) => Number(row.pieces || 0) < 0);

    if (dryRun) {
      return res.status(200).json({
        success: true,
        dryRun: true,
        mode,
        files: imported.files,
        scannedRows: imported.rows.length,
        negativeRows: negativeRows.length,
        preview: negativeRows.slice(0, 50)
      });
    }

    const report = mode === 'full'
      ? await replaceStockNegativeRows(imported.rows, { mode, sourceFiles: imported.files.map((file) => file.path) })
      : await applyStockDeltaRows(imported.rows, { mode, sourceFiles: imported.files.map((file) => file.path) });

    return res.status(200).json({
      success: true,
      mode,
      files: imported.files,
      scannedRows: imported.rows.length,
      negativeRows: negativeRows.length,
      report: {
        updatedAt: report.updatedAt,
        totals: report.totals,
        byStore: report.byStore.slice(0, 25)
      }
    });
  } catch (error) {
    console.error('Stock negative sync error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Min-voorraad sync mislukt.',
      hint: 'Controleer SRS_STOCK_SFTP_HOST, SRS_STOCK_SFTP_PORT, SRS_STOCK_SFTP_USER, SRS_STOCK_SFTP_PASSWORD en stock folders.'
    });
  }
}
