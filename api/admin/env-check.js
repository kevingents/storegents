import { handleCors, setCorsHeaders } from '../../lib/cors.js';

/**
 * GET /api/admin/env-check
 *
 * Checkt aanwezigheid van kritische env-vars zonder de waarden bloot te leggen.
 * Returnt alleen booleans + length-preview.
 */

const CRITICAL_VARS = [
  { key: 'ADMIN_TOKEN', label: 'Admin token', category: 'auth', required: true },
  { key: 'SHOPIFY_ADMIN_ACCESS_TOKEN', label: 'Shopify admin token', category: 'shopify', required: true, fallbacks: ['SHOPIFY_ADMIN_API_TOKEN', 'SHOPIFY_ACCESS_TOKEN'] },
  { key: 'SHOPIFY_STORE_DOMAIN', label: 'Shopify shop domain', category: 'shopify', required: true, fallbacks: ['SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_STORE_URL'] },
  { key: 'SHOPIFY_API_VERSION', label: 'Shopify API version', category: 'shopify', required: false },
  { key: 'SRS_MESSAGE_USER', label: 'SRS API user', category: 'srs', required: true, fallbacks: ['SRS_USER', 'SRS_USERNAME'] },
  { key: 'SRS_MESSAGE_PASSWORD', label: 'SRS API password', category: 'srs', required: true, fallbacks: ['SRS_PASSWORD'] },
  { key: 'RETURNISTA_API_TOKEN', label: 'Returnista API token', category: 'returnista', required: false },
  { key: 'RETURNISTA_ACCOUNT_ID', label: 'Returnista account ID', category: 'returnista', required: false },
  { key: 'RESEND_API_KEY', label: 'Resend (mail) API key', category: 'mail', required: true },
  { key: 'SUPPORT_EMAIL', label: 'Support email recipient', category: 'mail', required: false },
  { key: 'BLOB_READ_WRITE_TOKEN', label: 'Vercel Blob token', category: 'storage', required: true },
  { key: 'SENDCLOUD_PUBLIC_KEY', label: 'Sendcloud public key', category: 'sendcloud', required: false },
  { key: 'SENDCLOUD_SECRET_KEY', label: 'Sendcloud secret key', category: 'sendcloud', required: false }
];

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

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const results = CRITICAL_VARS.map((v) => {
    const candidates = [v.key, ...(v.fallbacks || [])];
    let foundKey = null;
    let value = '';
    for (const k of candidates) {
      if (process.env[k]) { foundKey = k; value = String(process.env[k]); break; }
    }
    const present = Boolean(value);
    return {
      key: v.key,
      label: v.label,
      category: v.category,
      required: v.required,
      present,
      foundAt: foundKey,
      length: value.length,
      preview: present ? `${value.slice(0, 4)}…${value.slice(-3)}` : null,
      severity: v.required && !present ? 'error' : present ? 'ok' : 'optional'
    };
  });

  const missing = results.filter((r) => r.required && !r.present);
  const optionalMissing = results.filter((r) => !r.required && !r.present);
  const okCount = results.filter((r) => r.present).length;

  /* Group by category */
  const byCategory = {};
  results.forEach((r) => {
    if (!byCategory[r.category]) byCategory[r.category] = [];
    byCategory[r.category].push(r);
  });

  return res.status(200).json({
    success: true,
    summary: {
      total: results.length,
      ok: okCount,
      missingRequired: missing.length,
      missingOptional: optionalMissing.length,
      allRequiredPresent: missing.length === 0
    },
    byCategory,
    items: results,
    runtimeInfo: {
      nodeVersion: process.version,
      platform: process.platform,
      vercelEnv: process.env.VERCEL_ENV || 'local',
      vercelRegion: process.env.VERCEL_REGION || null
    }
  });
}
