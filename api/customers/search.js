import { getCustomers } from '../../lib/srs-customers-client.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

function normalizePostalCode(value) {
  return String(value || '').replace(/\s+/g, '').toUpperCase();
}

function parseQuery(query) {
  const q = String(query || '').trim();

  if (!q) return {};

  if (/^\d+$/.test(q) && q.length <= 8) {
    return { customerId: q };
  }

  if (q.includes('@')) {
    return { email: q };
  }

  const postalHouseMatch = q.match(/^([1-9][0-9]{3}\s?[A-Z]{2})\s*([0-9]+[A-Z0-9\-\/]*)?$/i);
  if (postalHouseMatch) {
    return {
      postalCode: normalizePostalCode(postalHouseMatch[1]),
      houseNumber: postalHouseMatch[2] || ''
    };
  }

  return { email: q };
}

function compactCustomer(customer) {
  const house = [customer.houseNumber, customer.houseNumberSuffix].filter(Boolean).join('');
  return {
    customerId: customer.customerId || '',
    name: customer.displayName || [customer.firstName, customer.lastName].filter(Boolean).join(' ') || '',
    firstName: customer.firstName || '',
    lastName: customer.lastName || '',
    email: customer.email || '',
    phone: customer.phone || '',
    street: customer.street || '',
    houseNumber: house || customer.houseNumber || '',
    postalCode: customer.postalCode || '',
    city: customer.city || '',
    country: customer.country || 'NL',
    allowMailings: customer.allowMailings,
    receivesLoyaltyPoints: customer.receivesLoyaltyPoints,
    registeredInBranchId: customer.registeredInBranchId || ''
  };
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);

  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      message: 'Alleen GET is toegestaan.'
    });
  }

  try {
    const query = String(req.query.q || req.query.query || '').trim();
    const email = String(req.query.email || '').trim();
    const customerId = String(req.query.customerId || '').trim();
    const postalCode = normalizePostalCode(req.query.postalCode || '');
    const houseNumber = String(req.query.houseNumber || '').trim();

    let filters = {};

    if (customerId) {
      filters.customerId = customerId;
    } else if (email) {
      filters.email = email;
    } else if (postalCode || houseNumber) {
      filters.postalCode = postalCode;
      filters.houseNumber = houseNumber;
    } else {
      filters = parseQuery(query);
    }

    if (!Object.keys(filters).length) {
      return res.status(400).json({
        success: false,
        message: 'Vul een klantnummer, e-mail of postcode + huisnummer in.'
      });
    }

    const result = await getCustomers(filters);
    const customers = (result.customers || []).map(compactCustomer).slice(0, 20);

    return res.status(200).json({
      success: true,
      filters,
      count: customers.length,
      customers
    });
  } catch (error) {
    console.error('Customer search error:', error);

    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Klant kon niet worden opgezocht.',
      details: error.fault || null
    });
  }
}
