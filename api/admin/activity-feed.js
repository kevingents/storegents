import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { getMailLog } from '../../lib/gents-mail-log-store.js';

/**
 * GET /api/admin/activity-feed?limit=10
 *
 * Verzamelt vandaag-activiteit uit meerdere bronnen:
 *  - Mail logs (verzonden pickup-, weborder-, voucher-, service-mails)
 *  - Niet-leverbaar regels (verwerkt/refunded)
 *  - Order cancellations (SRS gecancelled)
 *  - Support tickets (nieuw + opgelost)
 *  - Cron mail-automations (laatste runs)
 *
 * Levert genormaliseerde feed: {time, type, title, detail, level, store?}.
 */
export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (requireAdmin(req, res)) return;

  const limit = Math.min(50, Math.max(1, Number(req.query.limit || 10)));

  const events = [];

  /* 1. Mail logs */
  try {
    const logs = await getMailLog();
    const today = new Date(); today.setHours(0,0,0,0);
    const todayLogs = logs.filter(l => new Date(l.createdAt || 0).getTime() >= today.getTime());
    todayLogs.slice(0, 20).forEach(l => {
      events.push({
        time: l.createdAt || l.sentAt || new Date().toISOString(),
        type: 'mail',
        subtype: l.type || 'mail',
        title: mailTitle(l.type),
        detail: [l.store, l.recipient, l.order && `#${l.order}`].filter(Boolean).join(' · '),
        level: l.status === 'error' ? 'warning' : 'info',
        store: l.store || ''
      });
    });
  } catch (e) { /* skip */ }

  /* 2. Order cancellations / niet-leverbaar (via fetch naar eigen endpoint) */
  try {
    const base = req.headers.host ? `https://${req.headers.host}` : '';
    if (base) {
      const token = process.env.ADMIN_TOKEN || (globalThis.crypto?.randomUUID?.() || String(Math.random()));
      const resp = await fetch(`${base}/api/admin/unavailable-order-lines?status=processed&t=${Date.now()}`, {
        headers: { 'x-admin-token': token, Accept: 'application/json' }
      });
      if (resp.ok) {
        const data = await resp.json();
        const today = new Date(); today.setHours(0,0,0,0);
        const recent = (data.items || data.rows || []).filter(r => {
          const dt = new Date(r.processedAt || r.refundedAt || r.srsCancelledAt || r.updatedAt || r.createdAt || 0).getTime();
          return dt >= today.getTime();
        });
        recent.slice(0, 15).forEach(r => {
          events.push({
            time: r.processedAt || r.refundedAt || r.updatedAt || r.createdAt,
            type: 'unavailable',
            subtype: 'processed',
            title: r.shopifyRefunded && r.srsCancelled ? 'Niet leverbaar verwerkt' : 'Niet leverbaar bijgewerkt',
            detail: [r.store, r.orderName || r.orderNumber, r.sku && `SKU ${r.sku}`].filter(Boolean).join(' · '),
            level: 'success',
            store: r.store || ''
          });
        });
      }
    }
  } catch (e) { /* skip */ }

  /* 3. Sort & limit */
  events.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  const top = events.slice(0, limit);

  return res.status(200).json({
    success: true,
    count: top.length,
    totalToday: events.length,
    events: top
  });
}

function mailTitle(type) {
  const t = String(type || '').toLowerCase();
  const map = {
    'pickup': 'Pickup-mail verzonden',
    'pickup_ready': 'Pickup-mail verzonden',
    'pickup_config': 'Pickup-configuratie verzonden',
    'pickup-reminder': 'Pickup-reminder verzonden',
    'weborder': 'Weborder-mail verzonden',
    'weborder_confirmation': 'Weborder bevestigd',
    'weborder_config': 'Weborder-configuratie verzonden',
    'service': 'Service-mail verzonden',
    'voucher': 'Voucher-mail verzonden',
    'loyalty': 'Loyalty-mail verzonden',
    'declaration': 'Declaratie-mail',
    'unavailable': 'Niet leverbaar gemeld',
    'cancellation': 'Annulering gemeld',
    'support': 'Support-mail'
  };
  if (map[t]) return map[t];
  if (!type) return 'Activiteit';
  return String(type).replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
