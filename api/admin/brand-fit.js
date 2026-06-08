/**
 * /api/admin/brand-fit
 *
 * Merk-fit-score van uitingen tegen de GENTS brand assets (brandbook), via Claude.
 *
 *   POST { items: [{ id, imageUrl?, text?, kind? }] }  → score per item
 *   GET  ?source=google-ads                            → haalt lopende Google
 *        Ads-advertentieteksten op en scoort ze
 *
 * Cache-first per uiting (blob), dus herhaald scoren is gratis. Auth: admin-token.
 */

import { scoreBrandFit } from '../../lib/brand-fit.js';
import { getGoogleAdsCreatives } from '../../lib/google-ads-creatives.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 60;

const clean = (v) => String(v == null ? '' : v).trim();

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

/* Bounded-concurrency map zodat we Claude niet overspoelen. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); }
  });
  await Promise.all(workers);
  return out;
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const source = clean(req.query.source);
      if (source === 'google-ads') {
        const cre = await getGoogleAdsCreatives({ limit: Math.min(40, Number(req.query.limit) || 25) });
        if (!cre.ok) return res.status(200).json({ success: true, source, ok: false, error: cre.error, items: [] });
        const scored = await pool(cre.ads, 4, async (a) => ({
          ...a,
          fit: await scoreBrandFit({ text: a.text, kind: 'google-ad' }).catch((e) => ({ score: null, grade: '—', error: e.message }))
        }));
        const ok = scored.filter((a) => a.fit && a.fit.score != null);
        return res.status(200).json({
          success: true, source, ok: true, count: scored.length,
          avgScore: ok.length ? Math.round(ok.reduce((n, a) => n + a.fit.score, 0) / ok.length) : null,
          items: scored
        });
      }
      return res.status(400).json({ success: false, message: `Onbekende source: ${source}` });
    }

    if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen GET of POST.' });

    const body = parseBody(req);
    const items = Array.isArray(body.items) ? body.items.slice(0, 30) : [];
    if (!items.length) return res.status(400).json({ success: false, message: 'Geen items om te scoren.' });

    const scores = await pool(items, 4, async (it) => ({
      id: clean(it.id),
      fit: await scoreBrandFit({ imageUrl: it.imageUrl, text: it.text, kind: it.kind || 'social' }).catch((e) => ({ score: null, grade: '—', error: e.message }))
    }));

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({ success: true, scores });
  } catch (error) {
    console.error('[admin/brand-fit]', error);
    return res.status(500).json({ success: false, message: error.message || 'Merk-fit scoren mislukt.' });
  }
}
