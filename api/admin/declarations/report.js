import { getDeclarations } from '../../../lib/declarations-store.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

function isAuthorized(req) {
  const adminToken = String(process.env.ADMIN_TOKEN || '12345').trim();
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query?.adminToken ||
    req.query?.admin_token ||
    req.query?.token ||
    req.body?.adminToken ||
    req.body?.admin_token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return Boolean(adminToken && token && token === adminToken);
}

function isInRange(declaration, fromMs, toMs) {
  if (!fromMs && !toMs) return true;
  const ts = new Date(declaration.createdAt || declaration.date || 0).getTime();
  if (Number.isNaN(ts)) return false;
  if (fromMs && ts < fromMs) return false;
  if (toMs && ts > toMs) return false;
  return true;
}

function matchesStatus(declaration, status) {
  if (!status) return true;
  const st = String(declaration.status || (declaration.paidAt ? 'paid' : 'pending')).toLowerCase();
  return st === status.toLowerCase();
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  }

  try {
    const all = await getDeclarations();

    const from = String(req.query.from || req.query.dateFrom || '').trim();
    const to = String(req.query.to || req.query.dateTo || '').trim();
    const status = String(req.query.status || '').trim();
    const store = String(req.query.store || '').trim();

    const fromMs = from ? new Date(from + 'T00:00:00').getTime() : 0;
    const toMs = to ? new Date(to + 'T23:59:59').getTime() : 0;

    let rows = (all || []).filter((d) => {
      if (store && String(d.store || '').toLowerCase() !== store.toLowerCase()) return false;
      if (!isInRange(d, fromMs, toMs)) return false;
      if (!matchesStatus(d, status)) return false;
      return true;
    });

    /* Sort: nieuwste eerst */
    rows = rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

    const totalOpen = rows.filter((d) => !d.paidAt && d.status !== 'paid').reduce((s, d) => s + Number(d.amount || 0), 0);
    const totalPaid = rows.filter((d) => d.paidAt || d.status === 'paid').reduce((s, d) => s + Number(d.amount || 0), 0);
    const totalRejected = rows.filter((d) => d.status === 'rejected').length;

    return res.status(200).json({
      success: true,
      filters: { from, to, status, store },
      totals: {
        count: rows.length,
        totalOpen: Number(totalOpen.toFixed(2)),
        totalPaid: Number(totalPaid.toFixed(2)),
        totalRejected
      },
      declarations: rows,
      rows
    });
  } catch (error) {
    console.error('Declarations report error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Declaratierapport kon niet worden opgehaald.'
    });
  }
}
