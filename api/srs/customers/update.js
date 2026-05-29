import { handleCors, setCorsHeaders } from '../../../lib/cors.js';
import { updateCustomer } from '../../../lib/srs-customers-client.js';

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || (globalThis.crypto?.randomUUID?.() || String(Math.random()));
  const token = String(
    req.headers['x-admin-token'] ||
    req.query.adminToken ||
    req.query.admin_token ||
    ''
  ).trim();
  return token === adminToken;
}

function normalizeBody(req) {
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body || {};
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

/**
 * POST /api/srs/customers/update
 * Body: { customerId, email?, allowMailings? }
 *
 * Voert een partial update uit op SRS via de Customers Transactions Update.
 * Op dit moment ondersteund: email toevoegen/wijzigen, allowMailings togglen.
 */
export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, error: 'Niet bevoegd.' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Alleen POST is toegestaan.' });
  }

  const body = normalizeBody(req);
  const customerId = String(body.customerId || body.CustomerId || '').trim();
  const email = String(body.email || '').trim();
  const hasAllowMailings = typeof body.allowMailings === 'boolean';

  if (!customerId) {
    return res.status(400).json({ success: false, error: 'customerId is verplicht.' });
  }

  if (!email && !hasAllowMailings) {
    return res.status(400).json({ success: false, error: 'Geef minimaal een email of allowMailings veld op om te updaten.' });
  }

  if (email && !isEmail(email)) {
    return res.status(400).json({ success: false, error: 'E-mailadres is geen geldig formaat.' });
  }

  try {
    const payload = { customerId };
    if (email) payload.email = email;
    if (hasAllowMailings) payload.allowMailings = body.allowMailings;

    const result = await updateCustomer(payload);

    if (!result.success) {
      return res.status(502).json({
        success: false,
        error: `SRS Update gaf status "${result.status || 'onbekend'}".`,
        srsStatus: result.status || ''
      });
    }

    return res.status(200).json({
      success: true,
      message: email ? `E-mailadres bijgewerkt voor klant ${customerId}.` : `Klant ${customerId} bijgewerkt.`,
      customerId,
      email: email || null,
      srsStatus: result.status || 'completed'
    });
  } catch (error) {
    console.error('[srs/customers/update]', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Klantupdate mislukt.'
    });
  }
}
