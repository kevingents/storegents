import { filterRoutes, getDeliveryRoutes, nextWeekKey, setRouteCors } from '../lib/delivery-route-store.js';

export default async function handler(req, res) {
  setRouteCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });

  try {
    const routes = await getDeliveryRoutes();
    const weekStart = req.query.weekStart || req.query.week || nextWeekKey(1);
    const visible = filterRoutes(routes, { ...req.query, weekStart });
    return res.status(200).json({
      success: true,
      weekStart,
      store: req.query.store || '',
      routes: visible,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[delivery-routes]', error);
    return res.status(500).json({ success: false, message: error.message || 'Routeplanning kon niet worden geladen.' });
  }
}
