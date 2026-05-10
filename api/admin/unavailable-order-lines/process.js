import { processUnavailableOrderLine } from '../../../lib/unavailable-order-line-service.js';
import { syncGlobalUnavailableOrderLines } from '../../../lib/srs-unavailable-global-sync-service.js';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-admin-pin, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || '12345';
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.admin_token ||
    req.body?.adminToken ||
    req.body?.admin_token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return token === adminToken;
}

function cleanStep(value) {
  return String(value || '').trim().toLowerCase();
}

function clean(value) {
  return String(value || '').trim();
}

function allowedSteps(steps) {
  const requested = Array.isArray(steps) && steps.length ? steps.map(cleanStep) : ['refund', 'srs_cancel'];
  return requested.filter((step) => step === 'refund' || step === 'srs_cancel');
}

function orderNrFromBody(body = {}) {
  return clean(
    body.orderNr ||
    body.order ||
    body.orderNumber ||
    body.weborderNr ||
    body.webOrderNr ||
    body.shopifyOrderNr ||
    body.shopifyOrderName ||
    body.srsOrderNr ||
    body.customerOrderNr ||
    body.klantBestellingNr ||
    body.klantbestellingNr ||
    ''
  ).replace(/^#/, '');
}

function rowIdFromRecord(record = {}, line = {}, index = 0) {
  return [
    record.id,
    line.fulfillmentId || '',
    line.orderLineNr || '',
    line.sku || line.barcode || '',
    index
  ].join('::');
}

function syncedIdsFromPreSync(preSync) {
  const records = [
    ...(Array.isArray(preSync?.records) ? preSync.records : []),
    ...(Array.isArray(preSync?.createdRecords) ? preSync.createdRecords : []),
    ...(Array.isArray(preSync?.duplicateRecords) ? preSync.duplicateRecords : [])
  ];

  const ids = [];
  for (const record of records) {
    const lines = Array.isArray(record.items) && record.items.length ? record.items : [{}];
    lines.forEach((line, index) => {
      ids.push(rowIdFromRecord(record, line, index));
      if (record.id) ids.push(record.id);
    });
  }

  return Array.from(new Set(ids.filter(Boolean)));
}

async function syncOrderIfProvided(orderNr) {
  if (!orderNr) return null;

  return syncGlobalUnavailableOrderLines({
    orderNr,
    statuses: 'unavailable,niet leverbaar,not available',
    maxRuntimeMs: 30000,
    maxRecords: 25,
    dryRun: false,
    includeResolved: true
  });
}

async function processWithFallbackIds({ id, fallbackIds = [], steps, employeeName, force }) {
  const attempts = Array.from(new Set([id, ...fallbackIds].map(clean).filter(Boolean)));
  const errors = [];

  for (const attemptId of attempts) {
    try {
      const result = await processUnavailableOrderLine({
        id: attemptId,
        steps,
        employeeName,
        force
      });
      return { result, attemptId, attempts, errors };
    } catch (error) {
      errors.push({ id: attemptId, message: error.message || 'Verwerking mislukt.' });
      const message = String(error.message || '').toLowerCase();
      if (!message.includes('niet-leverbare orderregel niet gevonden')) break;
    }
  }

  const last = errors[errors.length - 1];
  const error = new Error(last?.message || 'Verwerking mislukt.');
  error.attempts = attempts;
  error.errors = errors;
  throw error;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST is toegestaan.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    const body = req.body || {};
    const orderNr = orderNrFromBody(body);
    const requestedIds = Array.isArray(body.ids) ? body.ids : [body.id].filter(Boolean);

    const steps = allowedSteps(body.steps);
    if (!steps.length) {
      return res.status(400).json({ success: false, message: 'Geen geldige verwerkingstappen geselecteerd.' });
    }

    let preSync = null;
    try {
      preSync = await syncOrderIfProvided(orderNr);
    } catch (error) {
      preSync = {
        success: false,
        orderNr,
        message: error.message || 'SRS sync vooraf mislukt.'
      };
    }

    const syncedFallbackIds = syncedIdsFromPreSync(preSync);
    const ids = requestedIds.length ? requestedIds : syncedFallbackIds;

    if (!ids.length) {
      return res.status(400).json({
        success: false,
        message: orderNr
          ? `Geen lokale niet-leverbare orderregel gevonden of aangemaakt voor order ${orderNr}. Controleer of SRS deze order als unavailable/cancelled teruggeeft.`
          : 'Geen orderregel geselecteerd.',
        preSync,
        syncedFallbackIds
      });
    }

    const results = [];
    const errors = [];
    const partials = [];

    for (const id of ids) {
      try {
        const processed = await processWithFallbackIds({
          id,
          fallbackIds: syncedFallbackIds,
          steps,
          employeeName: body.employeeName || 'Administratie',
          force: Boolean(body.force)
        });
        const result = {
          ...processed.result,
          selectedId: id,
          processedId: processed.attemptId,
          idFallbackAttempts: processed.attempts,
          idFallbackErrors: processed.errors
        };
        results.push(result);
        if (result.partial || result.success === false) {
          partials.push({ id, message: result.message || 'Gedeeltelijk verwerkt. Controleer SRS cancel.' });
        }
      } catch (error) {
        errors.push({
          id,
          message: error.message || 'Verwerking mislukt.',
          attempts: error.attempts || [id],
          errors: error.errors || []
        });
      }
    }

    const doneCount = results.filter((item) => item.success && !item.partial).length;
    const partialCount = partials.length;
    const failedCount = errors.length;
    const hasProblems = partialCount > 0 || failedCount > 0;

    return res.status(hasProblems ? 207 : 200).json({
      success: !hasProblems,
      partial: hasProblems && results.length > 0,
      message: hasProblems
        ? `${doneCount} volledig verwerkt, ${partialCount} gedeeltelijk, ${failedCount} mislukt. ${[...partials, ...errors].map((item) => item.message).filter(Boolean).join(' | ')}`
        : `${doneCount} orderregel(s) volledig verwerkt.`,
      preSync,
      syncedFallbackIds,
      results,
      partials,
      errors
    });
  } catch (error) {
    console.error('[admin/unavailable-order-lines/process]', error);
    return res.status(500).json({ success: false, message: error.message || 'Niet-leverbare orderregels konden niet worden verwerkt.' });
  }
}
