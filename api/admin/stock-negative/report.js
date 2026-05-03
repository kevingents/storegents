import { handleCors, setCorsHeaders } from '../../../lib/cors.js';
import { getStockNegativeReport, filterStockRowsByStore, summarizeByStore, summarizeTotals } from '../../../lib/stock-negative-store.js';

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || '12345';
  return req.headers['x-admin-token'] === adminToken || String(req.query.public || '') === 'true';
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    const store = String(req.query.store || '').trim();
    const limit = Math.max(1, Math.min(Number(req.query.limit || 500), 5000));
    const report = await getStockNegativeReport();
    const rows = filterStockRowsByStore(report.rows || [], store);

    return res.status(200).json({
      success: true,
      updatedAt: report.updatedAt,
      mode: report.mode,
      sourceFiles: report.sourceFiles || [],
      totals: summarizeTotals(rows),
      byStore: summarizeByStore(rows),
      rows: rows
        .sort((a, b) => Number(b.value || 0) - Number(a.value || 0) || Number(b.negativePieces || 0) - Number(a.negativePieces || 0))
        .slice(0, limit)
    });
  } catch (error) {
    console.error('Stock negative report error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Min-voorraad rapport kon niet worden opgehaald.' });
  }
}
