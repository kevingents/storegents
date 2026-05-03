import { handleCors, setCorsHeaders } from '../../../lib/cors.js';
import { getStockNegativeReport, filterStockRowsByStore, summarizeTotals } from '../../../lib/stock-negative-store.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });

  const store = String(req.query.store || '').trim();
  if (!store) return res.status(400).json({ success: false, message: 'Winkel ontbreekt.' });

  try {
    const report = await getStockNegativeReport();
    const rows = filterStockRowsByStore(report.rows || [], store);
    const totals = summarizeTotals(rows);
    return res.status(200).json({
      success: true,
      store,
      updatedAt: report.updatedAt,
      totals,
      topArticles: rows
        .sort((a, b) => Number(b.value || 0) - Number(a.value || 0) || Number(b.negativePieces || 0) - Number(a.negativePieces || 0))
        .slice(0, 20)
    });
  } catch (error) {
    console.error('Store stock negative summary error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Min-voorraad kon niet worden opgehaald.' });
  }
}
