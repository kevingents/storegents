import { put } from '@vercel/blob';
import { handleCors, setCorsHeaders, requireAdmin } from '../lib/cors.js';

/**
 * GET /api/test-blob — smoke-test voor Vercel Blob.
 *
 * Vereist ADMIN_TOKEN (was eerder publiek → DoS-risico: elke call maakte
 * een nieuwe blob, kostte storage + lekte blob.url).
 */
export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);

  if (requireAdmin(req, res)) return;

  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return res.status(500).json({
        success: false,
        message: 'BLOB_READ_WRITE_TOKEN ontbreekt.'
      });
    }

    const blob = await put(
      `tests/blob-test-${Date.now()}.txt`,
      'Blob werkt',
      {
        access: 'public',
        addRandomSuffix: false,
        contentType: 'text/plain'
      }
    );

    return res.status(200).json({
      success: true,
      url: blob.url
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
}
