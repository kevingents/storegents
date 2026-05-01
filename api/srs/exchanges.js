import { getAllOpenstaandeUitwisselingen, processOpenstaandeUitwisselingen } from '../../lib/srs-exchanges-client.js';
import { getSrsBranchId } from '../../lib/srs-branches.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { enrichOpenExchangeState } from '../../lib/srs-exchange-open-state-store.js';

function normalizeStore(value) {
  return String(value || '').trim();
}

function parseBody(req) {
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch (_error) {
      return {};
    }
  }
  return req.body || {};
}

function filterForStore(exchanges, store) {
  if (!store || store === 'GENTS Administratie') return exchanges;

  const branchId = getSrsBranchId(store);

  return exchanges.filter((exchange) => {
    return String(exchange.vanFiliaal) === String(branchId) || String(exchange.naarFiliaal) === String(branchId);
  });
}

function filterIncomingForStore(exchanges, store) {
  if (!store || store === 'GENTS Administratie') return exchanges;

  const branchId = getSrsBranchId(store);

  return exchanges.filter((exchange) => {
    return String(exchange.naarFiliaal) === String(branchId);
  });
}

function buildSummary(exchanges) {
  const byBranch = new Map();

  for (const exchange of exchanges) {
    for (const side of ['van', 'naar']) {
      const branchId = side === 'van' ? exchange.vanFiliaal : exchange.naarFiliaal;
      const store = side === 'van' ? exchange.vanWinkel : exchange.naarWinkel;

      if (!branchId) continue;

      if (!byBranch.has(branchId)) {
        byBranch.set(branchId, {
          branchId,
          store: store || `Filiaal ${branchId}`,
          outgoing: 0,
          incoming: 0,
          itemCount: 0,
          overdue: 0,
          oldestOpenDays: 0
        });
      }

      const row = byBranch.get(branchId);
      if (side === 'van') row.outgoing += 1;
      if (side === 'naar') row.incoming += 1;
      row.itemCount += Number(exchange.itemCount || 0);
      if (exchange.isOverdue) row.overdue += 1;
      row.oldestOpenDays = Math.max(row.oldestOpenDays, Number(exchange.openDays || 0));
    }
  }

  return Array.from(byBranch.values()).sort((a, b) => {
    return (b.overdue - a.overdue) ||
      (b.oldestOpenDays - a.oldestOpenDays) ||
      ((b.incoming + b.outgoing) - (a.incoming + a.outgoing)) ||
      String(a.store).localeCompare(String(b.store), 'nl');
  });
}

async function getCurrentOpenExchanges({ from, until, days, store = '' }) {
  const result = await getAllOpenstaandeUitwisselingen({ from, until, days });
  const enriched = await enrichOpenExchangeState(result.exchanges || []);
  const exchanges = filterForStore(enriched, store);

  return {
    ...result,
    exchanges
  };
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);

  try {
    if (req.method === 'GET') {
      const store = normalizeStore(req.query.store);
      const from = String(req.query.from || '').trim();
      const until = String(req.query.until || '').trim();
      const days = Number(req.query.days || 60);

      const result = await getCurrentOpenExchanges({ from, until, days, store });
      const exchanges = result.exchanges || [];
      const overdue = exchanges.filter((exchange) => exchange.isOverdue);

      return res.status(200).json({
        success: true,
        store,
        from: result.from,
        until: result.until,
        count: exchanges.length,
        itemCount: exchanges.reduce((sum, exchange) => sum + Number(exchange.itemCount || 0), 0),
        overdueCount: overdue.length,
        oldestOpenDays: exchanges.reduce((max, exchange) => Math.max(max, Number(exchange.openDays || 0)), 0),
        warning: overdue.length ? `${overdue.length} uitwisseling(en) staan langer dan 7 dagen open.` : '',
        summary: buildSummary(exchanges),
        exchanges
      });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const store = normalizeStore(body.store || req.query.store);
      const from = String(body.from || req.query.from || '').trim();
      const until = String(body.until || req.query.until || '').trim();
      const days = Number(body.days || req.query.days || 60);

      const exchangeIds = Array.isArray(body.exchangeIds)
        ? body.exchangeIds.map(String)
        : [body.exchangeId || body.uitwisselingId].filter(Boolean).map(String);

      if (!exchangeIds.length) {
        return res.status(400).json({
          success: false,
          message: 'Geen uitwisseling geselecteerd.'
        });
      }

      const current = await getCurrentOpenExchanges({ from, until, days, store });
      const incoming = filterIncomingForStore(current.exchanges || [], store);

      const selected = incoming.filter((exchange) => {
        return exchangeIds.includes(String(exchange.uitwisselingId));
      });

      if (!selected.length) {
        return res.status(400).json({
          success: false,
          message: store && store !== 'GENTS Administratie'
            ? 'Geen open inkomende uitwisseling gevonden voor deze winkel.'
            : 'Geen open uitwisseling gevonden voor deze selectie.'
        });
      }

      const result = await processOpenstaandeUitwisselingen({ exchanges: selected });

      return res.status(200).json({
        success: result.success,
        message: result.success
          ? `${selected.length} uitwisseling(en) binnengeboekt in SRS.`
          : 'Uitwisseling verzonden, maar SRS status is niet completed.',
        processedCount: selected.length,
        processedIds: selected.map((exchange) => exchange.uitwisselingId),
        srs: {
          status: result.status,
          transactionId: result.transactionId
        }
      });
    }

    return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
  } catch (error) {
    console.error('SRS exchanges error:', error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Uitwisselingen konden niet worden verwerkt.',
      details: error.fault || null
    });
  }
}
