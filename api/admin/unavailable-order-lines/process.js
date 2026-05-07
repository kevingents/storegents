import { processUnavailableOrderLine } from '../../../lib/unavailable-order-line-service.js';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-admin-pin, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || '12345';
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.admin_token ||
    req.body?.adminToken ||
    req.body?.admin_token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return token === adminToken;
}

function cleanStep(value) {
  return String(value || '').trim().toLowerCase();
}

function allowedSteps(steps) {
  const requested = Array.isArray(steps) && steps.length ? steps.map(cleanStep) : ['refund', 'srs_cancel'];
  return requested.filter((step) => step === 'refund' || step === 'srs_cancel');
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST is toegestaan.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    const body = req.body || {};
    const ids = Array.isArray(body.ids) ? body.ids : [body.id].filter(Boolean);

    if (!ids.length) {
      return res.status(400).json({ success: false, message: 'Geen orderregel geselecteerd.' });
    }

    const steps = allowedSteps(body.steps);
    if (!steps.length) {
      return res.status(400).json({ success: false, message: 'Geen geldige verwerkingstappen geselecteerd.' });
    }

    const results = [];
    const errors = [];

    for (const id of ids) {
      try {
        results.push(await processUnavailableOrderLine({
          id,
          steps,
          employeeName: body.employeeName || 'Administratie',
          force: Boolean(body.force)
        }));
      } catch (error) {
        errors.push({ id, message: error.message || 'Verwerking mislukt.' });
      }
    }

    return res.status(errors.length ? 207 : 200).json({
      success: errors.length === 0,
      partial: errors.length > 0 && results.length > 0,
      message: errors.length
        ? `${results.length} verwerkt, ${errors.length} mislukt. ${errors.map((item) => item.message).filter(Boolean).join(' | ')}`
        : `${results.length} orderregel(s) verwerkt.`,
      results,
      errors
    });
  } catch (error) {
    console.error('[admin/unavailable-order-lines/process]', error);
    return res.status(500).json({ success: false, message: error.message || 'Niet-leverbare orderregels konden niet worden verwerkt.' });
  }
}
