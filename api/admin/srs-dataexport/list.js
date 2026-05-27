/**
 * /api/admin/srs-dataexport/list
 *
 * GET ?path=/foo/bar  → { success, path, entries: [...] }
 *
 * Lijst de inhoud van een directory op de SRS data-export SFTP-server.
 * Default path = '/' (root).
 *
 * Auth: admin-token vereist.
 */

import { listDirectory } from '../../../lib/srs-dataexport-sftp-client.js';
import { corsJson, requireAdmin } from '../../../lib/request-guards.js';

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET.' });
  }

  try {
    const path = String(req.query?.path || '/');
    const data = await listDirectory(path);
    return res.status(200).json({
      success: true,
      ...data,
      generatedAt: new Date().toISOString()
    });
  } catch (e) {
    console.error('[admin/srs-dataexport/list]', e);
    return res.status(500).json({ success: false, message: e.message || 'SFTP-fout.' });
  }
}
