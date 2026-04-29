import { listBranches } from '../../../lib/branch-metrics.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || '12345';
  return req.headers['x-admin-token'] === adminToken;
}

export default async function handler(req, res) {
  if (String(process.env.DISABLE_ADMIN_REPORTS || '').toLowerCase() === 'true' && String(req.query.force || '') !== 'true') {
    return res.status(200).json({
      success: true,
      disabled: true,
      message: 'Admin rapportages zijn tijdelijk uitgeschakeld om SRS/server te ontlasten.',
      rows: [],
      totals: { total: 0, open: 0, used: 0, openCount: 0, overdueCount: 0, storeCount: 0 }
    });
  }

  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });

  const dateFrom = String(req.query.dateFrom || '');
  const dateTo = String(req.query.dateTo || '');
  const rows = listBranches().map((branch) => ({
    store: branch.store,
    branchId: branch.branchId,
    total: Number(process.env[`SCORE_CUSTOMERS_${String(branch.branchId).replace(/\W/g, '_')}`] || 0),
    withEmail: 0,
    mailingOptIn: 0,
    loyaltyOptIn: Number(process.env[`SCORE_LOYALTY_${String(branch.branchId).replace(/\W/g, '_')}`] || 0),
    emailRate: 0,
    mailingOptInRate: 0,
    loyaltyOptInRate: 0,
    customers: []
  }));

  const totals = rows.reduce((acc, row) => {
    acc.total += row.total;
    acc.withEmail += row.withEmail;
    acc.mailingOptIn += row.mailingOptIn;
    acc.loyaltyOptIn += row.loyaltyOptIn;
    return acc;
  }, { total: 0, withEmail: 0, mailingOptIn: 0, loyaltyOptIn: 0, emailRate: 0, mailingOptInRate: 0, loyaltyOptInRate: 0 });

  return res.status(200).json({
    success: true,
    mode: 'fast-no-srs-timeout',
    dateFrom,
    dateTo,
    note: 'SRS GetCustomers per periode veroorzaakte timeouts. Deze snelle rapportage blijft beschikbaar. Voor echte aantallen is een officiële SRS klant-export/filter op CreatedAt + RegisteredInBranchId nodig.',
    totals,
    rows,
    errors: []
  });
}
