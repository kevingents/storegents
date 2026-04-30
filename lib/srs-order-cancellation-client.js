import { receiveFulfillment, setFulfillmentBranch, getFulfillments, getWebordersWithDetails } from './srs-weborders-message-client.js';

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'ja'].includes(String(value).toLowerCase());
}

function getCancelMode() {
  return String(process.env.SRS_CANCEL_MODE || 'dry_run').toLowerCase();
}

export async function verifySrsCancellationTarget({ orderNr, branchId = '', items = [] }) {
  const fulfilmentsResult = await getFulfillments({ orderNr: String(orderNr || '').replace(/^#/, ''), branchId });
  const fulfilments = fulfilmentsResult.fulfillments || [];
  let details = null;

  try {
    details = await getWebordersWithDetails(String(orderNr || '').replace(/^#/, ''));
  } catch (error) {
    details = { detailsByOrder: new Map(), error: error.message };
  }

  if (!fulfilments.length) {
    return {
      ok: false,
      reason: 'Geen open SRS fulfilments gevonden voor deze order.',
      fulfilments,
      details
    };
  }

  if (items.length) {
    const wanted = new Set(items.map((item) => String(item.fulfillmentId || item.orderLineNr || item.sku || '').trim()).filter(Boolean));
    const found = fulfilments.some((item) => wanted.has(String(item.fulfillmentId || '').trim()) || wanted.has(String(item.orderLineNr || '').trim()) || wanted.has(String(item.sku || '').trim()));
    if (!found) {
      return {
        ok: false,
        reason: 'De geselecteerde regels zijn niet gevonden als open SRS fulfilment.',
        fulfilments,
        details
      };
    }
  }

  return { ok: true, fulfilments, details };
}

export async function cancelWeborderInSrs({ cancellation }) {
  const liveEnabled = boolEnv('SRS_CANCEL_LIVE_ENABLED', false);
  const mode = getCancelMode();

  if (!liveEnabled || mode === 'dry_run') {
    return {
      success: true,
      dryRun: true,
      mode,
      message: 'Dry-run: SRS annulering niet live uitgevoerd. Zet SRS_CANCEL_LIVE_ENABLED=true en configureer SRS_CANCEL_MODE zodra SRS de exacte annuleringactie bevestigt.'
    };
  }

  if (mode === 'set_fulfillment_unavailable') {
    throw new Error('SRS_CANCEL_MODE=set_fulfillment_unavailable is nog niet geimplementeerd omdat de exacte SRS SOAP action/velden ontbreken. Vraag SRS om de annuleringstransactie voor fulfilment/orderregel.');
  }

  if (mode === 'receive_then_manual') {
    throw new Error('receive_then_manual is bewust geblokkeerd: ontvangsten gebruiken als annulering kan voorraad/omzet vervuilen. Gebruik alleen de echte SRS annuleringstransactie.');
  }

  throw new Error(`Onbekende SRS_CANCEL_MODE: ${mode}`);
}
