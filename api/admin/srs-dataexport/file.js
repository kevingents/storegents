/**
 * /api/admin/srs-dataexport/file
 *
 * GET ?path=/foo/bar.xml&mode=preview&maxBytes=65536
 *     → { success, preview, previewBytes, totalSize, truncated, modifyTime }
 *
 * GET ?path=/foo/bar.xml&mode=download
 *     → Sends file as attachment (Content-Disposition). Max 5 MB.
 *
 * Auth: admin-token vereist.
 */

import { downloadFile, previewFile } from '../../../lib/srs-dataexport-sftp-client.js';
import { corsJson, requireAdmin } from '../../../lib/request-guards.js';
import path from 'node:path';

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET.' });
  }

  const filePath = String(req.query?.path || '').trim();
  if (!filePath) {
    return res.status(400).json({ success: false, message: 'path query-param is verplicht.' });
  }
  const mode = String(req.query?.mode || 'preview').toLowerCase();

  try {
    if (mode === 'download') {
      const { content, size, modifyTime } = await downloadFile(filePath);
      const filename = path.basename(filePath) || 'export.bin';
      const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', String(buf.length));
      if (modifyTime) res.setHeader('Last-Modified', modifyTime);
      return res.status(200).send(buf);
    }

    const maxBytes = Math.min(512 * 1024, Math.max(1024, Number(req.query?.maxBytes) || 64 * 1024));
    const data = await previewFile(filePath, maxBytes);
    return res.status(200).json({
      success: true,
      path: filePath,
      ...data,
      generatedAt: new Date().toISOString()
    });
  } catch (e) {
    console.error('[admin/srs-dataexport/file]', e);
    return res.status(500).json({ success: false, message: e.message || 'SFTP-fout.' });
  }
}
