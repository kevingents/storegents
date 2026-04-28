import { put } from '@vercel/blob';
import { handleCors, setCorsHeaders } from '../lib/cors.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);

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
