import {
  deleteRoute,
  filterRoutes,
  getDeliveryRoutes,
  isAuthorized,
  normalizeRoute,
  saveDeliveryRoutes,
  setRouteCors,
  setRouteStatus,
  sortRoutes,
  upsertRoutes
} from '../../lib/delivery-route-store.js';

export default async function handler(req, res) {
  setRouteCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    if (req.method === 'GET') {
      const routes = await getDeliveryRoutes();
      /* Standaard verborgen routes WEGLATEN (anders deed de verberg-actie
         niets). Wie ze toch wil zien geeft expliciet ?includeHidden=1 mee. */
      return res.status(200).json({
        success: true,
        routes: filterRoutes(routes, req.query)
      });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ success: false, message: 'Alleen GET en POST zijn toegestaan.' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = String(body.action || 'upsert').trim().toLowerCase();
    const existing = await getDeliveryRoutes();

    if (action === 'delete') {
      const routes = sortRoutes(deleteRoute(existing, body.id));
      await saveDeliveryRoutes(routes);
      return res.status(200).json({ success: true, deleted: body.id, routes });
    }

    if (action === 'status' || action === 'hide' || action === 'restore') {
      const status = action === 'hide' ? 'hidden' : action === 'restore' ? 'planned' : body.status;
      const routes = sortRoutes(setRouteStatus(existing, body.id, status));
      await saveDeliveryRoutes(routes);
      return res.status(200).json({ success: true, updated: body.id, routes });
    }

    const incoming = Array.isArray(body.routes) ? body.routes : [body.route || body];
    const normalized = incoming.map(normalizeRoute).filter((route) => route.toLocation);

    if (!normalized.length) {
      return res.status(400).json({ success: false, message: 'Geen geldige route regels ontvangen.' });
    }

    let base = existing;
    if (body.replaceWeek === true || action === 'replaceweek') {
      const weeks = new Set(normalized.map((route) => route.weekStart).filter(Boolean));
      base = existing.filter((route) => !weeks.has(route.weekStart));
    }

    const routes = sortRoutes(upsertRoutes(base, normalized));
    await saveDeliveryRoutes(routes);

    return res.status(200).json({
      success: true,
      saved: normalized.length,
      routes: normalized,
      totalRoutes: routes.length
    });
  } catch (error) {
    console.error('[admin/delivery-routes]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Routeplanning kon niet worden opgeslagen.'
    });
  }
}
