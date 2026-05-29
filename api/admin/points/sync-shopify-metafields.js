import {
  loginSrsPointsService,
  getPointsBalance,
  getPointsMutations,
  getLatestBranchByCustomer
} from '../../../lib/srs-points-client.js';
import {
  findShopifyCustomerBySrsCustomerId,
  updateShopifyCustomerMetafields
} from '../../../lib/shopify-gift-card-client.js';
import {
  appendPointsSyncLog,
  getPointsSyncLogs
} from '../../../lib/points-sync-log-store.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || (globalThis.crypto?.randomUUID?.() || String(Math.random()));
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return token === adminToken;
}

function field(value) {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function getBranchName(branchId) {
  const raw = process.env.SRS_BRANCH_MAP_JSON || '';
  if (!raw || !branchId) return '';

  try {
    const map = JSON.parse(raw);
    return map[String(branchId)] || '';
  } catch (error) {
    console.error('SRS_BRANCH_MAP_JSON is ongeldig:', error);
    return '';
  }
}

function getRange(req) {
  const query = req.query || {};
  const body = req.body || {};

  const customerFrom = field(query.customerFrom || body.customerFrom || process.env.POINTS_SYNC_CUSTOMER_FROM || '1').trim();
  const customerTo = field(query.customerTo || body.customerTo || process.env.POINTS_SYNC_CUSTOMER_TO || '999999999').trim();
  const dateTo = field(query.dateTo || body.dateTo || new Date().toISOString().slice(0, 10)).trim();
  const dateFrom = field(query.dateFrom || body.dateFrom || process.env.POINTS_SYNC_DATE_FROM || '2000-01-01').trim();
  const mutationDays = Number(query.mutationDays || body.mutationDays || process.env.POINTS_SYNC_MUTATION_DAYS || 90) || 90;
  const mutationDateFrom = field(query.mutationDateFrom || body.mutationDateFrom || '').trim()
    || new Date(Date.now() - 1000 * 60 * 60 * 24 * mutationDays).toISOString().slice(0, 10);

  return { customerFrom, customerTo, dateFrom, dateTo, mutationDateFrom };
}

function removeLeadingLetters(value) {
  return String(value || '').trim().replace(/^[A-Za-z]+/, '');
}

function uniqueIds(ids) {
  return Array.from(new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)));
}

function customerLookupIds(...ids) {
  const values = [];

  ids.forEach((id) => {
    const clean = String(id || '').trim();
    if (!clean) return;
    const withoutLetters = removeLeadingLetters(clean);
    values.push(withoutLetters, clean);
  });

  return uniqueIds(values);
}

async function findShopifyCustomerForSrsIds({ ids, namespace, key }) {
  for (const id of customerLookupIds(...ids)) {
    const customer = await findShopifyCustomerBySrsCustomerId(id, namespace, key);
    if (customer?.id) {
      return { customer, matchedSrsCustomerId: id };
    }
  }

  return { customer: null, matchedSrsCustomerId: '' };
}

