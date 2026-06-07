/**
 * GET /api/admin/marketing-advisor?period=week|maand|kwartaal|jaar
 *
 * "Marketing-analist": kritisch AI-advies over de marketing-resultaten + of het
 * externe bureau goed presteert (rapportcijfer, sterke punten, zorgen,
 * aanbevelingen, benchmark, vragen). De zware logica zit in lib/marketing-advisor.js
 * (gedeeld met de maand-cron). Resultaat 6u gecached; ?refresh=1 omzeilt de cache.
 * Auth: admin-token.
 */

import { corsJson, requireAdmin } from '../../lib/request-guards.js';
import { generateMarketingAdvice } from '../../lib/marketing-advisor.js';
import { readJsonBlob, writeJsonBlob } from '../../lib/json-blob-store.js';

export const maxDuration = 120;

const CACHE_PATH = 'marketing/advisor-cache.json';
const CACHE_MS = 6 * 60 * 60 * 1000;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const period = String(req.query.period || 'maand').toLowerCase();
  const refresh = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());

  try {
    const cache = refresh ? null : await readJsonBlob(CACHE_PATH, null).catch(() => null);
    if (cache && cache.period === period && cache.at && (Date.now() - new Date(cache.at).getTime()) < CACHE_MS) {
      return res.status(200).json({ ...cache.payload, cached: true, generatedAt: cache.at });
    }

    const result = await generateMarketingAdvice(period);
    if (!result.ok) {
      return res.status(200).json({ success: false, period, message: result.error, raw: result.raw });
    }

    const payload = { success: true, period, range: result.range, data: result.data, advice: result.advice };
    try { await writeJsonBlob(CACHE_PATH, { period, at: new Date().toISOString(), payload }); } catch (_) {}
    return res.status(200).json({ ...payload, cached: false, generatedAt: new Date().toISOString() });
  } catch (e) {
    console.error('[admin/marketing-advisor]', e);
    return res.status(200).json({ success: false, period, message: e.message || 'Advies genereren mislukt.' });
  }
}
