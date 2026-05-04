import { getWeborderRequests, normalizeWeborder } from './weborder-request-store.js';
import { listBranches, getStoreNameByBranchId } from './branch-metrics.js';
import { getOpenFulfillmentsByBranch } from './srs-weborders-message-client.js';

function shouldUseSrs() {
  return String(process.env.SRS_OPEN_WEBORDERS_SOURCE || 'local').toLowerCase() !== 'local';
}

export async function getSrsOpenWeborders({ store, branchId } = {}) {
  const local = (await getWeborderRequests()).map(normalizeWeborder);

  if (!shouldUseSrs()) {
    return {
      source: 'local_weborder_tool_log',
      note: 'SRS_OPEN_WEBORDERS_SOURCE=local. Dit toont alleen weborders uit de portaal-tool.',
      items: local
    };
  }

  try {
    const branchIds = branchId
      ? [String(branchId)]
      : listBranches().map((branch) => String(branch.branchId)).filter(Boolean);

    const all = [];

    for (const id of branchIds) {
      const items = await getOpenFulfillmentsByBranch(id, { includeDetails: String(process.env.SRS_WEBORDERS_INCLUDE_DETAILS || 'false') === 'true' });
      all.push(...items.map((item) => normalizeWeborder({
        ...item,
        fulfilmentBranchId: item.fulfilmentBranchId || id,
        fulfillmentBranchId: item.fulfilmentBranchId || id,
        fulfilmentStore: item.fulfilmentStore || getStoreNameByBranchId(id),
        fulfillmentStore: item.fulfilmentStore || getStoreNameByBranchId(id)
      })));
    }

    const merged = [...all, ...local];
    const deduped = Array.from(new Map(merged.map((item) => [item.fulfillmentId || item.id || `${item.orderNr}-${item.sku}-${item.fulfilmentBranchId}`, item])).values());

    return {
      source: 'srs_get_fulfillments',
      note: '',
      items: deduped
    };
  } catch (error) {
    return {
      source: 'local_weborder_tool_log',
      degraded: true,
      note: `SRS GetFulfillments kon niet worden opgehaald: ${error.message}. Lokale fallback gebruikt.`,
      items: local
    };
  }
}
export async function getOpenFulfillmentsByBranch(branchId, options = {}) {
  const statuses = Array.isArray(options.statuses) && options.statuses.length
    ? options.statuses
    : ['accepted', 'pending'];

  const includeDetails = Boolean(options.includeDetails);
  const all = [];

  for (const status of statuses) {
    try {
      const result = await getFulfillments({
        branchId,
        status
      });

      all.push(...(result.fulfillments || []));
    } catch (error) {
      console.error('[srs-weborders-message-client] getOpenFulfillmentsByBranch failed:', {
        branchId,
        status,
        message: error.message
      });
    }
  }

  if (!includeDetails) {
    return all;
  }

  const byOrder = new Map();

  for (const item of all) {
    const orderNr = String(item.orderNr || item.orderId || '').replace(/^#/, '').trim();
    if (!orderNr || byOrder.has(orderNr)) continue;

    try {
      const details = await getWebordersWithDetails(orderNr);
      byOrder.set(orderNr, details.detailsByOrder?.get(orderNr) || null);
    } catch (error) {
      console.error('[srs-weborders-message-client] getWebordersWithDetails failed:', {
        orderNr,
        message: error.message
      });
      byOrder.set(orderNr, null);
    }
  }

  return all.map((item) => {
    const orderNr = String(item.orderNr || item.orderId || '').replace(/^#/, '').trim();
    const detail = byOrder.get(orderNr);

    if (!detail) return item;

    return {
      ...item,
      customerName: item.customerName || detail.customerName || '',
      customerEmail: item.customerEmail || detail.customerEmail || '',
      customerPhone: item.customerPhone || detail.customerPhone || '',
      deliveryStreet: item.deliveryStreet || detail.deliveryStreet || '',
      deliveryHouseNumber: item.deliveryHouseNumber || detail.deliveryHouseNumber || '',
      deliveryPostalCode: item.deliveryPostalCode || detail.deliveryPostalCode || '',
      deliveryCity: item.deliveryCity || detail.deliveryCity || '',
      deliveryCountry: item.deliveryCountry || detail.deliveryCountry || '',
      items: detail.items || item.items || []
    };
  });
}
