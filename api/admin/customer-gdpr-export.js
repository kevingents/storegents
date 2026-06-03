import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { getSrsReturnLogs } from '../../lib/srs-return-log-store.js';
import { getCustomerNotesForKey } from '../../lib/customer-notes-store.js';

/**
 * GET /api/admin/customer-gdpr-export?customerKey=email&orderNrs=...
 *
 * GDPR Article 15 — Right of access.
 * Verzamelt alle data over een klant in 1 JSON download.
 *
 * Bronnen:
 *  - SRS profile (frontend stuurt customer object door via base64-query)
 *  - Retour-logs
 *  - Mail-logs
 *  - Notities/tags
 *  - Newsletter status
 */

function isAuthorized(req) {
  const adminToken = String(process.env.ADMIN_TOKEN || '').trim();
  if (!adminToken) return false;
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

async function safeMailLogs(customerEmail, orderNrsSet) {
  try {
    const mod = await import('../../lib/gents-mail-log-store.js');
    const logs = await mod.getMailLogs();
    const list = Array.isArray(logs) ? logs : (logs?.items || []);
    return list.filter((m) => {
      const to = String(m.to || m.email || '').toLowerCase();
      const order = String(m.orderNr || '').replace(/^#/, '');
      return (customerEmail && to.includes(customerEmail)) || (order && orderNrsSet.has(order));
    });
  } catch { return []; }
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const customerKey = clean(req.query.customerKey || req.query.email);
  const customerEmail = clean(req.query.email).toLowerCase();
  const customerId = clean(req.query.customerId);
  const orderNrs = new Set(
    clean(req.query.orderNrs).split(',').map((s) => s.trim().replace(/^#/, '')).filter(Boolean)
  );

  try {
    /* Notities + tags */
    const notesData = customerKey ? await getCustomerNotesForKey(customerKey) : null;

    /* Retour-logs */
    const allReturns = await getSrsReturnLogs().catch(() => []);
    const returns = (Array.isArray(allReturns) ? allReturns : [])
      .filter((log) => {
        const order = clean(log.orderNr).replace(/^#/, '');
        return orderNrs.has(order);
      });

    /* Mail-logs */
    const mails = await safeMailLogs(customerEmail, orderNrs);

    const exportData = {
      generatedAt: new Date().toISOString(),
      legalBasis: 'GDPR Article 15 — Right of access',
      customerKey,
      customerEmail,
      customerId,
      orderCount: orderNrs.size,
      ordersIncluded: [...orderNrs],
      notes: notesData?.notes || [],
      tags: notesData?.tags || [],
      newsletter: notesData?.newsletter || null,
      retourHistory: returns,
      mailHistory: mails,
      note: 'Voor SRS-specifieke aankoop-historie + transacties: zie aparte SRS export via /api/srs/customers/profile?customerId=...'
    };

    const filename = `gdpr-export-${customerKey.replace(/[^a-zA-Z0-9_-]/g, '_')}-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(JSON.stringify(exportData, null, 2));
  } catch (error) {
    console.error('[admin/customer-gdpr-export]', error);
    return res.status(500).json({ success: false, message: error.message || 'Export mislukt.' });
  }
}
