/**
 * GET /api/cron/reserveringen-expire
 *
 * Dagelijkse cron die:
 *   1. Open reserveringen waarvan geldigTot < vandaag → markeer 'verlopen'
 *      + SRS-weborder cancellen → voorraad terug op winkel
 *   2. Bijna-verlopen reserveringen (geldigTot = morgen) → mail naar
 *      winkel als reminder (telefoneer klant)
 *
 * Cron schedule (vercel.json): elke dag 06:00.
 *
 * Auth: Vercel-cron-secret OF admin-token.
 */

import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { getReserveringen, updateReservering } from '../../lib/reserveringen-store.js';
import { cancelFulfillment } from '../../lib/srs-weborders-cancel-client.js';
import { getEmailForStore } from '../../lib/store-emails-store.js';
import { trackedCron } from '../../lib/cron-auto-track.js';

function isAuthorized(req) {
  /* Vercel-cron stuurt Authorization: Bearer <CRON_SECRET> */
  const cronSecret = String(process.env.CRON_SECRET || '').trim();
  const adminToken = String(process.env.ADMIN_TOKEN || '').trim();
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const xToken = String(req.headers['x-admin-token'] || '').trim();
  const qToken = String(req.query.token || req.query.adminToken || '').trim();
  if (cronSecret && bearer === cronSecret) return true;
  if (adminToken && (bearer === adminToken || xToken === adminToken || qToken === adminToken)) return true;
  /* Op Vercel: header `x-vercel-cron` aanwezig bij scheduled functions */
  if (req.headers['x-vercel-cron']) return true;
  return false;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}
function tomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function sendNearExpireMail(reservering) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, reason: 'no-api-key' };
  const to = await getEmailForStore(reservering.store);
  if (!to) return { sent: false, reason: 'no-store-email' };
  const from = process.env.RESEND_FROM_EMAIL || 'GENTS Portaal <portal@gents.nl>';
  const klant = reservering.customer || {};
  const item = reservering.item || {};
  const subject = `Reservering verloopt morgen — ${item.title} (${reservering.store})`;
  const html = `
    <div style="font-family:-apple-system,sans-serif;max-width:600px;color:#0a1f33">
      <h2>Reservering verloopt morgen</h2>
      <p>De volgende reservering verloopt op <strong>${new Date(reservering.geldigTot).toLocaleDateString('nl-NL')}</strong>:</p>
      <table style="width:100%;border-collapse:collapse;margin:14px 0">
        <tr><td style="padding:6px 10px;background:#f1f5f9;width:140px">Artikel</td><td style="padding:6px 10px"><strong>${item.title || '—'}</strong> — ${[item.color, item.size].filter(Boolean).join(' · ')}</td></tr>
        <tr><td style="padding:6px 10px;background:#f1f5f9">Klant</td><td style="padding:6px 10px">${klant.name || '—'}${klant.phone ? ` · <a href="tel:${klant.phone}">${klant.phone}</a>` : ''}</td></tr>
        <tr><td style="padding:6px 10px;background:#f1f5f9">Door</td><td style="padding:6px 10px">${reservering.employeeName || '—'}</td></tr>
      </table>
      <p style="padding:12px;background:#fef3c7;border-left:3px solid #f59e0b;border-radius:4px">
        <strong>Actie:</strong> bel de klant om aan te bieden om alsnog op te halen. Als de klant niet komt, wordt morgen de SRS-weborder automatisch geannuleerd en valt voorraad terug op je winkel.
      </p>
      <p style="margin-top:18px;font-size:12px;color:#64748b">Reserveringsnummer: ${reservering.id}${reservering.srsTransactionId ? ` · SRS weborder: ${reservering.srsTransactionId}` : ''}</p>
    </div>
  `;
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, html })
    });
    return { sent: response.ok };
  } catch (error) {
    return { sent: false, reason: error.message };
  }
}

async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  const now = today();
  const dayAhead = tomorrow();
  const expired = [];
  const reminders = [];
  const failed = [];

  try {
    /* Pak ALLE open reserveringen, inclusief al opgehaalde — we filteren zelf. */
    const all = await getReserveringen({ status: 'open', includeAll: true, limit: 5000 });

    for (const r of all) {
      const geldigTot = String(r.geldigTot || '').slice(0, 10);
      if (!geldigTot) continue;

      /* 1) VERLOPEN: geldigTot < vandaag → status 'verlopen' + SRS-cancel */
      if (geldigTot < now) {
        try {
          let cancelOk = false;
          let cancelMessage = '';
          if (r.srsTransactionId && r.srsSyncStatus === 'weborder_created') {
            const item = r.item || {};
            const cancel = await cancelFulfillment({
              orderNr: r.srsTransactionId,
              sku: item.sku || item.barcode,
              barcode: item.barcode || item.sku,
              pieces: Math.max(1, Number(item.quantity || 1)),
              price: Number(item.price || 0)
            });
            cancelOk = Boolean(cancel?.success);
            cancelMessage = cancel?.messages?.[0] || (cancelOk ? 'cancelled' : 'not-confirmed');
          }
          await updateReservering(r.id, {
            status: 'verlopen',
            note: `Auto-verlopen door cron (geldigTot ${geldigTot}). SRS-cancel: ${cancelMessage || 'n.v.t.'}`,
            srsSyncStatus: r.srsTransactionId
              ? (cancelOk ? 'weborder_cancelled' : 'cancel_failed')
              : r.srsSyncStatus,
            srsError: cancelOk ? '' : (cancelMessage || '')
          }, 'cron');
          expired.push({ id: r.id, store: r.store, item: r.item?.title, srsCancelled: cancelOk });
        } catch (err) {
          failed.push({ id: r.id, store: r.store, error: err.message });
        }
        continue;
      }

      /* 2) BIJNA-VERLOPEN: geldigTot = morgen → reminder-mail aan winkel */
      if (geldigTot === dayAhead) {
        try {
          const mail = await sendNearExpireMail(r);
          reminders.push({ id: r.id, store: r.store, mailSent: mail.sent });
        } catch (err) {
          failed.push({ id: r.id, store: r.store, error: err.message });
        }
      }
    }

    return res.status(200).json({
      success: true,
      ranAt: new Date().toISOString(),
      processed: all.length,
      expiredCount: expired.length,
      remindersCount: reminders.length,
      failedCount: failed.length,
      expired,
      reminders,
      failed
    });
  } catch (error) {
    console.error('[cron/reserveringen-expire]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
}

export default trackedCron('reserveringen-expire', handler);
