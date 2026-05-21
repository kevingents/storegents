import { listBranches, getStoreNameByBranchId } from '../../lib/branch-metrics.js';
import { getOpenFulfillmentsByBranch } from '../../lib/srs-weborders-message-client.js';
import { getWeborderRequests, normalizeWeborder } from '../../lib/weborder-request-store.js';
import { setCachedWeborders } from '../../lib/srs-weborders-cache.js';
import { requireCronSecret } from '../../lib/gents-mail-config.js';
import { trackedCron } from '../../lib/cron-auto-track.js';

function shouldUseSrs() {
  return String(process.env.SRS_OPEN_WEBORDERS_SOURCE || 'local').toLowerCase() !== 'local';
}

async function refreshStore(branchId, store, localItems) {
  try {
    const srsItems = await getOpenFulfillmentsByBranch(branchId, { includeDetails: false });
    const all = [
      ...srsItems.map((item) =>
        normalizeWeborder({
          ...item,
          fulfilmentBranchId: item.fulfilmentBranchId || branchId,
          fulfillmentBranchId: item.fulfilmentBranchId || branchId,
          fulfilmentStore: item.fulfilmentStore || store,
          fulfillmentStore: item.fulfilmentStore || store
        })
      ),
      ...localItems
    ];

    const deduped = Array.from(
      new Map(all.map((item) => [item.fulfillmentId || item.id || `${item.orderNr}-${item.sku}-${branchId}`, item])).values()
    );

    await setCachedWeborders(store, {
      source: 'srs_cache',
      store,
      branchId,
      items: deduped,
      count: deduped.length
    });

    return { store, ok: true, count: deduped.length };
  } catch (error) {
    return { store, ok: false, error: error.message };
  }
}

async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireCronSecret(req, res, 'CRON_SECRET')) return;

  if (!shouldUseSrs()) {
    return res.status(200).json({ success: true, skipped: true, note: 'SRS_OPEN_WEBORDERS_SOURCE=local, cache refresh overgeslagen.' });
  }

  const localItems = (await getWeborderRequests()).map(normalizeWeborder);
  const branches = listBranches().filter((b) => {
    const name = b.store || getStoreNameByBranchId(b.branchId);
    return name && !name.includes('Magazijn') && !name.includes('Showroom') && !name.includes('Brandstores');
  });

  const results = await Promise.allSettled(
    branches.map(({ branchId, store }) => refreshStore(String(branchId), store || getStoreNameByBranchId(String(branchId)), localItems))
  );

  const summary = results.map((r) => (r.status === 'fulfilled' ? r.value : { ok: false, error: r.reason?.message }));
  const ok = summary.filter((s) => s.ok).length;
  const failed = summary.filter((s) => !s.ok).length;

  console.log(`[srs-cache-refresh] ${ok} winkels bijgewerkt, ${failed} mislukt.`);

  return res.status(200).json({ success: true, refreshed: ok, failed, stores: summary });
}

export default trackedCron('srs-cache-refresh', handler);
