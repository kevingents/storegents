import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { getDragerInfo } from '../../lib/srs-dragers-soap.js';
import { getDragerCache, saveDragerCache, summarizeDragers, summarizeDragersByStore } from '../../lib/srs-dragers-store.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (requireAdmin(req, res)) return;

  const store = String(req.query.store || '').trim();
  const refresh = String(req.query.refresh || '') === '1';
  const admin = String(req.query.admin || '') === '1';

  try {
    let rows = await getDragerCache();
    let source = 'cache';

    if (refresh || !rows.length) {
      const data = await getDragerInfo({ store });
      rows = await saveDragerCache(data.rows || []);
      source = 'soap';
    }

    if (admin) {
      const stores = summarizeDragersByStore(rows);
      return res.status(200).json({
        success: true,
        source,
        stores,
        totals: {
          openCount: stores.reduce((sum, row) => sum + Number(row.openCount || 0), 0),
          overdueCount: stores.reduce((sum, row) => sum + Number(row.overdueCount || 0), 0),
          storesWithOverdue: stores.filter((row) => Number(row.overdueCount || 0) > 0).length
        }
      });
    }

    const summary = summarizeDragers(rows, store);
    return res.status(200).json({ success: true, source, ...summary });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Dragers konden niet worden geladen.' });
  }
}
