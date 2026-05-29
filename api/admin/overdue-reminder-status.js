import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { getMailLog } from '../../lib/gents-mail-log-store.js';
import { getStoreNames, getStoreMail, getStoreMailAsync, getApiBaseUrl, getAdminToken, isExcludedStore } from '../../lib/gents-mail-config.js';

/**
 * GET /api/admin/overdue-reminder-status
 *
 * Geeft een totaaloverzicht van de overdue-reminder mail-flow:
 *  - laatste 7 dagen aan verstuurde reminder-mails per winkel
 *  - missende winkel-emails
 *  - optioneel: dry-run preview van de eerstvolgende cron-run
 *    (alleen als ?preview=1, fetcht intern weborder-mail-run met dryRun=1)
 *
 * Response:
 *  {
 *    success, schedule,
 *    storeMissingEmail: [winkel, ...],
 *    summary: { storesWithSent7d, totalStoreMails7d, totalManagerMails7d, lastMailAt },
 *    perStore: [{
 *      store, email, hasEmail,
 *      sent7d: { storeMails, managerMails, lastStoreMailAt, lastManagerMailAt },
 *      recent: [{ type, order, at, status }]   // laatste 10
 *    }],
 *    dryRun?: { ... uit weborder-mail-run ... }
 *  }
 */

function isAuthorized(req) {
  const expected = String(process.env.ADMIN_TOKEN || (globalThis.crypto?.randomUUID?.() || String(Math.random()))).trim();
  const given = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.admin_token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return Boolean(expected && given && expected === given);
}

function clean(v) { return String(v ?? '').trim(); }

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const wantPreview = String(req.query.preview || '') === '1';
  const stores = getStoreNames().filter((store) => !isExcludedStore(store));

  /* Mail-log lezen + filteren op de twee reminder-types in laatste 7 dagen. */
  const log = await getMailLog();
  const cutoff = Date.now() - 7 * 24 * 36e5;
  const recentReminders = (log || []).filter((row) => {
    const t = new Date(row.createdAt || row.sentAt || 0).getTime();
    if (!Number.isFinite(t) || t < cutoff) return false;
    return row.type === 'weborder_overdue_store' || row.type === 'weborder_overdue_region_manager';
  });

  /* Per-store aggregatie. getStoreMailAsync leest eerst uit Blob (admin
     instellingen via Winkel-emailadressen) en valt dan terug op env-var. */
  const perStore = await Promise.all(stores.map(async (store) => {
    const recipient = await getStoreMailAsync(store);
    const email = recipient?.email || '';
    const myEntries = recentReminders.filter((r) => clean(r.store).toLowerCase() === clean(store).toLowerCase());
    const storeMails = myEntries.filter((r) => r.type === 'weborder_overdue_store' && r.status === 'sent');
    const managerMails = myEntries.filter((r) => r.type === 'weborder_overdue_region_manager' && r.status === 'sent');
    const lastStore = storeMails[0];
    const lastManager = managerMails[0];

    return {
      store,
      email,
      hasEmail: Boolean(email),
      sent7d: {
        storeMails: storeMails.length,
        managerMails: managerMails.length,
        lastStoreMailAt: lastStore?.createdAt || lastStore?.sentAt || '',
        lastManagerMailAt: lastManager?.createdAt || lastManager?.sentAt || ''
      },
      recent: myEntries.slice(0, 10).map((r) => ({
        type: r.type,
        order: r.order || r.key || '',
        at: r.createdAt || r.sentAt,
        status: r.status,
        recipient: r.recipient || ''
      }))
    };
  }));
  /* Sortering: winkels zonder email eerst (rood), dan op aantal recent verstuurd (hoog eerst) */
  perStore.sort((a, b) => {
    if (a.hasEmail !== b.hasEmail) return a.hasEmail ? 1 : -1;
    return (b.sent7d.storeMails + b.sent7d.managerMails) - (a.sent7d.storeMails + a.sent7d.managerMails);
  });

  /* Geaggregeerde KPI's voor admin-overzicht */
  const summary = {
    storesTotal: stores.length,
    storesWithEmail: perStore.filter((s) => s.hasEmail).length,
    storesMissingEmail: perStore.filter((s) => !s.hasEmail).length,
    storesWithSent7d: perStore.filter((s) => s.sent7d.storeMails > 0).length,
    totalStoreMails7d: perStore.reduce((sum, s) => sum + s.sent7d.storeMails, 0),
    totalManagerMails7d: perStore.reduce((sum, s) => sum + s.sent7d.managerMails, 0),
    lastMailAt: recentReminders[0]?.createdAt || recentReminders[0]?.sentAt || ''
  };

  let dryRun = null;
  if (wantPreview) {
    /* Roep intern weborder-mail-run aan met dryRun=1 om te zien wat de
       eerstvolgende echte run zou versturen. Vereist nu admin-token in
       weborder-mail-run (recent toegevoegd). */
    try {
      const baseUrl = getApiBaseUrl(req);
      const token = encodeURIComponent(getAdminToken());
      const url = `${baseUrl}/api/cron/weborder-mail-run?dryRun=1&adminToken=${token}&t=${Date.now()}`;
      const response = await fetch(url, {
        headers: { Accept: 'application/json', 'x-admin-token': getAdminToken() },
        signal: AbortSignal.timeout(60000)
      });
      const text = await response.text();
      try { dryRun = text ? JSON.parse(text) : { error: 'lege response' }; }
      catch (_e) { dryRun = { error: `Niet-JSON response: ${text.slice(0, 200)}` }; }
    } catch (error) {
      dryRun = { error: `Dry-run aanroep mislukt: ${error.message || error}` };
    }
  }

  return res.status(200).json({
    success: true,
    schedule: {
      cron: '0 8 * * *',
      cronLabel: 'dagelijks 08:00 UTC (= 09-10 NL)',
      deadlineDays: Number(process.env.WEBORDER_DEADLINE_OPERATIONAL_DAYS || 2),
      escalationDays: 4,
      antiDuplicateHours: 20
    },
    summary,
    perStore,
    dryRun
  });
}
