import { listBranches, calculateOmnichannelScore } from '../../../lib/branch-metrics.js';
import { getWeborderRequests } from '../../../lib/weborder-request-store.js';
import { getVoucherLogs } from '../../../lib/voucher-log-store.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || '12345';
  return req.headers['x-admin-token'] === adminToken || String(req.query.public || '') === 'true';
}

function matchesPeriod(dateValue, from, to) {
  if (!dateValue) return false;
  const date = String(dateValue).slice(0, 10);
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });

  const dateTo = String(req.query.dateTo || new Date().toISOString().slice(0, 10));
  const dateFrom = String(req.query.dateFrom || (() => { const d = new Date(); d.setDate(d.getDate() - 7); return d.toISOString().slice(0, 10); })());

  try {
    const branches = listBranches();
    const voucherLogs = await getVoucherLogs().catch(() => []);
    const weborders = await getWeborderRequests().catch(() => []);

    const rows = branches.map((branch) => {
      const storeVouchers = voucherLogs.filter((log) => (log.store === branch.store || String(log.srsRedeemBranchId || '') === String(branch.branchId)) && matchesPeriod(log.createdAt, dateFrom, dateTo));
      const usedVouchers = storeVouchers.filter((log) => String(log.status || '').includes('gebruikt') || String(log.status || '').includes('afgeboekt'));
      const storeWeborders = weborders.filter((item) => (item.sellingStore === branch.store || item.fulfilmentStore === branch.store) && matchesPeriod(item.createdAt, dateFrom, dateTo));
      const customerRegistrations = Number(process.env[`SCORE_CUSTOMERS_${String(branch.branchId).replace(/\W/g, '_')}`] || 0);
      const loyaltyOptIn = Number(process.env[`SCORE_LOYALTY_${String(branch.branchId).replace(/\W/g, '_')}`] || 0);

      const score = calculateOmnichannelScore({
        customerRegistrations,
        loyaltyOptIn,
        voucherIssued: storeVouchers.length,
        voucherUsed: usedVouchers.length,
        labelCreated: storeWeborders.length
      });

      return {
        store: branch.store,
        branchId: branch.branchId,
        customerError: '',
        dataQuality: {
          fastMode: true,
          usesCustomerEnvTargets: true,
          sourceCustomerCount: 0
        },
        ...score
      };
    }).sort((a, b) => b.score - a.score || a.store.localeCompare(b.store));

    return res.status(200).json({
      success: true,
      dateFrom,
      dateTo,
      mode: 'fast-no-srs-timeout',
      note: 'Snelle score zonder trage SRS GetCustomers call. Klantinschrijvingen blijven 0 tenzij SCORE_CUSTOMERS_<branchId> env variabelen worden gevuld of een SRS klant export wordt gekoppeld.',
      dataQuality: { hasCustomerData: rows.some((row) => row.components.customerRegistrations > 0) },
      formula: {
        customerRegistrations: '35%',
        loyaltyOptInRate: '25%',
        voucherUsageRate: '25%',
        serviceLabelActivity: '15%'
      },
      rows
    });
  } catch (error) {
    console.error('Omnichannel scoreboard fast error:', error);
    return res.status(200).json({
      success: true,
      degraded: true,
      dateFrom,
      dateTo,
      mode: 'fallback',
      rows: branches.map((branch) => ({
        store: branch.store,
        branchId: branch.branchId,
        score: 0,
        components: { customerRegistrations: 0, loyaltyOptIn: 0, loyaltyRate: 0, voucherIssued: 0, voucherUsed: 0, voucherUsageRate: 0, labelCreated: 0 }
      }))
    });
  }
}
