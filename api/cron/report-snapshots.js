/**
 * Cron: GET /api/cron/report-snapshots
 * Schedule: nachtelijk (vercel.json)
 *
 * Pre-warmt de zware Shopify-scan-rapporten door ze met ?refresh=1 te draaien.
 * De endpoints schrijven hun resultaat naar een blob-snapshot, zodat de portal
 * (en Channable) ze daarna DIRECT serveren — ook na een koude start.
 *
 * Historische data verandert niet, dus 1x per nacht herberekenen is genoeg.
 */

import { trackedCron } from '../../lib/cron-auto-track.js';
import { isCronAuthorized } from '../../lib/cron-auth.js';

export const maxDuration = 300;

/* Endpoints die een zware Shopify-order-scan doen en een blob-snapshot wegschrijven. */
const TARGETS = [
  '/api/admin/retour-cohort?months=12&refresh=1',
  '/api/admin/retour-cohort?months=24&refresh=1',
  '/api/admin/retour-product-feed?format=json&months=12&refresh=1'
];

async function warm(req, path) {
  const host = req.headers['host'];
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const adminToken = process.env.ADMIN_TOKEN || '';
  const sep = path.includes('?') ? '&' : '?';
  const url = `${proto}://${host}${path}${sep}adminToken=${encodeURIComponent(adminToken)}&t=${Date.now()}`;
  const startedAt = Date.now();
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  const ms = Date.now() - startedAt;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json().catch(() => ({}));
  return { ok: d.success !== false, ms, message: d.message || '' };
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen GET/POST.' });
  if (!isCronAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  /* Sequentieel: elke scan is zwaar — niet parallel om Shopify-rate-limits te sparen. */
  const results = [];
  for (const path of TARGETS) {
    try { results.push({ path, ...(await warm(req, path)) }); }
    catch (e) { results.push({ path, ok: false, error: e.message }); }
  }

  return res.status(200).json({
    success: true,
    warmed: results.filter((r) => r.ok).length,
    total: TARGETS.length,
    results
  });
}

export default trackedCron('report-snapshots', handler);
