import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { getDragerInfo } from '../../lib/srs-dragers-soap.js';
import { getDragerCache, saveDragerCache, summarizeDragers, summarizeDragersByStore } from '../../lib/srs-dragers-store.js';

function clean(value) {
  return String(value ?? '').trim();
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (requireAdmin(req, res)) return;

  const store = clean(req.query.store);
  const refresh = String(req.query.refresh || '') === '1';
  const admin = String(req.query.admin || '') === '1';
  const dragerId = clean(req.query.dragerId || req.query.id || req.query.drager);

  try {
    let rows = await getDragerCache();
    let source = 'cache';
    let notice = '';

    if (refresh && dragerId) {
      const data = await getDragerInfo({ store, dragerId });
      const existing = rows.filter((row) => clean(row.dragerId || row.id) !== dragerId);
      rows = await saveDragerCache([...(data.rows || []), ...existing]);
      source = 'soap';
    } else if (refresh && !dragerId) {
      notice = 'SRS Drager SOAP heeft alleen GetDragerInfo per specifieke drager. Een live totaaloverzicht zonder dragernummer is niet beschikbaar via deze WSDL. Het overzicht toont daarom de lokale cache/log.';
    }

    if (admin) {
      const stores = summarizeDragersByStore(rows);
      return res.status(200).json({
        success: true,
        source,
        notice,
        requiresDragerIdForLiveRefresh: true,
        stores,
        totals: {
          openCount: stores.reduce((sum, row) => sum + Number(row.openCount || 0), 0),
          overdueCount: stores.reduce((sum, row) => sum + Number(row.overdueCount || 0), 0),
          storesWithOverdue: stores.filter((row) => Number(row.overdueCount || 0) > 0).length
        }
      });
    }

    const summary = summarizeDragers(rows, store);
    return res.status(200).json({ success: true, source, notice, requiresDragerIdForLiveRefresh: true, ...summary });
  } catch (error) {
    const message = String(error.message || 'Dragers konden niet worden geladen.');
    return res.status(500).json({
      success: false,
      message: message.includes('Unknown error')
        ? 'SRS geeft Unknown error terug. Controleer of een geldig dragernummer is meegegeven; GetDragerInfo lijkt geen lijst zonder drager-id te ondersteunen.'
        : message
    });
  }
}
