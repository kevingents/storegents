/**
 * /api/admin/mail-automations/status
 *
 * Status van de ACTIEVE mail-crons (de `*-mail-run` handlers). Bron:
 *   - laatste run + status: cron-run-state (cron-config-store, gevuld door
 *     trackedCron), de single source of truth voor "wanneer draaide deze cron".
 *   - verzonden/fouten: de gents-mail-log (gents-mail-log-store), waar alle
 *     run-crons hun mails in wegschrijven.
 *
 * Let op: de oude *-mail-automation endpoints + automation-state-store +
 * mail-log-store (zonder "gents-") zijn verwijderd/legacy en worden hier NIET
 * meer gelezen — die liepen leeg sinds de migratie naar de run-crons.
 *
 * Auth: admin vereist.
 */

import { handleCors, setCorsHeaders, requireAdmin } from '../../../lib/cors.js';
import { getMailLog } from '../../../lib/gents-mail-log-store.js';
import { getCronRunState } from '../../../lib/cron-config-store.js';

/* Welke mail-crons monitoren we, en op welke log-type-prefix tellen we sent/
   error. De run-crons loggen types als pickup_new_store, weborder_overdue_*,
   customer_weekly_store, … — prefix-match dekt alle varianten (dash én
   underscore). */
const AUTOMATIONS = [
  { key: 'pickup-mail-run',   label: 'Pickup-mails',                 prefix: 'pickup' },
  { key: 'weborder-mail-run', label: 'Weborder-deadline mails',      prefix: 'weborder' },
  { key: 'customer-mail-run', label: 'Klanten week/maand-rapport',   prefix: 'customer' },
  /* drager-mail-run is bewust uitgeschakeld (SRS SOAP-koppeling instabiel) —
     toon 'm wel zodat het zichtbaar is dat hij uit staat. */
  { key: 'drager-mail-run',   label: 'Drager-mails',                 prefix: 'drager', forceDisabled: true, note: 'Tijdelijk uit (SRS-koppeling)' }
];

/* Cron-run-status → frontend-status. De UI stylet alleen 'error' rood en toont
   'lastStatus' als label; we normaliseren zodat falen rood wordt. */
function normStatus(s) {
  const v = String(s || 'unknown').toLowerCase();
  if (v === 'success' || v === 'ok') return 'ok';
  if (v === 'failed' || v === 'error') return 'error';
  return v; /* partial, unknown */
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (requireAdmin(req, res)) return;

  /* De gedeelde mailer is geconfigureerd zodra Resend-key + afzender bestaan. */
  const mailerReady = Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL);

  const logs = await getMailLog().catch(() => []);

  /* Eén pass over de log: per prefix sent/error tellen + laatste mail-datum. */
  const tallies = new Map(AUTOMATIONS.map((a) => [a.prefix, { sent: 0, error: 0, lastAt: '' }]));
  for (const row of logs) {
    const type = String(row.type || '').toLowerCase();
    const status = String(row.status || '').toLowerCase();
    const at = row.createdAt || row.sentAt || '';
    for (const [prefix, t] of tallies) {
      if (!type.startsWith(prefix)) continue;
      if (status === 'sent') t.sent += 1;
      else if (status === 'error' || status === 'failed') t.error += 1;
      if (at && (!t.lastAt || at > t.lastAt)) t.lastAt = at;
      break;
    }
  }

  const automations = await Promise.all(AUTOMATIONS.map(async (a) => {
    const run = await getCronRunState(a.key).catch(() => null);
    const t = tallies.get(a.prefix) || { sent: 0, error: 0, lastAt: '' };
    return {
      key: a.key,
      label: a.label,
      enabled: a.forceDisabled ? false : mailerReady,
      note: a.note || '',
      lastRunAt: run?.lastRun || '',
      lastStatus: a.forceDisabled ? 'uit' : normStatus(run?.lastStatus),
      lastError: run?.lastError || '',
      runCount: Number(run?.runCount || 0),
      sentCount: t.sent,
      errorCount: t.error,
      lastMailAt: t.lastAt
    };
  }));

  return res.status(200).json({ success: true, automations });
}
