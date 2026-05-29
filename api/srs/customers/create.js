/**
 * POST /api/srs/customers/create
 *
 * Body: { firstName, lastName, email, phone, title, gender, birthDate, store }
 *
 * Maakt een SRS klantkaart aan via createCustomer(). Branch wordt afgeleid
 * uit `store` via branch-metrics.
 *
 * Auth: admin-token (winkel-context).
 */

import { createCustomer } from '../../../lib/srs-customers-client.js';
import { getBranchIdByStore } from '../../../lib/branch-metrics.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

function isAuthorized(req) {
  const adminToken = String(process.env.ADMIN_TOKEN || (globalThis.crypto?.randomUUID?.() || String(Math.random()))).trim();
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query?.adminToken ||
    req.body?.adminToken ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return Boolean(adminToken && token && token === adminToken);
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST.' });

  const body = parseBody(req);
  const firstName = String(body.firstName || '').trim();
  const lastName = String(body.lastName || '').trim();
  const email = String(body.email || '').trim();
  const phone = String(body.phone || '').trim();
  const gender = String(body.gender || '').trim();
  const title = String(body.title || '').trim();
  const birthDate = String(body.birthDate || '').trim(); /* YYYY-MM-DD */
  const store = String(body.store || '').trim();
  const allowMailings = body.allowMailings !== false; /* default opt-in */
  const receivesLoyaltyPoints = body.receivesLoyaltyPoints !== false;

  /* Validatie */
  if (!firstName || !lastName) {
    return res.status(400).json({ success: false, message: 'Voornaam en achternaam zijn verplicht.' });
  }
  if (email && !validateEmail(email)) {
    return res.status(400).json({ success: false, message: 'Ongeldig e-mailadres.' });
  }
  if (!email && !phone) {
    return res.status(400).json({ success: false, message: 'Geef minimaal e-mail of telefoon op.' });
  }

  const registeredInBranchId = body.registeredInBranchId || (store ? getBranchIdByStore(store) : '') || '';

  try {
    const result = await createCustomer({
      firstName, lastName, email, phone, title, gender, birthDate,
      registeredInBranchId,
      allowMailings,
      receivesLoyaltyPoints
    });

    const customer = (result.customers || [])[0] || null;
    return res.status(200).json({
      success: true,
      status: result.status,
      customer,
      customerId: customer?.customerId || customer?.id || null
    });
  } catch (error) {
    console.error('[srs/customers/create]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Klant kon niet worden aangemaakt in SRS.'
    });
  }
}
