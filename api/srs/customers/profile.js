import { handleCors, setCorsHeaders } from '../../../lib/cors.js';
import { getCustomers, getTransactions, getBills } from '../../../lib/srs-customers-client.js';
import { getStoreNameByBranchId } from '../../../lib/branch-metrics.js';
import { gradeCustomer } from '../../../lib/customer-grade.js';

function clean(value) {
  return String(value || '').trim();
}

function compact(value) {
  return clean(value).toLowerCase().replace(/\s+/g, '');
}

function cleanPhone(value) {
  return clean(value).replace(/[^0-9+]/g, '');
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(value));
}

function parseDutchPostalQuery(value) {
  const raw = clean(value).toUpperCase();
  const noSpaces = raw.replace(/\s+/g, '');

  const compactMatch = noSpaces.match(/^([1-9][0-9]{3}[A-Z]{2})([0-9]{1,5}[A-Z]?)?$/);
  if (compactMatch) {
    return {
      postalCode: compactMatch[1],
      houseNumber: compactMatch[2] || ''
    };
  }

  const spacedMatch = raw.match(/\b([1-9][0-9]{3})\s*([A-Z]{2})\b(?:\s+([0-9]{1,5}[A-Z]?))?/);
  if (spacedMatch) {
    return {
      postalCode: `${spacedMatch[1]}${spacedMatch[2]}`,
      houseNumber: spacedMatch[3] || ''
    };
  }

  return null;
}

function looksLikePhone(value) {
  const digits = clean(value).replace(/\D/g, '');
  return digits.length >= 9 && digits.length <= 13;
}

function normalizeQuery(req) {
  const query = clean(req.query.query || req.query.q || '');
  const customerId = clean(req.query.customerId || req.query.customer_id || '');
  const loyaltyCardId = clean(req.query.loyaltyCardId || req.query.cardId || req.query.card || '');
  const email = clean(req.query.email || '');
  const phone = clean(req.query.phone || req.query.telephone || '');
  const postalCode = clean(req.query.postalCode || req.query.postcode || '');
  const houseNumber = clean(req.query.houseNumber || req.query.house_number || '');

  const plans = [];

  if (customerId) plans.push({ type: 'customerId', filters: { customerId } });
  if (loyaltyCardId) plans.push({ type: 'loyaltyCardId', filters: { loyaltyCardId } });
  if (email) {
    if (isEmail(email)) plans.push({ type: 'email', filters: { email } });
    else plans.push({ type: 'text', text: email });
  }
  if (phone) plans.push({ type: 'phone', filters: { phone: cleanPhone(phone) || phone } });
  if (postalCode || houseNumber) {
    plans.push({
      type: 'postalCode',
      filters: {
        postalCode: postalCode.replace(/\s+/g, '').toUpperCase(),
        houseNumber
      }
    });
  }

  if (query) {
    const postal = parseDutchPostalQuery(query);
    const digits = query.replace(/\D/g, '');

    if (isEmail(query)) {
      plans.push({ type: 'email', filters: { email: query } });
    } else if (postal) {
      plans.push({ type: 'postalCode', filters: postal });
    } else if (looksLikePhone(query)) {
      plans.push({ type: 'phone', filters: { phone: cleanPhone(query) } });
      plans.push({ type: 'phone-original', filters: { phone: query } });
    } else if (/^\d+$/.test(query)) {
      plans.push({ type: 'customerId', filters: { customerId: query } });
      plans.push({ type: 'loyaltyCardId', filters: { loyaltyCardId: query } });
    } else {
      plans.push({ type: 'text', text: query });
    }
  }

  const uniquePlans = [];
  const seen = new Set();
  for (const plan of plans) {
    const key = JSON.stringify(plan);
    if (!seen.has(key)) {
      seen.add(key);
      uniquePlans.push(plan);
    }
  }

  return {
    query,
    plans: uniquePlans
  };
}

