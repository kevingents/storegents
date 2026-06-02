/**
 * /api/admin/social-stats
 *
 * Social-media-statistieken (Instagram-businessaccount + Facebook-pagina):
 * profiel, volgersgroei, bereik en recente posts. GET, 1u cache, ?refresh=1.
 */

import { corsJson, requireAdmin } from '../../lib/request-guards.js';
import { getSocialStats } from '../../lib/social-stats.js';
import { readPortalConfig, marketingTargets } from '../../lib/portal-config-store.js';
import { readJsonBlob, writeJsonBlob } from '../../lib/json-blob-store.js';

export const maxDuration = 60;
const CACHE_PATH = 'marketing/social-stats.json';
const TTL_MS = 60 * 60 * 1000;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  const refresh = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());
  const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;

  try {
    /* Volgers-maandtarget buiten de 1u-cache lezen, zodat een gewijzigd doel direct telt. */
    const volgersTarget = marketingTargets(await readPortalConfig().catch(() => ({}))).volgersMaand;
    if (!refresh) {
      const c = await readJsonBlob(CACHE_PATH, null).catch(() => null);
      if (c && c.days === days && c.at && (Date.now() - new Date(c.at).getTime()) < TTL_MS) {
        return res.status(200).json({ success: true, ...c.data, volgersTarget, cached: true, cachedAt: c.at });
      }
    }
    const data = await getSocialStats({ days });
    try { await writeJsonBlob(CACHE_PATH, { at: new Date().toISOString(), days, data }); } catch (_) {}
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({ success: true, ...data, volgersTarget, cached: false });
  } catch (error) {
    console.error('[admin/social-stats]', error);
    return res.status(200).json({ success: true, configured: false, error: error.message || 'Social-stats ophalen mislukte.' });
  }
}
