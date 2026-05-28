/**
 * /api/admin/voorraad-import
 *
 * POST (of GET) → triggert de SRS voorraad-import handmatig vanuit de portal.
 * Identieke logica als de cron, maar mét CORS-headers zodat de browser hem
 * kan aanroepen (de cron-endpoint heeft géén CORS — wordt door Vercel-cron
 * server-side getriggerd).
 *
 * Query:
 *   ?only=voorraad | ?only=locaties   — beperk tot 1 type
 *   ?path=/sub                         — andere remote directory
 *
 * Auth: admin-token vereist.
 */

import { importVoorraad, importLocaties, importAll } from '../../lib/srs-voorraad-import.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

/* Ruime timeout — SFTP + gunzip + parse van ~55k rijen + blob-write. */
export const maxDuration = 120;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen GET/POST.' });
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
      voorraad: result.voorraad ? { sourceFile: result.voorraad.sourceFile, rows: result.voorraad.rowCount } : null,
      locaties: result.locaties ? { sourceFile: result.locaties.sourceFile, rows: result.locaties.rowCount } : null,
      errors: result.errors.length ? result.errors : undefined,
      generatedAt: new Date().toISOString()
    });
  } catch (e) {
    console.error('[admin/voorraad-import]', e);
    return res.status(500).json({ success: false, message: e.message || 'Import-fout.' });
  }
}
