import { handleCors, setCorsHeaders } from '../../../lib/cors.js';
import { getCustomers, getTransactions, getBills } from '../../../lib/srs-customers-client.js';
import { getStoreNameByBranchId } from '../../../lib/branch-metrics.js';
import { gradeCustomer } from '../../../lib/customer-grade.js';

function sumTransactions(transactions) {
  const orderCount = transactions.length;
  const totalSpend = transactions.reduce((sum, transaction) => sum + Number(transaction.total || 0), 0);
  const onlineCount = transactions.filter((transaction) => transaction.orderNr).length;
  const storeCount = orderCount - onlineCount;
  return { orderCount, totalSpend, onlineCount, storeCount };
}

function normalizeQuery(req) {
  const query = String(req.query.query || req.query.q || '').trim();
  const customerId = String(req.query.customerId || '').trim();
  const email = String(req.query.email || '').trim();
  const postalCode = String(req.query.postalCode || '').trim();
  const houseNumber = String(req.query.houseNumber || '').trim();
  if (customerId) return { customerId };
  if (email || query.includes('@')) return { email: email || query };
  if (postalCode || houseNumber) return { postalCode, houseNumber };
  if (/^\d+$/.test(query)) return { customerId: query };
  return { email: query };
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });

  try {
    const filters = normalizeQuery(req);
    if (!Object.values(filters).some(Boolean)) {
      return res.status(400).json({ success: false, message: 'Vul klantnummer, e-mail of postcode/huisnummer in.' });
    }

    const customersResult = await getCustomers(filters);
    const customers = customersResult.customers || [];
    const customer = customers[0] || null;
    if (!customer) return res.status(404).json({ success: false, message: 'Geen klant gevonden.' });

    const now = new Date();
    const fromDate = new Date(now);
    fromDate.setFullYear(fromDate.getFullYear() - 5);
    const from = fromDate.toISOString().slice(0, 10) + 'T00:00:00';
    const until = now.toISOString().slice(0, 10) + 'T23:59:59';

    const [transactionResult, billsResult] = await Promise.allSettled([
      getTransactions({ customerId: customer.customerId, from, until }),
      getBills({ customerId: customer.customerId, includePaid: true })
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
      customer: {
        ...customer,
        registeredStore: getStoreNameByBranchId(customer.registeredInBranchId)
      },
      grade,
      metrics,
      transactions: enrichedTransactions,
      bills,
      errors: [
        transactionResult.status === 'rejected' ? transactionResult.reason?.message : '',
        billsResult.status === 'rejected' ? billsResult.reason?.message : ''
      ].filter(Boolean)
    });
  } catch (error) {
    console.error('Customer profile error:', error);
    return res.status(error.status || 500).json({ success: false, message: error.message || 'Klantprofiel kon niet worden opgehaald.' });
  }
}
