/**
 * /api/admin/vouchers/send-pending-emails
 *
 * Verstuurt alsnog de voucher-mail voor alle vouchers in de log die NOG NIET
 * gemaild zijn (mailed !== true) én een e-mailadres hebben. Idempotent: een
 * voucher met mailed:true wordt overgeslagen, dus dubbel draaien kan geen kwaad.
 *
 * Waarom nodig: bij de loyalty-run wordt alleen gemaild als de SRS-transactie
 * binnen het poll-venster 'completed' is. Blijft die op 'processing' of mislukt
 * de mail (geen adres / Resend-fout), dan staat de voucher wel in de log maar is
 * hij nooit verstuurd. Dit endpoint is de herkansing.
 *
 *   GET                         → preview: hoeveel staan er open (geen verzending)
 *   POST { confirm:true, limit } → verstuur (max `limit`, default 50, hard max 200)
 *   POST { dryRun:true }         → zelfde als GET
 *
 * Auth: admin-token vereist.
 */

import { getVoucherLogs, updateVoucherLogById } from '../../../lib/voucher-log-store.js';
import { sendVoucherEmail } from '../../../lib/voucher-mailer.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

export const maxDuration = 60;

/* Statussen waarbij de voucher al gebruikt/gesloten is → niet (alsnog) mailen. */
const CLOSED_STATUSES = new Set([
  'afgeboekt_in_srs',
  'gebruikt_in_shopify',
  'gebruikt_in_winkel_shopify_gedeactiveerd',
  'gebruikt_in_winkel_geen_shopify',
  'shopify_giftcard_gedeactiveerd'
]);

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || (globalThis.crypto?.randomUUID?.() || String(Math.random()));
  const token = String(req.headers['x-admin-token'] || req.headers.authorization || req.query.adminToken || '')
    .replace(/^Bearer\s+/i, '').trim();
  return token === adminToken;
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Voucher die nog gemaild moet worden: code + e-mail aanwezig, niet gemaild, niet gebruikt. */
function isPending(log) {
  if (!log || !log.voucherCode) return false;
  if (log.mailed === true) return false;
  if (!log.customerEmail) return false;
  if (CLOSED_STATUSES.has(String(log.status || ''))) return false;
  return true;
}

const slim = (l) => ({
  id: l.id, voucherCode: l.voucherCode, customerName: l.customerName || '',
  customerEmail: l.customerEmail || '', amount: l.amount, validTo: l.validTo || '',
  status: l.status || '', error: l.error || '', createdAt: l.createdAt || ''
});

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ success: false, message: 'Alleen GET of POST.' });

  try {
    const logs = await getVoucherLogs();
    const created = logs.filter((l) => l && l.voucherCode);
    const pending = created.filter(isPending);
    const noEmail = created.filter((l) => !l.mailed && !l.customerEmail && !CLOSED_STATUSES.has(String(l.status || ''))).length;
    const alreadyMailed = created.filter((l) => l.mailed === true).length;

    const overview = {
      totalLogged: created.length,
      alreadyMailed,
      pendingCount: pending.length,
      noEmailCount: noEmail
    };

    const body = parseBody(req);
    const dryRun = req.method === 'GET' || body.dryRun === true || body.confirm !== true;

    if (dryRun) {
      return res.status(200).json({
        success: true, dryRun: true, ...overview,
        candidates: pending.slice(0, 100).map(slim)
      });
    }

    /* Echte verzending — gecapt + zachte rate-limit voor Resend. */
    const limit = Math.min(Math.max(1, Number(body.limit) || 50), 200);
    const batch = pending.slice(0, limit);
    let sent = 0, failed = 0;
    const errors = [];

    for (const log of batch) {
      try {
        await sendVoucherEmail({
          to: log.customerEmail,
          customerName: log.customerName,
          voucherCode: log.voucherCode,
          amount: log.amount,
          currency: log.currency || 'EUR',
          validFrom: log.validFrom,
          validTo: log.validTo,
          shopifyEnabled: false,
          note: 'Deze voucher is automatisch aangemaakt op basis van je gespaarde punten.'
        });
        await updateVoucherLogById(log.id, {
          mailed: true,
          status: 'Automatisch aangemaakt en gemaild',
          error: '',
          mailedAt: new Date().toISOString()
        });
        sent += 1;
      } catch (error) {
        failed += 1;
        const msg = error?.message || 'Voucher-mail kon niet worden verstuurd.';
        errors.push({ voucherCode: log.voucherCode, customerEmail: log.customerEmail, error: msg });
        await updateVoucherLogById(log.id, { status: 'Automatisch aangemaakt, mail mislukt', error: msg }).catch(() => {});
      }
      await sleep(150);
    }

    return res.status(200).json({
      success: true,
      ...overview,
      attempted: batch.length,
      sent,
      failed,
      remaining: Math.max(0, pending.length - batch.length),
      errors: errors.slice(0, 25)
    });
  } catch (error) {
    console.error('[vouchers/send-pending-emails]', error);
    return res.status(500).json({ success: false, message: error.message || 'Openstaande voucher-mails versturen mislukt.' });
  }
}
