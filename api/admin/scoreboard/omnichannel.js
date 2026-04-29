import { listBranches, calculateOmnichannelScore } from '../../../lib/branch-metrics.js';
import { getVoucherLogs } from '../../../lib/voucher-log-store.js';
import { getSrsOpenWeborders } from '../../../lib/srs-open-weborders-client.js';
import { normalizeWeborder, isOpenWeborderStatus } from '../../../lib/weborder-request-store.js';
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

function storeMatchesWeborder(item, store, branchId) {
  return item.sellingStore === store
    || item.fulfilmentStore === store
    || String(item.sellingBranchId || '') === String(branchId)
    || String(item.fulfilmentBranchId || '') === String(branchId);
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
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');

  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });

  const dateTo = String(req.query.dateTo || new Date().toISOString().slice(0, 10));
  const dateFrom = String(req.query.dateFrom || (() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  })());

  const branches = listBranches();

  try {
    const voucherLogs = await getVoucherLogs().catch(() => []);
    const weborderResult = await getSrsOpenWeborders({}).catch((error) => ({
      source: 'none',
      degraded: true,
      note: error.message,
      items: []
    }));

    const weborders = (weborderResult.items || []).map(normalizeWeborder);

    const rows = branches.map((branch) => {
      const storeVouchers = voucherLogs.filter((log) =>
        (log.store === branch.store || String(log.srsRedeemBranchId || '') === String(branch.branchId))
        && matchesPeriod(log.createdAt, dateFrom, dateTo)
      );

      const usedVouchers = storeVouchers.filter((log) =>
        String(log.status || '').includes('gebruikt') || String(log.status || '').includes('afgeboekt')
      );

      const storeWeborders = weborders.filter((item) => storeMatchesWeborder(item, branch.store, branch.branchId));
      const openWeborders = storeWeborders.filter((item) => isOpenWeborderStatus(item.status));
      const overdueWeborders = openWeborders.filter((item) => item.overdue);

      const customerRegistrations = Number(process.env[`SCORE_CUSTOMERS_${String(branch.branchId).replace(/\W/g, '_')}`] || 0);
      const loyaltyOptIn = Number(process.env[`SCORE_LOYALTY_${String(branch.branchId).replace(/\W/g, '_')}`] || 0);

      const base = calculateOmnichannelScore({
        customerRegistrations,
        loyaltyOptIn,
        voucherIssued: storeVouchers.length,
        voucherUsed: usedVouchers.length,
        labelCreated: openWeborders.length
      });

      const overduePenalty = Math.min(25, overdueWeborders.length * Number(process.env.SCORE_OVERDUE_WEBORDER_PENALTY || 5));
      const finalScore = Math.max(0, Number(base.score || 0) - overduePenalty);

      return {
        store: branch.store,
        branchId: branch.branchId,
        score: finalScore,
        baseScore: base.score,
        overduePenalty,
        customerError: '',
        dataQuality: {
          fastMode: true,
          weborderSource: weborderResult.source,
          hasWeborderData: openWeborders.length > 0,
          usesCustomerEnvTargets: true
        },
        components: {
          ...base.components,
          openWeborders: openWeborders.length,
          overdueWeborders: overdueWeborders.length,
          overduePenalty
        }
      };
    }).sort((a, b) => b.score - a.score || a.store.localeCompare(b.store));

    return res.status(200).json({
      success: true,
      dateFrom,
      dateTo,
      mode: 'weborders-deadline-score',
      note: weborderResult.note || 'Score bevat nu ook open weborders en aftrek voor orders ouder dan 48 uur.',
      dataQuality: {
        hasCustomerData: rows.some((row) => row.components.customerRegistrations > 0),
        weborderSource: weborderResult.source,
        weborderDegraded: Boolean(weborderResult.degraded)
      },
      formula: {
        customerRegistrations: '35%',
        loyaltyOptInRate: '25%',
        voucherUsageRate: '25%',
        serviceActivity: '15%',
        overdueWeborders: `-${process.env.SCORE_OVERDUE_WEBORDER_PENALTY || 5} punten per order > 2 dagen, max -25`
      },
      rows
    });
  } catch (error) {
    console.error('Omnichannel scoreboard error:', error);
    return res.status(200).json({
      success: true,
      degraded: true,
      dateFrom,
      dateTo,
      mode: 'fallback',
      note: error.message || 'Scorebord fallback gebruikt.',
      rows: branches.map((branch) => ({
        store: branch.store,
        branchId: branch.branchId,
        score: 0,
        components: {
          customerRegistrations: 0,
          loyaltyOptIn: 0,
          loyaltyRate: 0,
          voucherIssued: 0,
          voucherUsed: 0,
          voucherUsageRate: 0,
          labelCreated: 0,
          openWeborders: 0,
          overdueWeborders: 0,
          overduePenalty: 0
        }
      }))
    });
  }
}
