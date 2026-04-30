import { getOrderCancellationById, updateOrderCancellation } from '../../../lib/order-cancellation-store.js';
import { cancelWeborderInSrs } from '../../../lib/srs-order-cancellation-client.js';
import { refundShopifyCancellation } from '../../../lib/shopify-refund-client.js';
import { sendCancellationMail } from '../../../lib/customer-cancellation-mail-client.js';
import { corsJson, requireAdmin, requirePost } from '../../../lib/request-guards.js';

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_error) { return {}; }
  }
  return req.body;
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['POST', 'OPTIONS'])) return;
  if (!requirePost(req, res)) return;
  if (!requireAdmin(req, res)) return;

  const body = parseBody(req);
  const id = String(body.id || '').trim();
  const processedBy = String(body.processedBy || 'admin').trim();

  if (!id) return res.status(400).json({ success: false, message: 'Annulering id ontbreekt.' });

  let cancellation = await getOrderCancellationById(id);
  if (!cancellation) return res.status(404).json({ success: false, message: 'Annulering niet gevonden.' });

  if (['processing', 'completed'].includes(cancellation.status)) {
    return res.status(409).json({ success: false, message: `Annulering is al ${cancellation.status}.`, cancellation });
  }

  cancellation = await updateOrderCancellation(id, {
    status: 'processing',
    processedBy,
    processAttempts: Number(cancellation.processAttempts || 0) + 1,
    error: ''
  });

  try {
    const srsResult = await cancelWeborderInSrs({ cancellation });
    cancellation = await updateOrderCancellation(id, {
      srsStatus: srsResult.dryRun ? 'dry_run' : 'completed',
      srsResult
    });

    const refundResult = await refundShopifyCancellation({ cancellation });
    cancellation = await updateOrderCancellation(id, {
      refundStatus: refundResult.dryRun ? 'dry_run' : 'completed',
      refundResult
    });

    const mailResult = await sendCancellationMail({ cancellation });
    cancellation = await updateOrderCancellation(id, {
      mailStatus: mailResult.dryRun ? 'dry_run' : (mailResult.skipped ? 'skipped' : 'completed'),
      mailResult,
      status: 'completed',
      processedAt: new Date().toISOString()
    });

    return res.status(200).json({ success: true, cancellation, message: 'Annulering is verwerkt.' });
  } catch (error) {
    console.error('Order cancellation process error:', error);
    cancellation = await updateOrderCancellation(id, {
      status: 'failed',
      error: error.message || 'Verwerking mislukt.'
    });
    return res.status(500).json({ success: false, message: error.message || 'Annulering kon niet worden verwerkt.', cancellation });
  }
}
