import { handleCors, setCorsHeaders, isAdminRequest } from '../../lib/cors.js';
import { KNOWN_CRONS } from '../../lib/cron-config-store.js';

/**
 * POST /api/admin/cron-trigger
 *
 * Triggert handmatig een cron-handler (zelfde als wat Vercel zou doen). De
 * handler ziet ?force=true zodat cron-guard hem niet skipt vanwege rate-limit.
 *
 * Body: { key: 'daily-loyalty-vouchers' }
 *
 * Response: doorgegeven response van de cron-handler.
 *
 * Veiligheid: alleen admin-token, alleen bekende crons.
 */

function field(value) {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST.' });
  if (!isAdminRequest(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const body = req.body || {};
  const key = String(field(body.key) || '').trim();
  if (!key) return res.status(400).json({ success: false, message: 'Cron key ontbreekt.' });

  if (!KNOWN_CRONS.find((c) => c.key === key)) {
    return res.status(400).json({ success: false, message: `Onbekende cron-key: ${key}` });
  }

  const startedAt = Date.now();

  try {
    /* Self-call naar de cron-endpoint met ?force=true en admin-token */
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers.host;
    const baseUrl = `${proto}://${host}`;
    const adminToken = String(process.env.ADMIN_TOKEN || '12345').trim();

    /* Extra query-params die de caller meegeeft (bv. daysBack, maxCustomers) */
    const extraParams = typeof body.params === 'object' && body.params !== null ? body.params : {};
    const qs = new URLSearchParams({
      force: 'true',
      adminToken,
      ...Object.fromEntries(Object.entries(extraParams).map(([k, v]) => [k, String(v)]))
    }).toString();

    const url = `${baseUrl}/api/cron/${encodeURIComponent(key)}?${qs}`;

    const r = await fetch(url, {
      method: 'GET',
      headers: {
        'x-admin-token': adminToken,
        'Accept': 'application/json'
      }
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    return res.status(200).json({
      success: r.ok,
      cron: key,
      httpStatus: r.status,
      durationMs: Date.now() - startedAt,
      response: data
    });
  } catch (error) {
    console.error('[admin/cron-trigger] error:', error);
    return res.status(500).json({
      success: false,
      cron: key,
      durationMs: Date.now() - startedAt,
      message: error.message || 'Trigger faalde.'
    });
  }
}
