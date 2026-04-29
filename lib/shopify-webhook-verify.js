import crypto from 'crypto';

export async function readRawBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

export function verifyShopifyWebhook(rawBody, hmacHeader) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_API_SECRET || '';

  if (!secret) {
    throw new Error('SHOPIFY_WEBHOOK_SECRET ontbreekt.');
  }

  if (!hmacHeader) {
    return false;
  }

  const digest = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('base64');

  const received = Buffer.from(String(hmacHeader), 'utf8');
  const expected = Buffer.from(digest, 'utf8');

  if (received.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(received, expected);
}
