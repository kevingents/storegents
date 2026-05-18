import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { getStoreLocation } from '../../lib/gents-store-locations.js';

/**
 * GET /api/admin/route-multi-directions?stops=GENTS Magazijn,GENTS Amsterdam,GENTS Hilversum,GENTS Utrecht
 *
 * Returnt totale dag-route via OSRM:
 *   {
 *     stops: [{ name, coords, leg }],
 *     totalDistanceKm,
 *     totalDurationMin,
 *     totalDurationLabel,
 *     legs: [{ from, to, distanceKm, durationMin }],
 *     polyline
 *   }
 *
 * - Eerste stop = vertrekpunt (geen leg ervoor)
 * - Elke leg toont afstand + tijd van vorige stop → deze stop
 * - Multi-stop OSRM call: /route/v1/driving/lng,lat;lng,lat;lng,lat
 *
 * Cache: 24u in-memory op hashed stop-keten.
 */

const CACHE = new Map();
const TTL_MS = 24 * 60 * 60 * 1000;

function isAuthorized(req) {
  const adminToken = String(process.env.ADMIN_TOKEN || '').trim();
  if (!adminToken) return true;
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.admin_token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return token === adminToken;
}

function clean(value) { return String(value || '').trim(); }

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'public, max-age=86400');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const stopsRaw = clean(req.query.stops);
  if (!stopsRaw) return res.status(400).json({ success: false, message: 'stops query param verplicht (komma-gescheiden).' });

  const stopNames = stopsRaw.split(',').map((s) => s.trim()).filter(Boolean);
  if (stopNames.length < 2) return res.status(400).json({ success: false, message: 'Minimaal 2 stops nodig.' });
  if (stopNames.length > 25) return res.status(400).json({ success: false, message: 'Maximaal 25 stops per call.' });

  /* Resolve coords */
  const stops = stopNames.map((name) => {
    const loc = getStoreLocation(name);
    return loc ? { name, coords: { lat: loc.lat, lng: loc.lng, address: loc.address } } : { name, coords: null };
  });
  const missing = stops.filter((s) => !s.coords);
  if (missing.length) {
    return res.status(200).json({
      success: false,
      message: `Onbekende locatie(s): ${missing.map((m) => m.name).join(', ')}`,
      stops
    });
  }

  const cacheKey = stops.map((s) => `${s.coords.lat},${s.coords.lng}`).join('|');
  const cached = CACHE.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < TTL_MS) {
    return res.status(200).json({ success: true, cached: true, ...cached.data });
  }

  try {
    const coordsPart = stops.map((s) => `${s.coords.lng},${s.coords.lat}`).join(';');
    const url = `https://router.project-osrm.org/route/v1/driving/${coordsPart}?overview=simplified&geometries=polyline&steps=false`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'GENTS-portal/1.0' } });
    clearTimeout(timer);
    const data = await resp.json();
    if (!resp.ok || data.code !== 'Ok' || !data.routes?.length) {
      return res.status(200).json({
        success: false,
        message: `OSRM gaf geen route: ${data.code || resp.status}`,
        stops
      });
    }

    const route = data.routes[0];
    const totalDistanceKm = Math.round((route.distance / 1000) * 10) / 10;
    const totalDurationMin = Math.round(route.duration / 60);

    /* Per-leg breakdown (OSRM legs array bevat 1 entry per stop-to-stop hop) */
    const legs = (route.legs || []).map((leg, i) => ({
      from: stops[i].name,
      to: stops[i + 1].name,
      distanceKm: Math.round((leg.distance / 1000) * 10) / 10,
      durationMin: Math.round(leg.duration / 60)
    }));

    const payload = {
      stops,
      legs,
      totalDistanceKm,
      totalDurationMin,
      totalDurationLabel: totalDurationMin >= 60
        ? `${Math.floor(totalDurationMin / 60)}u ${totalDurationMin % 60}m`
        : `${totalDurationMin}m`,
      polyline: route.geometry || ''
    };

    CACHE.set(cacheKey, { ts: Date.now(), data: payload });
    return res.status(200).json({ success: true, cached: false, ...payload });
  } catch (error) {
    console.error('[admin/route-multi-directions]', error);
    return res.status(200).json({
      success: false,
      message: `Routing service tijdelijk niet bereikbaar: ${error.message || 'timeout'}`,
      stops
    });
  }
}
