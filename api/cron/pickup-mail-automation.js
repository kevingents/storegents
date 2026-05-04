import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { listBranches, getStoreEmail, isWarehouseStore } from '../../lib/branch-metrics.js';
import { sendGentsMail } from '../../lib/resend-mailer.js';
import { updateAutomationState } from '../../lib/automation-state-store.js';
import { businessAgeDays } from '../../lib/business-time.js';

function authorized(req) {
  const secret = String(process.env.PICKUP_MAIL_SECRET || '').trim();
  const given = String(req.query.secret || req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  return Boolean(secret && given && secret === given);
}

function apiBase(req) {
  const configured = process.env.PUBLIC_API_BASE_URL || process.env.VERCEL_URL || '';
  if (configured) return configured.startsWith('http') ? configured.replace(/\/$/, '') : `https://${configured.replace(/\/$/, '')}`;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${req.headers.host}`;
}

function orderId(order) {
  return String(order.id || order.orderId || order.name || order.orderName || '').trim();
}

function isReady(order) {
  const status = String(order.pickupStatus || order.pickupStatusLabel || '').toLowerCase();
  return status.includes('klaar') || status.includes('ready') || status.includes('notified');
}

function orderHtml(order) {
  const items = (order.items || []).map((item) => `<li>${item.quantity || 1}x ${item.name || item.title || item.sku || '-'}</li>`).join('');
  return `<strong>${order.name || order.orderName || orderId(order)}</strong><br>Klant: ${order.customer || '-'}<br>E-mail: ${order.email || '-'}<ul>${items}</ul>`;
}

async function loadPickupOrders(baseUrl, store) {
  const url = `${baseUrl}/api/pickup-orders?store=${encodeURIComponent(store)}&status=open&days=14&refresh=1&t=${Date.now()}`;
  const response = await fetch(url, { headers: { 'x-admin-token': process.env.ADMIN_TOKEN || '12345' } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) throw new Error(data.message || data.error || `Pickup endpoint fout voor ${store}`);
  return data.orders || [];
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!authorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const startedAt = new Date().toISOString();
  const baseUrl = apiBase(req);
  const rows = [];
  let sent = 0;
  let errors = 0;

  try {
    await updateAutomationState((state) => ({ ...state, pickup: { ...(state.pickup || {}), lastRunAt: startedAt, lastStatus: 'running' } }));
    const stateWrapper = { state: null };
    await updateAutomationState((state) => { stateWrapper.state = state || {}; return state; });
    const state = stateWrapper.state || {};
    const pickupState = state.pickupOrders || {};

    for (const branch of listBranches()) {
      const store = branch.store;
      if (isWarehouseStore(store)) continue;
      const to = getStoreEmail(store);
      if (!to) {
        rows.push({ store, status: 'skipped', message: 'Geen winkelmail ingesteld.' });
        continue;
      }
      try {
        const orders = await loadPickupOrders(baseUrl, store);
        for (const order of orders) {
          const id = orderId(order);
          if (!id) continue;
          const createdAt = order.createdAt || order.created_at || new Date().toISOString();
          const age = businessAgeDays(createdAt);
          const sentState = pickupState[id] || {};

          if (!sentState.newOrderSentAt) {
            await sendGentsMail({
              to,
              store,
              type: 'pickup_new_order',
              subject: `Nieuwe ophaalorder voor ${store}: ${order.name || id}`,
              html: `<p>Er staat een nieuwe ophaalorder klaar om te verwerken.</p>${orderHtml(order)}`,
              text: `Nieuwe ophaalorder voor ${store}: ${order.name || id}`,
              meta: { orderId: id, order }
            });
            sent += 1;
            pickupState[id] = { ...sentState, newOrderSentAt: new Date().toISOString() };
          }

          if (age >= 1 && !isReady(order) && !sentState.reminderSentAt) {
            await sendGentsMail({
              to,
              store,
              type: 'pickup_reminder',
              subject: `Reminder: ophaalorder nog niet klaargezet (${order.name || id})`,
              html: `<p>Deze ophaalorder staat langer dan 1 dag open en is nog niet klaargezet.</p>${orderHtml(order)}`,
              text: `Reminder: ophaalorder nog niet klaargezet ${order.name || id}`,
              meta: { orderId: id, ageDays: age, order }
            });
            sent += 1;
            pickupState[id] = { ...(pickupState[id] || sentState), reminderSentAt: new Date().toISOString() };
          }
        }
        rows.push({ store, status: 'ok', orders: orders.length });
      } catch (error) {
        errors += 1;
        rows.push({ store, status: 'error', message: error.message });
      }
    }

    await updateAutomationState((state) => ({
      ...state,
      pickupOrders: pickupState,
      pickup: { lastRunAt: new Date().toISOString(), lastStatus: errors ? 'warning' : 'ok', sent, errors }
    }));

    return res.status(200).json({ success: true, sent, errors, rows });
  } catch (error) {
    await updateAutomationState((state) => ({ ...state, pickup: { ...(state.pickup || {}), lastRunAt: new Date().toISOString(), lastStatus: 'error', error: error.message } }));
    return res.status(500).json({ success: false, message: error.message || 'Pickup mail automation mislukt.' });
  }
}
