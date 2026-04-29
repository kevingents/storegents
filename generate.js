import { getWeborderRequests } from '../../lib/weborder-request-store.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  try {
    const requests = await getWeborderRequests();

    return res.status(200).json({
      success: true,
      endpoint: '/api/weborders/health',
      hasBlobToken: Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.VERCEL_BLOB_READ_WRITE_TOKEN),
      requestCount: requests.length,
      message: 'Weborder API is actief.'
    });
  } catch (error) {
    return res.status(200).json({
      success: true,
      endpoint: '/api/weborders/health',
      degraded: true,
      hasBlobToken: Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.VERCEL_BLOB_READ_WRITE_TOKEN),
      requestCount: 0,
      message: 'Weborder API is actief, maar weborderlog kon niet worden gelezen.',
      error: error.message
    });
  }
}
