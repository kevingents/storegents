import { createSrsReturn } from '../../lib/srs-client.js';
import { getSrsBranchId } from '../../lib/srs-branches.js';
import { createSrsReturnLog } from '../../lib/srs-return-log-store.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

function getOrderNr(body) {
  return String(
    body.srsOrderNr ||
    body.orderNr ||
    body.orderName ||
    body.orderNumber ||
    ''
  ).replace(/^#/, '').trim();
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);

  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      message: 'Alleen POST is toegestaan.'
    });
  }

  const body = req.body || {};
  const store = String(body.store || '').trim();
  const employeeName = String(body.employeeName || body.medewerker || '').trim();
  const orderNr = getOrderNr(body);
  const shopifyOrderId = String(body.shopifyOrderId || body.orderId || body.id || '').trim();
  const items = Array.isArray(body.items) ? body.items : [];

  try {
    if (!store) {
      return res.status(400).json({
        success: false,
        message: 'Winkel ontbreekt voor SRS retour.'
      });
    }

    if (!orderNr) {
      return res.status(400).json({
        success: false,
        message: 'SRS OrderNr ontbreekt. Geef srsOrderNr/orderNr/orderName mee.'
      });
    }

    if (!items.length) {
      return res.status(400).json({
        success: false,
        message: 'Geen retourproducten ontvangen voor SRS.'
      });
    }

    const branchId = body.branchId || getSrsBranchId(store);

    const srsResult = await createSrsReturn({
      orderNr,
      branchId,
      items,
      dateTime: body.dateTime || ''
    });

    const log = await createSrsReturnLog({
      store,
      employeeName,
      orderNr,
      shopifyOrderId,
      branchId,
      status: srsResult.status,
      success: srsResult.success,
      srsTransactionId: srsResult.transactionId,
      items,
      message: srsResult.success ? 'Retour verwerkt in SRS.' : 'SRS retour gaf geen completed status.'
    });

    return res.status(200).json({
      success: srsResult.success,
      message: srsResult.success ? 'Retour verwerkt in SRS.' : 'SRS retour is verzonden, maar status is niet completed.',
      srs: {
        transactionId: srsResult.transactionId,
        status: srsResult.status,
        orderNr,
        branchId
      },
      log
    });
  } catch (error) {
    console.error('SRS return error:', error);

    const branchId = body.branchId || '';

    await createSrsReturnLog({
      store,
      employeeName,
      orderNr,
      shopifyOrderId,
      branchId,
      status: 'failed',
      success: false,
      items,
      error: error.message || 'SRS retour mislukt.'
    });

    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'SRS retour kon niet worden verwerkt.',
      details: error.fault || null
    });
  }
}
