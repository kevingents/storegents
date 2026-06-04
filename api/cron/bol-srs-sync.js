/**
 * Cron: GET /api/cron/bol-srs-sync
 *
 * Pusht nieuwe Bol-orders naar SRS. Loopt 20 minuten na /api/cron/bol-orders
 * zodat de cache vers is.
 *
 * Schedule (in vercel.json): elk uur op :20.
 */

import { trackedCron } from '../../lib/cron-auto-track.js';
import { isCronAuthorized } from '../../lib/cron-auth.js';
import { pushBolOrdersToSrs } from '../../lib/bol-srs-push.js';
import { readBolSrsFailures, bumpBolSrsFailuresRunCount } from '../../lib/bol-srs-failures-store.js';
import { sendMail, baseMailHtml } from '../../lib/gents-mailer.js';

export const maxDuration = 180;

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (!isCronAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const dryRun = String(req.query?.dryRun || '') === '1';
  const maxPerRun = Number(req.query?.max || process.env.BOL_SRS_MAX_PER_RUN || 50);

  try {
    const result = await pushBolOrdersToSrs({ dryRun, maxPerRun });
    /* Mail bij failures (alleen als er nieuwe failures zijn in deze run). */
    if (!dryRun && result?.summary?.failed > 0) {
      try {
        await bumpBolSrsFailuresRunCount();
        const all = await readBolSrsFailures();
        const failuresInThisRun = (result.results || []).filter((r) => !r.success);
        const to = String(process.env.BOL_SRS_NOTIFY_EMAILS || process.env.MAINTAINER_EMAIL || '').split(',').map((s) => s.trim()).filter(Boolean);
        if (to.length) {
          const rows = failuresInThisRun.map((r) => `
            <tr>
              <td style="padding:6px 8px;font-family:monospace">${r.bolOrderId}</td>
              <td style="padding:6px 8px;font-family:monospace">${r.srsOrderId || '—'}</td>
              <td style="padding:6px 8px;color:#7f1d1d">${String(r.error || '').slice(0, 400)}</td>
            </tr>`).join('');
          const html = baseMailHtml({
            title: `Bol-SRS push: ${failuresInThisRun.length} order(s) faalden`,
            intro: `In de laatste cron-run zijn ${result.summary.pushed} order(s) succesvol gepusht en <strong>${result.summary.failed} faalden</strong>. Totaal nog open in failure-store: ${Object.keys(all.failed || {}).length}.`,
            bodyHtml: `<table style="width:100%;border-collapse:collapse;font-size:13px">
              <thead><tr style="background:#f1f5f9"><th style="padding:6px 8px;text-align:left">Bol-orderId</th><th style="padding:6px 8px;text-align:left">SRS-id</th><th style="padding:6px 8px;text-align:left">Error</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>`,
            footer: 'Verstuurd door /api/cron/bol-srs-sync.'
          });
          await sendMail({
            to,
            subject: `[GENTS] Bol→SRS push: ${failuresInThisRun.length} order(s) faalden`,
            html
          });
        }
      } catch (mailErr) {
        console.warn('[cron/bol-srs-sync] mail-error:', mailErr.message);
      }
    }
    return res.status(200).json(result);
  } catch (e) {
    console.error('[cron/bol-srs-sync]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}

export default trackedCron('bol-srs-sync', handler);
