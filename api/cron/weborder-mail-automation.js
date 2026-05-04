import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { listBranches, getStoreEmail, getRegionManagerEmail, isWarehouseStore } from '../../lib/branch-metrics.js';
import { sendGentsMail } from '../../lib/resend-mailer.js';
import { updateAutomationState } from '../../lib/automation-state-store.js';
import { businessAgeDays } from '../../lib/business-time.js';

function authorized(req) {
  const secret = String(process.env.WEBORDER_MAIL_SECRET || '').trim();
  const given = String(req.query.secret || req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  return Boolean(secret && given && secret === given);
}

function apiBase(req) {
  const configured = process.env.PUBLIC_API_BASE_URL || process.env.VERCEL_URL || '';
  if (configured) return configured.startsWith('http') ? configured.replace(/\/$/, '') : `https://${configured.replace(/\/$/, '')}`;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${req.headers.host}`;
}

function rowId(row) {
  return String(row.fulfillmentId || row.id || `${row.orderNr || row.orderNumber || row.orderId || ''}-${row.sku || row.barcode || ''}`).trim();
}

function createdAt(row) {
  return row.createdAt || row.created_at || row.dateTime || row.created || row.updatedAt || new Date().toISOString();
}

function orderNr(row) {
  return row.orderNr || row.orderNumber || row.orderName || row.orderId || row.id || '-';
}

function sku(row) {
  return row.sku || row.barcode || row.articleNumber || row.productSku || '-';
}

function ordersTable(rows) {
  return `<table border="1" cellspacing="0" cellpadding="6"><thead><tr><th>Order</th><th>SKU</th><th>Klant</th><th>E-mail</th><th>Leeftijd</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${orderNr(row)}</td><td>${sku(row)}</td><td>${row.customerName || row.customer || '-'}</td><td>${row.customerEmail || row.email || '-'}</td><td>${Math.floor(businessAgeDays(createdAt(row)))} dagen</td></tr>`).join('')}</tbody></table>`;
}

async function loadOpenWeborders(baseUrl, store) {
  const url = `${baseUrl}/api/srs/open-weborders?store=${encodeURIComponent(store)}&refresh=1&t=${Date.now()}`;
  const response = await fetch(url, { headers: { 'x-admin-token': process.env.ADMIN_TOKEN || '12345' } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) throw new Error(data.message || data.error || `Open weborders endpoint fout voor ${store}`);
  return data.requests || data.summary?.fulfilmentOpen || [];
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!authorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const baseUrl = apiBase(req);
  let sent = 0;
  let errors = 0;
  const rows = [];

  try {
    await updateAutomationState((state) => ({ ...state, weborder: { ...(state.weborder || {}), lastRunAt: new Date().toISOString(), lastStatus: 'running' } }));
    const stateHolder = { state: null };
    await updateAutomationState((state) => { stateHolder.state = state || {}; return state; });
    const weborderMailState = stateHolder.state?.weborderRows || {};

    for (const branch of listBranches()) {
      const store = branch.store;
      if (isWarehouseStore(store)) continue;
      const to = getStoreEmail(store);
      try {
        const openRows = await loadOpenWeborders(baseUrl, store);
        const overdue48 = openRows.filter((row) => businessAgeDays(createdAt(row)) >= 2);
        const overdue4Days = openRows.filter((row) => businessAgeDays(createdAt(row)) >= 4);

        if (overdue48.length && to) {
          const key = `${store}-${new Date().toISOString().slice(0, 10)}-store`;
          if (!weborderMailState[key]) {
            await sendGentsMail({
              to,
              store,
              type: 'weborder_store_overdue',
              subject: `${overdue48.length} te late weborder(s) voor ${store}`,
              html: `<p>Deze weborders staan te lang open. Weekend telt als 1 dag.</p>${ordersTable(overdue48)}`,
              text: `${overdue48.length} te late weborders voor ${store}`,
              meta: { count: overdue48.length, orders: overdue48.map(rowId) }
            });
            weborderMailState[key] = new Date().toISOString();
            sent += 1;
          }
        }

        if (overdue4Days.length) {
          const manager = getRegionManagerEmail(store);
          const key = `${store}-${new Date().toISOString().slice(0, 10)}-region`;
          if (manager && !weborderMailState[key]) {
            await sendGentsMail({
              to: manager,
              store,
              type: 'weborder_region_escalation',
              subject: `Escalatie: ${overdue4Days.length} weborder(s) langer dan 4 dagen open - ${store}`,
              html: `<p>Deze weborders staan langer dan 4 dagen open. Magazijn/webshop is uitgesloten.</p>${ordersTable(overdue4Days)}`,
              text: `Escalatie weborders ${store}: ${overdue4Days.length} langer dan 4 dagen open.`,
              meta: { count: overdue4Days.length, orders: overdue4Days.map(rowId) }
            });
            weborderMailState[key] = new Date().toISOString();
            sent += 1;
          }
        }

        rows.push({ store, status: 'ok', open: openRows.length, overdue48: overdue48.length, overdue4Days: overdue4Days.length });
      } catch (error) {
        errors += 1;
        rows.push({ store, status: 'error', message: error.message });
      }
    }

    await updateAutomationState((state) => ({
      ...state,
      weborderRows: weborderMailState,
      weborder: { lastRunAt: new Date().toISOString(), lastStatus: errors ? 'warning' : 'ok', sent, errors }
    }));

    return res.status(200).json({ success: true, sent, errors, rows });
  } catch (error) {
    await updateAutomationState((state) => ({ ...state, weborder: { ...(state.weborder || {}), lastRunAt: new Date().toISOString(), lastStatus: 'error', error: error.message } }));
    return res.status(500).json({ success: false, message: error.message || 'Weborder mail automation mislukt.' });
  }
}
