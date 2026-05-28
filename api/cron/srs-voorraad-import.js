/**
 * Cron: GET /api/cron/srs-voorraad-import
 * Schedule: '0 5 * * *' (dagelijks 05:00 UTC — na de nachtelijke SRS-export)
 *
 * Haalt de nieuwste voorraad_*.csv.gz + voorraadlocaties_*.csv.gz van de SRS
 * data-export SFTP, parsed ze en schrijft een snapshot via srs-voorraad-store.
 *
 * Query overrides:
 *   ?path=/sub      — andere remote directory (default '/')
 *   ?only=voorraad  — alleen voorraad importeren
 *   ?only=locaties  — alleen locaties importeren
 *
 * Handmatige trigger: admin-token via header of ?adminToken=.
 */

import { importVoorraad, importLocaties, importAll } from '../../lib/srs-voorraad-import.js';

function isAuthorized(req) {
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  if (ua.includes('vercel-cron')) return true;
  if (req.headers['x-vercel-cron']) return true;
  const adminToken = String(process.env.ADMIN_TOKEN || '').trim();
  const token = String(req.headers['x-admin-token'] || req.query?.adminToken || '').trim();
  return Boolean(adminToken && token && token === adminToken);
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen GET/POST.' });
  }
  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  const remotePath = String(req.query?.path || '/');
  const only = String(req.query?.only || '').toLowerCase();

  try {
    let result;
    if (only === 'voorraad') {
      result = { voorraad: await importVoorraad({ remotePath }), locaties: null, errors: [] };
    } else if (only === 'locaties') {
      result = { voorraad: null, locaties: await importLocaties({ remotePath }), errors: [] };
    } else {
      result = await importAll({ remotePath });
    }

    const ok = (result.voorraad || result.locaties) && result.errors.length === 0;
    return res.status(ok ? 200 : 207).json({
      success: ok,
      voorraad: result.voorraad
        ? { sourceFile: result.voorraad.sourceFile, rows: result.voorraad.rowCount }
        : null,
      locaties: result.locaties
        ? { sourceFile: result.locaties.sourceFile, rows: result.locaties.rowCount }
        : null,
      errors: result.errors.length ? result.errors : undefined,
      generatedAt: new Date().toISOString()
    });
  } catch (e) {
    console.error('[cron/srs-voorraad-import]', e);
    return res.status(500).json({ success: false, message: e.message || 'Import-fout.' });
  }
}

export default handler;
