import { put, list } from '@vercel/blob';

const SRS_RETURN_LOG_PATH = 'srs-returns/returns.json';

async function readBlobText(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error('SRS retourlog kon niet worden gelezen.');
  }

  return response.text();
}

/**
 * Hydrate een legacy log-record: oude records hebben geen shopifyRefunded /
 * refundedAt / srsCancelled / srsCancelledAt velden, maar wél success +
 * srsTransactionId. Bereken de workflow-status on-read zodat de Retouren-
 * overzicht UI ook voor oude data de juiste "1 → 2"-stappen toont.
 */
function hydrateLegacyLog(log) {
  if (!log || typeof log !== 'object') return log;
  if (log.shopifyRefunded !== undefined && log.refundedAt !== undefined &&
      log.srsCancelled !== undefined && log.srsCancelledAt !== undefined) {
    return log; /* al gemigreerd */
  }
  const success = Boolean(log.success);
  const refundDone = success && (Boolean(log.shopifyRefundId) || Number(log.refundAmount || 0) > 0);
  const srsDone = success && Boolean(log.srsTransactionId) && !log.srsSkipped;
  return {
    ...log,
    shopifyRefunded: log.shopifyRefunded ?? refundDone,
    refundedAt: log.refundedAt ?? (refundDone ? (log.createdAt || null) : null),
    srsCancelled: log.srsCancelled ?? srsDone,
    srsCancelledAt: log.srsCancelledAt ?? (srsDone ? (log.createdAt || null) : null)
  };
}

export async function getSrsReturnLogs({ strict = false } = {}) {
  try {
    const result = await list({
      prefix: SRS_RETURN_LOG_PATH,
      limit: 1
    });

    const blob = result.blobs.find((item) => item.pathname === SRS_RETURN_LOG_PATH);

    if (!blob) {
      return []; /* legitiem leeg = eerste run */
    }

    const raw = await readBlobText(blob.url);
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.map(hydrateLegacyLog) : [];
  } catch (error) {
    console.error('Read SRS return logs error:', error);
    /* strict:true (voor write-paden) MAG geen lege array teruggeven —
       caller zou anders de hele retour-log overschrijven. Read-paden
       (UI/overzicht) blijven fail-soft. */
    if (strict) throw error;
    return [];
  }
}

export async function saveSrsReturnLogs(logs) {
  await put(
    SRS_RETURN_LOG_PATH,
    JSON.stringify(logs, null, 2),
    {
      access: 'public',
      allowOverwrite: true,
      contentType: 'application/json',
      cacheControlMaxAge: 60
    }
  );
}

export async function createSrsReturnLog(input) {
  /* Defensieve check: weiger logs zonder orderNr EN zonder shopifyOrderId
     tenzij expliciet `allowOrphan: true` is meegegeven. Voorkomt dat
     onbedoelde retouren zonder order-koppeling in de Blob terechtkomen
     (geen Shopify auto-refund mogelijk).
     Zet REJECT_ORPHAN_RETURN_LOGS=false in env om de check tijdelijk
     uit te zetten als historische import nodig is. */
  const allowOrphan = Boolean(input.allowOrphan);
  const rejectOrphans = String(process.env.REJECT_ORPHAN_RETURN_LOGS || 'true').toLowerCase() !== 'false';
  const hasOrderRef = String(input.orderNr || '').trim() || String(input.shopifyOrderId || '').trim();
  if (rejectOrphans && !allowOrphan && !hasOrderRef) {
    throw new Error('Retour-log heeft geen orderNr of shopifyOrderId. Geef minstens één door, of zet allowOrphan:true voor handmatige imports.');
  }

  const logs = await getSrsReturnLogs({ strict: true });

  const now = new Date().toISOString();
  const success = Boolean(input.success);
  const srsTransactionId = input.srsTransactionId || '';
  const srsSkipped = Boolean(input.srsSkipped);
  const shopifyRefundId = input.shopifyRefundId || '';
  /* Een refund is "echt gelukt" als:
     - success === true (Shopify-refund call slaagde)
     - er een shopifyRefundId is OF refundAmount > 0 + status != 'error'
     SRS-cancel is gelukt wanneer er een srsTransactionId is EN niet bewust
     overgeslagen (toggle "srsRestock"). */
  const refundCompleted = success && (Boolean(shopifyRefundId) || Number(input.refundAmount || 0) > 0);
  const srsCancelCompleted = success && Boolean(srsTransactionId) && !srsSkipped;

  const log = {
    id: String(Date.now()),
    store: input.store || '',
    employeeName: input.employeeName || '',
    orderNr: input.orderNr || '',
    shopifyOrderId: input.shopifyOrderId || '',
    shopifyRefundId,
    branchId: input.branchId || '',
    status: input.status || (success ? 'completed' : 'error'),
    success,
    srsTransactionId,
    srsSkipped,
    items: input.items || [],
    message: input.message || '',
    error: input.error || '',
    reasonChecked: Boolean(input.reasonChecked),
    crossSellMade: Boolean(input.crossSellMade),
    crossSellAmount: Number(input.crossSellAmount || 0) || 0,
    /* Klant-info voor historie-lookup (toegevoegd 2026-05) */
    customerEmail: String(input.customerEmail || '').trim().toLowerCase(),
    customerName: String(input.customerName || '').trim(),
    customerId: String(input.customerId || '').trim(),
    reason: input.reason || '',
    refundAmount: Number(input.refundAmount || 0) || 0,
    /* Workflow-status timestamps (toegevoegd 2026-05) — gebruikt door de
       Retouren overzicht UI om Stap 1 (Shopify refund) en Stap 2 (SRS cancel)
       als "gedaan" te markeren. Zonder deze velden bleven workflows altijd
       als "Nog uit te voeren" staan, ook na succesvolle refunds. */
    shopifyRefunded: refundCompleted,
    refundedAt: refundCompleted ? now : null,
    srsCancelled: srsCancelCompleted,
    srsCancelledAt: srsCancelCompleted ? now : null,
    createdAt: now
  };

  logs.unshift(log);
  await saveSrsReturnLogs(logs);

  return log;
}