function customerSearchText(customer = {}) {
  return [
    customer.customerId,
    customer.CustomerId,
    customer.id,
    customer.loyaltyCardId,
    customer.cardId,
    customer.name,
    customer.fullName,
    customer.firstName,
    customer.lastName,
    customer.email,
    customer.emailAddress,
    customer.phone,
    customer.telephone,
    customer.postalCode,
    customer.city,
    customer.address1,
    customer.houseNumber
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function customerMatchesText(customer, query) {
  const q = clean(query).toLowerCase();
  if (!q) return false;

  const normal = customerSearchText(customer);
  const compactQ = compact(q);
  const compactCustomer = compact(customerSearchText(customer));
  const phoneQ = cleanPhone(q).replace(/^\+31/, '0');
  const phoneCustomer = cleanPhone(customer.phone || customer.telephone || '').replace(/^\+31/, '0');

  return (
    normal.includes(q) ||
    compactCustomer.includes(compactQ) ||
    (phoneQ && phoneCustomer.includes(phoneQ))
  );
}

function sumTransactions(transactions) {
  const orderCount = transactions.length;
  const totalSpend = transactions.reduce((sum, transaction) => sum + Number(transaction.total || 0), 0);
  const onlineCount = transactions.filter((transaction) => transaction.orderNr).length;
  const storeCount = orderCount - onlineCount;
  return { orderCount, totalSpend, onlineCount, storeCount };
}

async function findCustomers({ plans, query }) {
  const errors = [];

  for (const plan of plans) {
    if (!plan.filters) continue;

    try {
      const result = await getCustomers(plan.filters);
      const customers = result.customers || [];
      if (customers.length) {
        return {
          customers,
          source: `srs-filter-${plan.type}`,
          errors
        };
      }
    } catch (error) {
      errors.push({
        source: `srs-filter-${plan.type}`,
        message: error.message || String(error)
      });
    }
  }

  const textPlan = plans.find((plan) => plan.type === 'text') || (query ? { text: query } : null);
  if (textPlan?.text && clean(textPlan.text).length >= 2) {
    try {
      const result = await getCustomers({});
      const allCustomers = result.customers || [];
      const matches = allCustomers.filter((customer) => customerMatchesText(customer, textPlan.text));
      return {
        customers: matches,
        source: 'srs-local-text-search',
        sourceCustomerCount: allCustomers.length,
        errors
      };
    } catch (error) {
      errors.push({
        source: 'srs-local-text-search',
        message: error.message || String(error)
      });
    }
  }

  return {
    customers: [],
    source: 'not-found',
    errors
  };
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  }

  try {
    const normalized = normalizeQuery(req);

    if (!normalized.plans.length) {
      return res.status(400).json({
        success: false,
        message: 'Vul klantnummer, e-mail, telefoon, postcode, klantenkaart of naam in.'
      });
    }

    const search = await findCustomers(normalized);
    const customers = search.customers || [];
    const customer = customers[0] || null;

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Geen klant gevonden.',
        source: search.source,
        errors: search.errors || []
      });
    }

    const now = new Date();
    const fromDate = new Date(now);
    fromDate.setFullYear(fromDate.getFullYear() - 5);
    const from = `${fromDate.toISOString().slice(0, 10)}T00:00:00`;
    const until = `${now.toISOString().slice(0, 10)}T23:59:59`;

    const includeTransactions = String(req.query.includeTransactions || 'true') !== 'false';
    const includeBills = String(req.query.includeBills || 'true') !== 'false';

    const [transactionResult, billsResult] = await Promise.allSettled([
      includeTransactions ? getTransactions({ customerId: customer.customerId, from, until }) : Promise.resolve({ transactions: [] }),
      includeBills ? getBills({ customerId: customer.customerId, includePaid: true }) : Promise.resolve({ bills: [] })
    ]);

    const transactions = transactionResult.status === 'fulfilled' ? (transactionResult.value.transactions || []) : [];
    const bills = billsResult.status === 'fulfilled' ? (billsResult.value.bills || []) : [];
    const metrics = sumTransactions(transactions);
    const grade = gradeCustomer(metrics);

    const enrichedTransactions = transactions.map((transaction) => ({
      ...transaction,
      store: getStoreNameByBranchId(transaction.branchId)
    }));

    return res.status(200).json({
      success: true,
      source: search.source,
      sourceCustomerCount: search.sourceCustomerCount ?? customers.length,
      matchCount: customers.length,
      customers: customers.slice(0, 25).map((item) => ({
        ...item,
        registeredStore: getStoreNameByBranchId(item.registeredInBranchId)
      })),
      customer: {
        ...customer,
        registeredStore: getStoreNameByBranchId(customer.registeredInBranchId)
      },
      grade,
      metrics,
      stats: {
        orderCount: metrics.orderCount,
        totalSpent: metrics.totalSpend,
        totalSpend: metrics.totalSpend,
        onlineCount: metrics.onlineCount,
        storeCount: metrics.storeCount
      },
      transactions: enrichedTransactions,
      bills,
      errors: [
        ...(search.errors || []).map((item) => item.message).filter(Boolean),
        transactionResult.status === 'rejected' ? transactionResult.reason?.message : '',
        billsResult.status === 'rejected' ? billsResult.reason?.message : ''
      ].filter(Boolean)
    });
  } catch (error) {
    console.error('Customer profile error:', error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Klantprofiel kon niet worden opgehaald.'
    });
  }
}
