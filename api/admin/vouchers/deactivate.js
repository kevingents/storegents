/**
 * POST /api/admin/vouchers/deactivate
 *   Body: { id }   — voucher-log-id (uit /api/admin/vouchers/report row.id)
 *
 * Deactiveert ÉÉN voucher in Shopify (gift card) en werkt de voucher-log-status
 * bij. Spiegelt de per-voucher-logica van sync-srs-closed.js, maar dan voor een
 * enkele voucher die de admin handmatig kiest — met name bedoeld om een eerder
 * MISLUKTE Shopify-deactivatie (status shopify_giftcard_deactiveren_mislukt)
 * opnieuw te proberen, of een open voucher handmatig te deactiveren.
 *
 * Auth: ADMIN_TOKEN (x-admin-token) — de BFF injecteert dit voor master-admin /
 * page.vouchers-rechthebbenden.
 */

import { getVoucherLogs, updateVoucherLogById } from '../../../lib/voucher-log-store.js';
import { deactivateShopifyGiftCard } from '../../../lib/shopify-gift-card-client.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

/* Statussen die als 'klaar' gelden — niet opnieuw deactiveren tenzij force. */
const FINAL_STATUSES = [
  'afgeboekt_in_srs',
  'gebruikt_in_winkel_shopify_gedeactiveerd',
  'gebruikt_in_winkel_geen_shopify',
  'shopify_giftcard_gedeactiveerd'
];

function isAuthorized(req) {
  const adminToken = String(
    process.env.ADMIN_TOKEN || (globalThis.crypto?.randomUUID?.() || String(Math.random()))
  ).trim();
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return Boolean(adminToken && token && token === adminToken);
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen POST is toegestaan.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const id = String(body.id || '').trim();
    const force = body.force === true;
    if (!id) return res.status(400).json({ success: false, message: 'Voucher-id is verplicht.' });

    /* SRS-only rijen (report-id 'srs-<barcode>') hebben geen voucher-log → niet deactiveerbaar. */
    if (id.startsWith('srs-')) {
      return res.status(400).json({ success: false, message: 'Deze voucher is niet via het portaal aangemaakt en heeft geen gekoppelde gift card.' });
    }

    const logs = await getVoucherLogs();
    const log = logs.find((l) => String(l.id) === id);
    if (!log) return res.status(404).json({ success: false, message: 'Voucher niet gevonden.' });

    if (FINAL_STATUSES.includes(log.status) && !force) {
      return res.status(400).json({ success: false, message: `Voucher is al afgehandeld (status: ${log.status}).` });
    }

    /* Geen Shopify gift card gekoppeld → markeer als gebruikt-in-winkel-zonder-shopify. */
    if (!log.shopifyGiftCardId) {
      const updated = await updateVoucherLogById(log.id, {
        status: 'gebruikt_in_winkel_geen_shopify',
        error: ''
      });
      return res.status(200).json({
        success: true,
        deactivated: false,
        message: 'Geen Shopify gift card gekoppeld; gemarkeerd als gebruikt in winkel.',
        voucher: updated
      });
    }

    try {
      const giftCard = await deactivateShopifyGiftCard(log.shopifyGiftCardId);
      const updated = await updateVoucherLogById(log.id, {
        status: 'gebruikt_in_winkel_shopify_gedeactiveerd',
        shopifyGiftCardDeactivatedAt: giftCard?.deactivatedAt || new Date().toISOString(),
        error: ''
      });
      return res.status(200).json({
        success: true,
        deactivated: true,
        message: 'Voucher gedeactiveerd in Shopify.',
        voucher: updated
      });
    } catch (error) {
      const updated = await updateVoucherLogById(log.id, {
        status: 'shopify_giftcard_deactiveren_mislukt',
        error: error.message || 'Shopify gift card deactiveren mislukt.'
      });
      /* HTTP 200 met success:false zodat de frontend de backend-boodschap toont. */
      return res.status(200).json({
        success: false,
        deactivated: false,
        message: error.message || 'Shopify gift card deactiveren mislukt.',
        voucher: updated
      });
    }
  } catch (error) {
    console.error('[vouchers/deactivate]', error);
    return res.status(500).json({ success: false, message: error.message || 'Onverwachte fout.' });
  }
}
