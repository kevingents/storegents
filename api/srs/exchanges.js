import { getAllOpenstaandeUitwisselingen, processOpenstaandeUitwisselingen } from '../../lib/srs-exchanges-client.js';
import { getSrsBranchId } from '../../lib/srs-branches.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

function normalizeStore(value) {
  return String(value || '').trim();
}

function filterForStore(exchanges, store) {
  if (!store) return exchanges;

  const branchId = getSrsBranchId(store);

  return exchanges.filter((exchange) => {
    return String(exchange.vanFiliaal) === String(branchId) || String(exchange.naarFiliaal) === String(branchId);
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
          itemCount: 0
        });
      }

      const row = byBranch.get(branchId);
      if (side === 'van') row.outgoing += 1;
      if (side === 'naar') row.incoming += 1;
      row.itemCount += Number(exchange.itemCount || 0);
    }
  }

  return Array.from(byBranch.values()).sort((a, b) => {
    return (b.incoming + b.outgoing) - (a.incoming + a.outgoing) || String(a.store).localeCompare(String(b.store), 'nl');
  });
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);

  try {
    if (req.method === 'GET') {
      const store = normalizeStore(req.query.store);
      const from = String(req.query.from || '').trim();
      const until = String(req.query.until || '').trim();
      const days = Number(req.query.days || 30);

      const result = await getAllOpenstaandeUitwisselingen({ from, until, days });
      const exchanges = filterForStore(result.exchanges || [], store);

      return res.status(200).json({
        success: true,
        store,
        from: result.from,
        until: result.until,
        count: exchanges.length,
        itemCount: exchanges.reduce((sum, exchange) => sum + Number(exchange.itemCount || 0), 0),
        summary: buildSummary(exchanges),
        exchanges
      });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const exchanges = Array.isArray(body.exchanges) ? body.exchanges : [];
      const result = await processOpenstaandeUitwisselingen({ exchanges });

      return res.status(200).json({
        success: result.success,
        message: result.success ? 'Uitwisseling verwerkt in SRS.' : 'Uitwisseling verzonden, maar SRS status is niet completed.',
        srs: {
          status: result.status,
          transactionId: result.transactionId
        }
      });
    }

    return res.status(405).json({
      success: false,
      message: 'Methode niet toegestaan.'
    });
  } catch (error) {
    console.error('SRS exchanges error:', error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Uitwisselingen konden niet worden opgehaald.',
      details: error.fault || null
    });
  }
}
