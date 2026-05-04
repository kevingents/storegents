import { handleCors, setCorsHeaders, requireAdmin } from '../../../lib/cors.js';
import { getCustomers } from '../../../lib/srs-customers-client.js';
import { listBranches, getBranchIdByStore } from '../../../lib/branch-metrics.js';

function isoDate(d) { return d.toISOString().slice(0, 10); }
function monthStart() { const d = new Date(); d.setDate(1); return isoDate(d); }
function today() { return isoDate(new Date()); }
function inPeriod(customer, from, to) {
  const date = String(customer.createdAt || '').slice(0, 10);
  if (!date) return false;
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (requireAdmin(req, res)) return;

  try {
    const dateFrom = String(req.query.dateFrom || monthStart()).trim();
    const dateTo = String(req.query.dateTo || today()).trim();
    const store = String(req.query.store || '').trim();
    const branchId = String(req.query.branchId || getBranchIdByStore(store) || '').trim();

    const result = await getCustomers({
      registeredInBranchId: branchId,
      createdFrom: `${dateFrom}T00:00:00`,
      createdUntil: `${dateTo}T23:59:59`
    });

    const branches = branchId ? listBranches().filter((b) => String(b.branchId) === branchId) : listBranches();
    const customers = (result.customers || []).filter((c) => inPeriod(c, dateFrom, dateTo));

    const rows = branches.map((branch) => {
      const branchCustomers = customers.filter((customer) => String(customer.registeredInBranchId || '') === String(branch.branchId));
      const withEmail = branchCustomers.filter((customer) => customer.email).length;
      const withoutEmail = branchCustomers.length - withEmail;
      return {
        store: branch.store,
        branchId: branch.branchId,
        total: branchCustomers.length,
        withEmail,
        withoutEmail,
        emailRate: branchCustomers.length ? Math.round((withEmail / branchCustomers.length) * 100) : 0,
        customers: branchCustomers
      };
    });

    const totals = rows.reduce((acc, row) => {
      acc.total += row.total;
      acc.withEmail += row.withEmail;
      acc.withoutEmail += row.withoutEmail;
      return acc;
    }, { total: 0, withEmail: 0, withoutEmail: 0 });
    totals.emailRate = totals.total ? Math.round((totals.withEmail / totals.total) * 100) : 0;

    return res.status(200).json({ success: true, dateFrom, dateTo, store, branchId, totals, rows });
  } catch (error) {
    console.error('Monthly customer report error:', error);
    return res.status(error.status || 500).json({ success: false, message: error.message || 'Maandrapportage klanten kon niet worden opgehaald.' });
  }
}
