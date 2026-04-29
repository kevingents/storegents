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
