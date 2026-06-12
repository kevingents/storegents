import { updateOrderCancellation, getOrderCancellationById } from '../../../lib/order-cancellation-store.js';

/**
 * POST /api/admin/unavailable-order-lines/mark-processed
 *
 * Body: { id | cancellationId, employeeName?, note? }
 *
 * Markeert een niet-leverbare regel HANDMATIG als 'processed' — ZONDER een
 * Shopify-refund of SRS-cancel te triggeren. Bedoeld voor regels die al elders
 * zijn afgehandeld (bv. al gerefund in Shopify) of die niet via deze flow lopen
 * (Bol/POS). De lijst respecteert `processedAt`, dus de regel valt daarna weg uit
 * het open-overzicht. Géén geld-actie.
 */

function clean(value) {
  return String(value || '').trim();
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-admin-pin, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function isAuthorized(req) {
  const adminToken = clean(process.env.ADMIN_TOKEN);
  if (!adminToken) return false;
  const token = clean(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.admin_token ||
    req.body?.adminToken ||
    req.body?.admin_token ||
    ''
  ).replace(/^Bearer\s+/i, '');
  return token === adminToken;
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST is toegestaan.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const body = parseBody(req);
  // De lijst-rij heeft een samengestelde id (cancellationId::fulfillment::...); de
  // store indexeert op de pure cancellationId. Accepteer beide en pak het basis-deel.
  const raw = clean(body.cancellationId || body.id);
  const cancellationId = raw.includes('::') ? raw.split('::')[0] : raw;
  if (!cancellationId) {
    return res.status(400).json({ success: false, message: 'id of cancellationId is verplicht.' });
  }

  const employeeName = clean(body.employeeName) || 'Administratie';
  const note = clean(body.note) || 'Handmatig gemeld als verwerkt via portaal.';

  try {
    const existing = await getOrderCancellationById(cancellationId);
    if (!existing) {
      return res.status(404).json({ success: false, message: `Niet-leverbare regel ${cancellationId} niet gevonden.` });
    }

    const updated = await updateOrderCancellation(cancellationId, {
      status: 'processed',
      processedAt: new Date().toISOString(),
      processedBy: employeeName,
      manualProcessed: true,
      manualProcessedNote: note,
    });

    return res.status(200).json({
      success: true,
      cancellation: updated,
      message: 'Regel gemeld als verwerkt (geen refund of SRS-cancel uitgevoerd).',
    });
  } catch (error) {
    console.error('[unavailable-order-lines/mark-processed] error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Markeren als verwerkt mislukt.' });
  }
}
