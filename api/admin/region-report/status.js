import { getRegionReportConfig } from '../../../lib/region-report-config-store.js';
import { getAdminToken } from '../../../lib/gents-mail-config.js';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-admin-pin, authorization');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}
function isAuthorized(req) {
  const expected = getAdminToken() || String(process.env.ADMIN_TOKEN || (globalThis.crypto?.randomUUID?.() || String(Math.random()))).trim();
  const given = String(req.headers['x-admin-token'] || req.headers['x-admin-pin'] || req.query.adminToken || req.query.token || '').replace(/^Bearer\s+/i, '').trim();
  return Boolean(expected && given && expected === given);
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  const config = await getRegionReportConfig();
  return res.status(200).json({
    success: true,
    weborderMail: {
      endpoint: '/api/cron/weborder-mail-run',
      configured: true,
      schedule: '0 8 * * *',
      secretEnv: 'WEBORDER_MAIL_SECRET'
    },
    regionReport: {
      endpoint: '/api/cron/region-manager-weekly-report',
      configured: true,
      schedule: '0 8 * * 1',
      secretEnv: 'REGION_REPORT_SECRET',
      regions: config.regions || []
    }
  });
}
