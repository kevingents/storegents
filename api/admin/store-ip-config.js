/**
 * Admin endpoint voor winkel-IP-config:
 *
 *   GET  /api/admin/store-ip-config
 *        → { stores: { 'GENTS Almere': {branchId, ipv4:[], ipv6:[]}, ... } }
 *   POST /api/admin/store-ip-config
 *        body: { store, ipv4: [...], ipv6: [...] }
 *        → voegt extra IPs toe (defaults blijven altijd actief).
 *
 * Defaults uit lib/store-ip-config.js zijn hardcoded; admin kan via dit endpoint
 * extra IPs toevoegen zonder Vercel-deploy.
 */

import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { getStoreIpConfig, addStoreIpOverride } from '../../lib/store-ip-config.js';

export const maxDuration = 15;

function parseBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

function clean(v) { return String(v == null ? '' : v).trim(); }

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const cfg = await getStoreIpConfig({ refresh: true });
      return res.status(200).json({ success: true, stores: cfg.stores, generatedAt: cfg.generatedAt });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const store = clean(body.store);
      if (!store) return res.status(400).json({ success: false, message: 'store verplicht.' });
      const ipv4 = Array.isArray(body.ipv4) ? body.ipv4.map(clean).filter(Boolean) : [];
      const ipv6 = Array.isArray(body.ipv6) ? body.ipv6.map(clean).filter(Boolean) : [];
      if (!ipv4.length && !ipv6.length) {
        return res.status(400).json({ success: false, message: 'Minstens één IPv4 of IPv6 verplicht.' });
      }
      const result = await addStoreIpOverride(store, { ipv4, ipv6 });
      return res.status(200).json({ success: true, store, override: result });
    }

    return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
  } catch (e) {
    console.error('[admin/store-ip-config]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
