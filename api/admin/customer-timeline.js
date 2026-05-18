import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { getSrsReturnLogs } from '../../lib/srs-return-log-store.js';
import { getCustomerNotesForKey } from '../../lib/customer-notes-store.js';

/**
 * GET /api/admin/customer-timeline?customerKey=email-of-id&orderNrs=33096,33210
 *
 * Combineert mail-logs + retour-logs + notities tot een chronologische timeline.
 * Order-events worden door de frontend al getoond via SRS profile transactions.
 *
 * Response: { events: [{ type, title, detail, time, source, level }] }
 */

function isAuthorized(req) {
  const adminToken = String(process.env.ADMIN_TOKEN || '').trim();
  if (!adminToken) return true;
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.admin_token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return token === adminToken;
}

function clean(value) { return String(value || '').trim(); }

async function readMailLogs(customerEmail, customerOrderNrs) {
  /* Lazy import — kan ontbreken in sommige envs */
  try {
    const mod = await import('../../lib/gents-mail-log-store.js');
    const logs = await mod.getMailLogs();
    const list = Array.isArray(logs) ? logs : (logs?.items || []);
    return list.filter((m) => {
      const to = String(m.to || m.email || '').toLowerCase();
      const order = String(m.orderNr || m.orderName || '').replace(/^#/, '');
      const matchesEmail = customerEmail && to.includes(customerEmail);
      const matchesOrder = order && customerOrderNrs.has(order);
      return matchesEmail || matchesOrder;
    });
  } catch (error) {
    console.warn('[customer-timeline] mail-logs niet beschikbaar:', error.message);
    return [];
  }
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const customerKey = clean(req.query.customerKey || req.query.email);
  const customerEmail = clean(req.query.email).toLowerCase();
  const orderNrs = new Set(
    clean(req.query.orderNrs).split(',').map((s) => s.trim().replace(/^#/, '')).filter(Boolean)
  );

  try {
    const events = [];

    /* 1. Retour-logs */
    try {
      const retLogs = await getSrsReturnLogs();
      (Array.isArray(retLogs) ? retLogs : []).forEach((log) => {
        const order = clean(log.orderNr).replace(/^#/, '');
        if (!orderNrs.has(order)) return;
        events.push({
          type: 'retour',
          title: `Retour ${log.success ? 'verwerkt' : 'mislukt'} bij ${log.store || 'onbekend'}`,
          detail: `Order #${order} · ${(log.items || []).length} items · ${log.employeeName || ''}${log.crossSellMade ? ` · Cross-sell €${log.crossSellAmount}` : ''}`,
          time: log.createdAt,
          source: 'srs_return_log',
          level: log.success ? 'success' : 'warning'
        });
      });
    } catch (e) { console.warn('[timeline] retour-logs error:', e.message); }

    /* 2. Mail-logs */
    if (customerEmail || orderNrs.size) {
      const mails = await readMailLogs(customerEmail, orderNrs);
      mails.forEach((m) => {
        events.push({
          type: 'mail',
          title: clean(m.subject || m.type || 'E-mail verzonden'),
          detail: `Naar ${clean(m.to || m.email || '-')}${m.orderNr ? ` · order #${clean(m.orderNr).replace(/^#/, '')}` : ''}${m.template ? ` · template ${m.template}` : ''}`,
          time: m.createdAt || m.sentAt || m.timestamp,
          source: 'mail_log',
          level: m.error ? 'danger' : 'info'
        });
      });
    }

    /* 3. Notities (uit customer-notes store) */
    try {
      if (customerKey) {
        const { notes = [] } = await getCustomerNotesForKey(customerKey);
        notes.forEach((n) => {
          events.push({
            type: 'note',
            title: 'Notitie toegevoegd',
            detail: `${n.text.slice(0, 120)}${n.text.length > 120 ? '…' : ''} — door ${n.author}`,
            time: n.createdAt,
            source: 'customer_note',
            level: 'muted'
          });
        });
      }
    } catch (e) { console.warn('[timeline] notes error:', e.message); }

    /* Sort: newest first */
    events.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));

    return res.status(200).json({
      success: true,
      customerKey,
      customerEmail,
      orderCount: orderNrs.size,
      events: events.slice(0, 100)
    });
  } catch (error) {
    console.error('[admin/customer-timeline]', error);
    return res.status(500).json({ success: false, message: error.message || 'Timeline kon niet worden opgehaald.' });
  }
}
