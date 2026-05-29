import { getConfiguredGoogleStoreLocations, syncGoogleOpeningHoursToShopify } from '../../../lib/google-shopify-opening-hours.js';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, authorization');
}

function isAuthorized(req) {
  const expected = String(process.env.ADMIN_TOKEN || (globalThis.crypto?.randomUUID?.() || String(Math.random()))).trim();
  const given = String(req.headers['x-admin-token'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  return Boolean(expected && given && expected === given);
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  try {
    const dryRun = String(req.query.dryRun || 'false') === 'true';
    const includeRaw = String(req.query.includeRaw || 'false') === 'true';
    const storeFilter = String(req.query.store || '').trim().toLowerCase();

    const locations = getConfiguredGoogleStoreLocations().filter((location) => {
      if (!storeFilter) return true;
      return String(location.store || '').trim().toLowerCase() === storeFilter;
    });

    const results = [];
    const errors = [];

    for (const location of locations) {
      try {
        const result = await syncGoogleOpeningHoursToShopify(location, { dryRun, includeRaw });
        results.push(result);
      } catch (error) {
        errors.push({
          store: location.store || 'onbekend',
          message: error.message || String(error)
        });
      }
    }

    return res.status(200).json({
      success: errors.length === 0,
      dryRun,
      includeRaw,
      synced: results.length,
      failed: errors.length,
      results,
      errors
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Synchroniseren mislukt.'
    });
  }
}
