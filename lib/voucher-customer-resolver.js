import { getVoucherLogs } from './voucher-log-store.js';
import { getCustomers } from './srs-customers-client.js';

function getStaticCustomerMap() {
  const raw = process.env.SRS_CUSTOMER_EMAIL_MAP_JSON || '';

  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error('SRS_CUSTOMER_EMAIL_MAP_JSON is ongeldig:', error);
    return {};
  }
}

function removeLeadingLetters(value) {
  return String(value || '').trim().replace(/^[A-Za-z]+/, '');
}

function customerLookupIds(id) {
  const clean = String(id || '').trim();
  const noLetters = removeLeadingLetters(clean);
  return Array.from(new Set([clean, noLetters].filter(Boolean)));
}

function customerName(customer) {
  return String(
    customer?.name ||
    [customer?.title, customer?.firstName, customer?.lastName].filter(Boolean).join(' ') ||
    ''
  ).trim();
}

async function resolveFromSrs(customerId) {
  for (const id of customerLookupIds(customerId)) {
    try {
      const result = await getCustomers({ customerId: id });
      const customer = result.customers?.find((item) => String(item.customerId || '').trim() === String(id)) || result.customers?.[0];

      if (customer?.customerId || customer?.email || customer?.name) {
        return {
          customerId: String(customer.customerId || id),
          customerEmail: String(customer.email || '').trim().toLowerCase(),
          customerName: customerName(customer),
          source: 'srs_customers'
        };
      }
    } catch (error) {
      console.error('SRS voucher customer resolve error:', id, error.message);
    }
  }

  return null;
}

export async function resolveVoucherCustomer(customerId) {
  const id = String(customerId || '').trim();

  if (!id) {
    return {
      customerId: '',
      customerEmail: '',
      customerName: '',
      source: ''
    };
  }

  const staticMap = getStaticCustomerMap();

  if (staticMap[id]) {
    return {
      customerId: id,
      customerEmail: staticMap[id].email || staticMap[id].customerEmail || '',
      customerName: staticMap[id].name || staticMap[id].customerName || '',
      source: 'static_map'
    };
  }

  const logs = await getVoucherLogs();
  const existing = logs.find((log) => String(log.srsCustomerId || '') === id && log.customerEmail);

  if (existing) {
    return {
      customerId: id,
      customerEmail: existing.customerEmail,
      customerName: existing.customerName || '',
      source: 'voucher_logs'
    };
  }

  const srsCustomer = await resolveFromSrs(id);
  if (srsCustomer) return srsCustomer;

  return {
    customerId: id,
    customerEmail: '',
    customerName: '',
    source: ''
  };
}
