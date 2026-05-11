import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { listBusinessAccounts, listBusinessLocations } from '../../lib/google-business-profile-client.js';

function bool(value) {
  return ['1', 'true', 'yes', 'ja'].includes(String(value || '').trim().toLowerCase());
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (requireAdmin(req, res)) return;

  try {
    const includeLocations = bool(req.query.includeLocations);
    const accounts = await listBusinessAccounts();
    const rows = [];

    for (const account of accounts) {
      let locations = [];
      if (includeLocations) {
        try {
          const result = await listBusinessLocations({ accountId: account.accountId, pageSize: 100 });
          locations = result.locations || [];
        } catch (error) {
          locations = [{ error: error.message || String(error) }];
        }
      }
      rows.push({ ...account, locations });
    }

    return res.status(200).json({ success: true, source: 'Google Business Profile', accounts: rows });
  } catch (error) {
    return res.status(500).json({ success: false, source: 'Google Business Profile', message: error.message || 'Google Business accounts ophalen mislukt.' });
  }
}
