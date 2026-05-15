import { filterRoutes, getDeliveryRoutes, isAuthorized, normalizeRoute, saveDeliveryRoutes, setRouteCors } from '../../lib/delivery-route-store.js';

export default async function handler(req, res) {
  setRouteCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    if (req.method === 'GET') {
      const routes = await getDeliveryRoutes();
      return res.status(200).json({ success: true, routes: filterRoutes(routes, { ...req.query, includeHidden: '1' }) });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ success: false, message: 'Alleen GET en POST zijn toegestaan.' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const existing = await getDeliveryRoutes();
    const incoming = Array.isArray(body.routes) ? body.routes : [body];
    const normalized = incoming.map(normalizeRoute).filter((route) => route.toLocation);

    if (!normalized.length) {
      return res.status(400).json({ success: false, message: 'Geen geldige route regels ontvangen.' });
    }

    const replaceWeek = body.replaceWeek !== false;
    const weeks = new Set(normalized.map((route) => route.weekStart).filter(Boolean));
    const retained = replaceWeek ? existing.filter((route) => !weeks.has(route.weekStart)) : existing;
    const routes = [...normalized, ...retained].sort((a, b) => String(a.deliveryDate).localeCompare(String(b.deliveryDate)) || String(a.eta).localeCompare(String(b.eta)) || String(a.toLocation).localeCompare(String(b.toLocation), 'nl'));

    await saveDeliveryRoutes(routes);
    return res.status(200).json({ success: true, saved: normalized.length, routes: normalized });
  } catch (error) {
    console.error('[admin/delivery-routes]', error);
    return res.status(500).json({ success: false, message: error.message || 'Routeplanning kon niet worden opgeslagen.' });
  }
}
