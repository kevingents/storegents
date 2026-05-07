import { getPurchaseOrders } from '../../lib/srs-purchase-orders-client.js';
import { getStock, summarizeStockByBarcode } from '../../lib/srs-stock-client.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

function clean(value) {
  return String(value || '').trim();
}

function toNumber(value) {
  const n = Number(String(value || '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function unique(values) {
  return Array.from(new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean)));
}

function itemKeys(product = {}) {
  return unique([
    product.sku,
    product.barcode,
    ...(product.barcodes || []).map((barcode) => barcode.id)
  ]);
}

function riskLevel({ received, available }) {
  if (received > 0 && available <= 0) return 'high';
  if (received > 0 && available < received) return 'medium';
  return 'ok';
}

function riskLabel(level) {
  if (level === 'high') return 'Hoog: ontvangen maar voorraad staat op 0';
  if (level === 'medium') return 'Let op: voorraad lager dan ontvangen aantal';
  return 'OK';
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (!requireAdmin(req, res)) return;

  try {
    const from = clean(req.query.from || req.query.dateFrom);
    const until = clean(req.query.until || req.query.to || req.query.dateTo);
    const days = Number(req.query.days || 30);
    const status = clean(req.query.status || 'all').toLowerCase();
    const branchId = clean(req.query.branchId || req.query.branch_id);
    const onlyReceived = clean(req.query.onlyReceived || 'true') !== 'false';

    const poResult = await getPurchaseOrders({ from, until, days, branchId, status });
    const purchaseOrders = poResult.orders || [];
    const receivedLines = [];

    for (const order of purchaseOrders) {
      for (const product of order.products || []) {
        const piecesReceived = toNumber(product.piecesReceived);
        if (onlyReceived && piecesReceived <= 0) continue;

        receivedLines.push({
          orderNr: order.orderNr,
          orderReference: order.orderReference,
          supplier: order.supplier?.name || '',
          branchId: order.branchId,
          branchName: order.branchName,
          orderDate: order.orderDate,
          productNr: product.productNr,
          sku: product.sku,
          barcode: product.barcode,
          barcodes: product.barcodes || [],
          purchasePrice: product.purchasePrice,
          piecesOrdered: toNumber(product.piecesOrdered),
          piecesReceived,
          piecesOpen: toNumber(product.piecesOpen),
          keys: itemKeys(product)
        });
      }
    }

    const branches = unique(receivedLines.map((line) => line.branchId));
    const barcodes = unique(receivedLines.flatMap((line) => line.keys));

    let stockResult = { stockRows: [] };
    let stockByBarcode = {};
    let stockError = null;

    if (branches.length && barcodes.length) {
      try {
        stockResult = await getStock({ branchIds: branches, barcodes });
        stockByBarcode = summarizeStockByBarcode(stockResult.stockRows || []);
      } catch (error) {
        stockError = {
          message: error.message || 'Voorraadcheck mislukt.',
          details: error.fault || null
        };
      }
    }

    const rows = receivedLines.map((line) => {
      const stockMatch = line.keys.map((key) => stockByBarcode[key]).find(Boolean) || { totalAvailable: 0, branches: [] };
      const branchStock = (stockMatch.branches || []).filter((row) => String(row.branchId) === String(line.branchId));
      const available = branchStock.reduce((sum, row) => String(row.type || '').toLowerCase() === 'available' ? sum + toNumber(row.pieces) : sum, 0);
      const level = stockError ? 'unknown' : riskLevel({ received: line.piecesReceived, available });

      return {
        ...line,
        available,
        stockRows: branchStock,
        riskLevel: level,
        riskLabel: level === 'unknown' ? 'Voorraadcheck kon niet worden uitgevoerd' : riskLabel(level),
        balanceWarning: level === 'high' || level === 'medium'
      };
    });

    const riskyRows = rows.filter((row) => row.balanceWarning);

    return res.status(200).json({
      success: !stockError,
      mode: 'magazijn_purchase_order_stock_check',
      from: poResult.from,
      until: poResult.until,
      purchaseOrderCount: purchaseOrders.length,
      checkedLines: rows.length,
      riskyCount: riskyRows.length,
      highRiskCount: rows.filter((row) => row.riskLevel === 'high').length,
      mediumRiskCount: rows.filter((row) => row.riskLevel === 'medium').length,
      okCount: rows.filter((row) => row.riskLevel === 'ok').length,
      piecesReceived: rows.reduce((sum, row) => sum + toNumber(row.piecesReceived), 0),
      availablePieces: rows.reduce((sum, row) => sum + toNumber(row.available), 0),
      stockError,
      rows,
      riskyRows,
      note: 'Controleert ontvangen PurchaseOrder-regels tegen actuele SRS Stock per filiaal/barcode. Regels met voorraad 0 of lager dan ontvangen aantal worden gemarkeerd voor balanscontrole.'
    });
  } catch (error) {
    console.error('Purchase order stock check error:', error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'PurchaseOrder voorraadcontrole kon niet worden uitgevoerd.',
      details: error.fault || null
    });
  }
}
