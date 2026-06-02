/**
 * /api/admin/meta-boost
 *
 * Maakt een advertentie ("boost") van een bestaande Instagram-post — altijd op
 * status PAUSED (geen automatische uitgaven). De gebruiker activeert zelf in
 * Ads Manager.
 *
 *   GET                  → boostReadiness (token/account/igId/pagina ok?)
 *   POST { mediaId, ... } → createPausedBoost
 *
 * Vereist op het Meta-token de scope ads_management.
 */

import { corsJson, requireAdmin } from '../../lib/request-guards.js';
import { createPausedBoost, boostReadiness } from '../../lib/meta-ads-create.js';

export const maxDuration = 60;

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body;
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  try {
    if (req.method === 'GET') {
      const r = await boostReadiness();
      return res.status(200).json({ success: true, ...r });
    }
    const b = parseBody(req);
    if (!b.mediaId) return res.status(400).json({ success: false, message: 'mediaId ontbreekt.' });
    const result = await createPausedBoost({
      mediaId: b.mediaId,
      dailyBudgetEur: b.dailyBudgetEur,
      days: b.days,
      goal: b.goal,
      countries: b.countries,
      ageMin: b.ageMin,
      ageMax: b.ageMax,
      caption: b.caption,
      linkUrl: b.linkUrl
    });
    return res.status(result.ok ? 200 : 200).json({ success: result.ok, ...result });
  } catch (error) {
    console.error('[admin/meta-boost]', error);
    return res.status(200).json({ success: false, message: error.message || 'Boost mislukte.' });
  }
}
