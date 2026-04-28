import {
  setCors,
  handleError,
  getOrderById,
  shopifyRest,
  addOrderTags
} from './_shopify.js';

function normalizeSelectedItems(items) {
  if (!Array.isArray(items)) return [];

  return items
    .map((item) => ({
      lineItemId: String(item.lineItemId || item.id || '').trim(),
      quantity: Number(item.quantity || 0)
    }))
    .filter((item) => item.lineItemId && item.quantity > 0);
}

export default async function handler(req, res) {
  setCors(res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Methode niet toegestaan' });
  }

  const orderId = String(req.body?.orderId || req.body?.id || '').trim();
  const employeeName = String(req.body?.employeeName || req.body?.medewerker || '').trim();
  const reason = String(req.body?.reason || req.body?.reden || '').trim();
  const note = String(req.body?.note || '').trim();
  const store = String(req.body?.store || '').trim();
  const confirm =
    req.body?.confirm === true ||
    req.body?.confirmed === true ||
    req.body?.confirmation === true;

  const selectedItems = normalizeSelectedItems(
    req.body?.items || req.body?.selectedItems || req.body?.refundItems
  );

  if (!confirm) {
    return res.status(400).json({ error: 'Bevestiging ontbreekt' });
  }

  if (!orderId) {
    return res.status(400).json({ error: 'Order ID ontbreekt' });
  }

  if (!employeeName) {
    return res.status(400).json({ error: 'Naam medewerker ontbreekt' });
  }

  if (!reason) {
    return res.status(400).json({ error: 'Retourreden ontbreekt' });
  }

  if (!selectedItems.length) {
    return res.status(400).json({ error: 'Selecteer minimaal één product' });
  }

  try {
    const order = await getOrderById(orderId);

    const refundLineItems = selectedItems.map((item) => ({
      line_item_id: Number(item.lineItemId),
      quantity: item.quantity,
      restock_type: 'return'
    }));

    const calculatePayload = {
      refund: {
        refund_line_items: refundLineItems
      }
    };

    const calculated = await shopifyRest(`/orders/${orderId}/refunds/calculate.json`, {
      method: 'POST',
      body: JSON.stringify(calculatePayload)
    });

    const calculatedRefund = calculated.refund || {};
    const transactions = (calculatedRefund.transactions || []).map((transaction) => ({
      parent_id: transaction.parent_id,
      amount: transaction.amount,
      kind: 'refund',
      gateway: transaction.gateway
    }));

    const refundPayload = {
      refund: {
        notify: true,
        note: `Retour verwerkt via winkelportaal door ${employeeName}. Winkel: ${store || '-'}. Reden: ${reason}${note ? `. Opmerking: ${note}` : ''}`,
        refund_line_items: refundLineItems,
        transactions
      }
    };

    if (calculatedRefund.shipping) {
      refundPayload.refund.shipping = calculatedRefund.shipping;
    }

    const created = await shopifyRest(`/orders/${orderId}/refunds.json`, {
      method: 'POST',
      body: JSON.stringify(refundPayload)
    });

    await addOrderTags(order, ['winkelportaal_retour']);

    return res.status(200).json({
      success: true,
      message: 'Terugbetaling verwerkt via Shopify',
      refund: created.refund
    });
  } catch (error) {
    return handleError(res, error, 'Terugbetaling kon niet worden verwerkt');
  }
}
