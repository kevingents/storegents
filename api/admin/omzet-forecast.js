/**
 * GET /api/admin/omzet-forecast
 *
 * Omzet-forecast voor de rest van de lopende maand, per fysieke winkel + totaal,
 * met best / base / worst (lib/omzet-forecast). 30min in-memory cache.
 * Auth: admin-token.
 */

import { corsJson, requireAdmin } from '../../lib/request-guards.js';
import { computeOmzetForecast } from '../../lib/omzet-forecast.js';

export const maxDuration = 60;

const CACHE = { ts: 0, payload: null };
const TTL_MS = 30 * 60 * 1000;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const refresh = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());
  if (!refresh && CACHE.payload && Date.now() - CACHE.ts < TTL_MS) {
    return res.status(200).json({ ...CACHE.payload, cached: true });
  }

  try {
    const data = await computeOmzetForecast();
    const payload = { success: true, ...data };
    CACHE.ts = Date.now();
    CACHE.payload = payload;
    return res.status(200).json({ ...payload, cached: false });
  } catch (e) {
    console.error('[admin/omzet-forecast]', e);
    return res.status(200).json({ success: false, message: e.message || 'Forecast berekenen mislukt.' });
  }
}