async function runSync(req) {
  const dryRun = String(req.query.dryRun || req.body?.dryRun || '') === 'true';
  const pointsNamespace = String(process.env.POINTS_METAFIELD_NAMESPACE || 'gents');
  const balanceKey = String(process.env.POINTS_METAFIELD_BALANCE_KEY || 'spaarpunten_saldo');
  const updatedKey = String(process.env.POINTS_METAFIELD_UPDATED_KEY || 'spaarpunten_laatst_bijgewerkt');
  const srsCustomerNamespace = String(process.env.SRS_CUSTOMER_ID_METAFIELD_NAMESPACE || 'SRSERP');
  const srsCustomerKey = String(process.env.SRS_CUSTOMER_ID_METAFIELD_KEY || 'customer_id');

  const range = getRange(req);
  const sessionId = await loginSrsPointsService();
  const [{ balances }, { mutations }] = await Promise.all([
    getPointsBalance({
      customerFrom: range.customerFrom,
      customerTo: range.customerTo,
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      sessionId
    }),
    getPointsMutations({
      customerFrom: range.customerFrom,
      customerTo: range.customerTo,
      dateFrom: range.mutationDateFrom,
      dateTo: range.dateTo,
      sessionId
    })
  ]);

  const latestBranchByCustomer = getLatestBranchByCustomer(mutations);
  const results = [];

  for (const balance of balances) {
    const srsCustomerId = String(balance.customerId || '').trim();
    const originalSrsCustomerId = String(balance.originalCustomerId || '').trim();
    const normalizedSrsCustomerId = removeLeadingLetters(originalSrsCustomerId || srsCustomerId);
    if (!srsCustomerId && !originalSrsCustomerId) continue;

    const latestMutation = latestBranchByCustomer.get(srsCustomerId);
    const branchId = latestMutation?.branchId || '';
    const branchName = getBranchName(branchId);

    try {
      const lookup = await findShopifyCustomerForSrsIds({
        ids: [normalizedSrsCustomerId, srsCustomerId, originalSrsCustomerId],
        namespace: srsCustomerNamespace,
        key: srsCustomerKey
      });
      const customer = lookup.customer;

      if (!customer?.id) {
        const log = await appendPointsSyncLog({
          type: 'unmatched_customer',
          status: 'not_found',
          message: `Geen Shopify klant gevonden met ${srsCustomerNamespace}.${srsCustomerKey}.`,
          srsCustomerId,
          originalSrsCustomerId,
          pointsBalance: balance.balance,
          branchId,
          branchName,
          details: {
            latestMutation: latestMutation || null,
            normalizedSrsCustomerId,
            triedCustomerIds: customerLookupIds(normalizedSrsCustomerId, srsCustomerId, originalSrsCustomerId)
          }
        });

        results.push({ success: false, reason: 'shopify_customer_not_found', srsCustomerId, originalSrsCustomerId, normalizedSrsCustomerId, branchId, branchName, logId: log.id });
        continue;
      }

      if (!dryRun) {
        await updateShopifyCustomerMetafields(customer.id, [
          {
            namespace: pointsNamespace,
            key: balanceKey,
            type: 'number_integer',
            value: String(Math.round(Number(balance.balance || 0)))
          },
          {
            namespace: pointsNamespace,
            key: updatedKey,
            type: 'date_time',
            value: new Date().toISOString()
          }
        ]);
      }

      results.push({
        success: true,
        srsCustomerId,
        originalSrsCustomerId,
        normalizedSrsCustomerId,
        matchedSrsCustomerId: lookup.matchedSrsCustomerId,
        pointsBalance: balance.balance,
        branchId,
        branchName,
        shopifyCustomerId: customer.id,
        shopifyCustomerEmail: customer.email || '',
        dryRun
      });
    } catch (error) {
      const log = await appendPointsSyncLog({
        type: 'sync_error',
        status: 'error',
        message: error.message || 'Spaarpunten sync fout.',
        srsCustomerId,
        originalSrsCustomerId,
        pointsBalance: balance.balance,
        branchId,
        branchName,
        details: { stack: error.stack || '', normalizedSrsCustomerId }
      });

      results.push({ success: false, reason: 'error', srsCustomerId, originalSrsCustomerId, normalizedSrsCustomerId, branchId, branchName, error: error.message, logId: log.id });
    }
  }

  return {
    dryRun,
    range,
    lookupMetafield: `${srsCustomerNamespace}.${srsCustomerKey}`,
    pointsMetafield: `${pointsNamespace}.${balanceKey}`,
    totalBalances: balances.length,
    processed: results.length,
    updated: results.filter((item) => item.success).length,
    unmatched: results.filter((item) => item.reason === 'shopify_customer_not_found').length,
    failed: results.filter((item) => item.reason === 'error').length,
    results
  };
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);

  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ success: false, message: 'Alleen GET of POST is toegestaan.' });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  if (req.method === 'GET' && String(req.query.logs || '') === 'true') {
    const logs = await getPointsSyncLogs();
    return res.status(200).json({ success: true, count: logs.length, logs: logs.slice(0, Number(req.query.limit || 100) || 100) });
  }

  try {
    const result = await runSync(req);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error('Spaarpunten Shopify metafield sync error:', error);
    await appendPointsSyncLog({
      type: 'run_error',
      status: 'error',
      message: error.message || 'Spaarpunten sync-run mislukt.',
      details: { stack: error.stack || '' }
    });

    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Spaarpunten konden niet worden gesynchroniseerd.',
      details: error.fault || null
    });
  }
}
