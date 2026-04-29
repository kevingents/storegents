import { getVoucherLogs } from './voucher-log-store.js';

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

export async function resolveVoucherCustomer(customerId) {
  const id = String(customerId || '').trim();

  if (!id) {
    return null;
  }

  const staticMap = getStaticCustomerMap();

  if (staticMap[id]) {
    return {
      customerId: id,
      customerEmail: staticMap[id].email || staticMap[id].customerEmail || '',
      customerName: staticMap[id].name || staticMap[id].customerName || ''
    };
  }

  const logs = await getVoucherLogs();
  const existing = logs.find((log) => String(log.srsCustomerId || '') === id && log.customerEmail);

  if (existing) {
    return {
      customerId: id,
      customerEmail: existing.customerEmail,
      customerName: existing.customerName || ''
    };
  }

  return {
    customerId: id,
    customerEmail: '',
    customerName: ''
  };
}
