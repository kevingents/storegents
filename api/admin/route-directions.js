import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { getStoreLocation } from '../../lib/gents-store-locations.js';

/**
 * GET /api/admin/route-directions?from=GENTS Magazijn&to=GENTS Amsterdam
 *
 * Returnt: { distanceKm, durationMin, polyline, fromCoords, toCoords }
 *
 * Bron: OSRM (Open Source Routing Machine) demo server — gratis, geen API key.
 *       https://router.project-osrm.org
 *       Productie: overweeg eigen OSRM instance of betaalde provider voor SLA.
 *
 * Cache: 24u in-memory (route tussen 2 winkels verandert niet vaak).
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

  const from = clean(req.query.from);
  const to = clean(req.query.to);
  if (!from || !to) return res.status(400).json({ success: false, message: 'from + to query params verplicht.' });

  const fromLoc = getStoreLocation(from);
  const toLoc = getStoreLocation(to);
  if (!fromLoc) return res.status(200).json({ success: false, message: `Onbekende from-locatie: ${from}` });
  if (!toLoc) return res.status(200).json({ success: false, message: `Onbekende to-locatie: ${to}` });

  const cacheKey = `${fromLoc.lat},${fromLoc.lng}|${toLoc.lat},${toLoc.lng}`;
  const cached = CACHE.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < TTL_MS) {
    return res.status(200).json({ success: true, cached: true, ...cached.data });
  }

  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${fromLoc.lng},${fromLoc.lat};${toLoc.lng},${toLoc.lat}?overview=simplified&geometries=polyline`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'GENTS-portal/1.0' } });
    clearTimeout(timer);
    const data = await resp.json();
    if (!resp.ok || data.code !== 'Ok' || !data.routes?.length) {
      return res.status(200).json({
        success: false,
        message: `OSRM gaf geen route: ${data.code || resp.status}`,
        fromCoords: fromLoc,
        toCoords: toLoc
      });
    }
    const route = data.routes[0];
    const distanceKm = Math.round(route.distance / 1000 * 10) / 10;
    const durationMin = Math.round(route.duration / 60);
    const polyline = route.geometry || '';

    const payload = {
      from, to,
      fromCoords: { lat: fromLoc.lat, lng: fromLoc.lng, address: fromLoc.address },
      toCoords: { lat: toLoc.lat, lng: toLoc.lng, address: toLoc.address },
      distanceKm,
      durationMin,
      durationLabel: durationMin >= 60 ? `${Math.floor(durationMin / 60)}u ${durationMin % 60}m` : `${durationMin}m`,
      polyline
    };

    CACHE.set(cacheKey, { ts: Date.now(), data: payload });
    return res.status(200).json({ success: true, cached: false, ...payload });
  } catch (error) {
    console.error('[admin/route-directions]', error);
    return res.status(200).json({
      success: false,
      message: `Routing service tijdelijk niet bereikbaar: ${error.message || 'timeout'}`,
      fromCoords: fromLoc,
      toCoords: toLoc
    });
  }
}
