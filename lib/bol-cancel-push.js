/**
 * lib/bol-cancel-push.js
 *
 * Annuleer een bol-order via de Bol Retailer API én markeer in de portal-state
 * dat 'm geannuleerd is. Voor SRS-kant: stuurt een mail-notificatie naar het
 * magazijn met BOL-NNNN + reden zodat zij de bestelling daar handmatig kunnen
 * sluiten. (Geen SRS-cancel-API beschikbaar — handmatig pad is de safe route.)
 *
 * Bol API: PUT /retailer/orders/{order-id}/cancellation
 *   Body: { orderItems: [{ orderItemId, reasonCode }] }
 *
 * Reason codes (Bol Retailer API v11):
 *   OUT_OF_STOCK            — niet meer op voorraad (default voor "niet leverbaar")
 *   UNFINDABLE_ITEM         — item kwijt in magazijn
 *   NOT_AVAILABLE_IN_TIME   — kan niet op tijd leveren
 *   BAD_CONDITION           — item is beschadigd
 *   HIGHER_SHIPCOST         — verzendkosten te hoog
 *   INCORRECT_PRICE         — prijs was fout
 *   ORDERED_TWICE           — klant heeft dubbel besteld
 *   REQUESTED_BY_CUSTOMER   — klant wil annuleren
 *   RETAIN_ITEM             — retailer wil item houden
 *   TECH_ISSUE              — technisch probleem
 *   NO_BOL_GUARANTEE        — voldoet niet aan bol-garantie
 *   OTHER                   — overig (vermijden waar mogelijk)
 */

import { bolPost, bolGet, bolOrdersVersion } from './bol-client.js';
import { sendMail, baseMailHtml } from './gents-mailer.js';
import { recordBolCancellation, isBolOrderCancelled } from './bol-cancellations-store.js';
import { readBolSrsPushedState } from './bol-srs-push.js';

const clean = (v) => String(v == null ? '' : v).trim();

export const BOL_CANCEL_REASONS = [
  { code: 'OUT_OF_STOCK',          label: 'Niet meer op voorraad', defaultText: 'Helaas is het bestelde artikel niet meer leverbaar.' },
  { code: 'UNFINDABLE_ITEM',       label: 'Artikel niet vindbaar', defaultText: 'Het artikel is niet meer in ons magazijn aanwezig.' },
  { code: 'NOT_AVAILABLE_IN_TIME', label: 'Niet op tijd leverbaar', defaultText: 'Wij kunnen het artikel niet binnen de afgesproken termijn leveren.' },
  { code: 'BAD_CONDITION',         label: 'Beschadigd', defaultText: 'Het artikel is beschadigd aangetroffen.' },
  { code: 'ORDERED_TWICE',         label: 'Dubbel besteld', defaultText: 'Deze bestelling is dubbel geplaatst.' },
  { code: 'REQUESTED_BY_CUSTOMER', label: 'Klant wil annuleren', defaultText: 'Op verzoek van de klant.' },
  { code: 'TECH_ISSUE',            label: 'Technisch probleem', defaultText: 'Een technische storing voorkomt levering.' },
  { code: 'INCORRECT_PRICE',       label: 'Prijsfout', defaultText: 'Helaas was de prijs niet correct.' },
  { code: 'HIGHER_SHIPCOST',       label: 'Verzendkosten te hoog', defaultText: 'De verzendkosten zijn hoger dan aangegeven.' },
  { code: 'RETAIN_ITEM',           label: 'Item houden', defaultText: 'Retailer beslist het item te houden.' },
  { code: 'NO_BOL_GUARANTEE',      label: 'Geen bol-garantie', defaultText: 'Voldoet niet aan de bol-garantie.' },
  { code: 'OTHER',                 label: 'Overig', defaultText: 'Andere reden.' }
];

function reasonByCode(code) {
  return BOL_CANCEL_REASONS.find((r) => r.code === clean(code)) || BOL_CANCEL_REASONS[0];
}

/* ─── Bol API: cancellation push ──────────────────────────────────────── */

/**
 * Haal de orderItemIds op voor een bol-order (nodig voor cancellation-body).
 * Returnt array van { orderItemId, ean, fulfilmentStatus, quantity }.
 */
async function fetchOrderItems(bolOrderId) {
  const data = await bolGet(`/orders/${encodeURIComponent(bolOrderId)}`, { version: bolOrdersVersion() });
  const items = Array.isArray(data?.orderItems) ? data.orderItems : [];
  return items.map((it) => ({
    orderItemId: clean(it.orderItemId),
    ean: clean(it.product?.ean || it.ean),
    fulfilmentStatus: clean(it.fulfilment?.status || it.fulfilmentStatus),
    quantity: Number(it.quantity || 1)
  }));
}

/**
 * Annuleer een bol-order — alle items of subset. Returnt processStatusId.
 *
 * @param {string} bolOrderId
 * @param {Object} opts
 * @param {string} opts.reasonCode  Reason-code uit BOL_CANCEL_REASONS
 * @param {string[]} [opts.orderItemIds]  Subset; default = alle open items
 */
export async function cancelBolOrderViaApi(bolOrderId, { reasonCode, orderItemIds } = {}) {
  const id = clean(bolOrderId);
  if (!id) throw new Error('bolOrderId verplicht.');
  const reason = reasonByCode(reasonCode);

  /* Haal items op als niet meegegeven — annuleer alleen items die nog OPEN zijn. */
  let targetIds = Array.isArray(orderItemIds) ? orderItemIds.filter(Boolean) : null;
  if (!targetIds || !targetIds.length) {
    const items = await fetchOrderItems(id);
    const open = items.filter((it) => {
      const s = (it.fulfilmentStatus || '').toUpperCase();
      return !s || s === 'OPEN' || s === 'PENDING';
    });
    targetIds = open.map((it) => it.orderItemId).filter(Boolean);
  }
  if (!targetIds.length) {
    throw new Error('Geen annuleerbare items in deze bol-order (alle items al verzonden of geannuleerd).');
  }

  const body = {
    orderItems: targetIds.map((orderItemId) => ({ orderItemId, reasonCode: reason.code }))
  };
  const resp = await bolPost(`/orders/${encodeURIComponent(id)}/cancellation`, body, { method: 'PUT', version: bolOrdersVersion() });
  return {
    bolOrderId: id,
    reasonCode: reason.code,
    cancelledItems: targetIds,
    bolProcessId: clean(resp?.processStatusId || resp?.id),
    response: resp || null
  };
}

/* ─── SRS-kant: notificatie naar magazijn ─────────────────────────────── */

/**
 * Stuur een mail aan het magazijn met de geannuleerde BOL-NNNN + reden zodat
 * zij in SRS de bestelling kunnen sluiten/markeren. Vereist
 * BOL_CANCEL_NOTIFY_EMAILS env (fallback BOL_SRS_NOTIFY_EMAILS, dan
 * MAINTAINER_EMAIL).
 */
async function notifySrsForCancellation({ bolOrderId, srsOrderId, reasonCode, reasonText, cancelledBy }) {
  const to = String(
    process.env.BOL_CANCEL_NOTIFY_EMAILS ||
    process.env.BOL_SRS_NOTIFY_EMAILS ||
    process.env.MAGAZIJN_EMAIL ||
    process.env.MAINTAINER_EMAIL ||
    ''
  ).split(',').map((s) => s.trim()).filter(Boolean);
  if (!to.length) return { sent: false, reason: 'geen ontvangers geconfigureerd' };

  const reason = reasonByCode(reasonCode);
  const bodyHtml = `
    <table style="width:100%;border-collapse:collapse;font:400 14px/1.5 Inter,sans-serif">
      <tr><td style="padding:8px 12px;color:#475569">Bol order-ID</td><td style="padding:8px 12px"><code>${bolOrderId}</code></td></tr>
      <tr style="background:#f8fafc"><td style="padding:8px 12px;color:#475569">SRS ordernummer</td><td style="padding:8px 12px"><strong>${srsOrderId || '— (nog niet gepushed)'}</strong></td></tr>
      <tr><td style="padding:8px 12px;color:#475569">Reden</td><td style="padding:8px 12px"><strong>${reason.label}</strong> <span style="color:#64748b">(${reason.code})</span></td></tr>
      ${reasonText ? `<tr style="background:#f8fafc"><td style="padding:8px 12px;color:#475569">Toelichting</td><td style="padding:8px 12px">${clean(reasonText)}</td></tr>` : ''}
      <tr><td style="padding:8px 12px;color:#475569">Geannuleerd door</td><td style="padding:8px 12px">${cancelledBy || 'systeem'}</td></tr>
    </table>
    <div style="margin-top:18px;padding:12px 14px;background:#fef3c7;border-radius:8px;color:#78350f;font-size:13px">
      <strong>Actie magazijn:</strong> verwijder/sluit ${srsOrderId ? `<code>${srsOrderId}</code>` : 'deze bol-order'} in SRS. Bol zelf is al geïnformeerd via API.
    </div>`;
  try {
    await sendMail({
      to,
      subject: `[GENTS] Bol-order geannuleerd · ${srsOrderId || bolOrderId} · ${reason.label}`,
      html: baseMailHtml({
        title: 'Bol-order geannuleerd',
        intro: `Bestelling ${srsOrderId || bolOrderId} is bij bol geannuleerd. Magazijn moet de order ook in SRS sluiten.`,
        bodyHtml,
        footer: 'Verstuurd door /api/admin/bol-cancel'
      })
    });
    return { sent: true, to };
  } catch (e) {
    return { sent: false, error: e.message };
  }
}

/* ─── Public: combined cancel ──────────────────────────────────────────── */

/**
 * Volledige annulerings-flow: Bol API + portal-state + SRS-mail.
 *
 * @param {string} bolOrderId
 * @param {Object} opts
 * @param {string} opts.reasonCode
 * @param {string} [opts.reasonText]    Optionele toelichting in mail
 * @param {string} [opts.cancelledBy]   Wie heeft het geannuleerd (user-id of "auto")
 * @param {string[]} [opts.orderItemIds] Subset; default = alle open items
 * @param {boolean} [opts.skipBolApi]   Voor recovery: alleen markeren, geen Bol-call
 */
export async function cancelBolOrderEverywhere(bolOrderId, opts = {}) {
  const id = clean(bolOrderId);
  if (!id) throw new Error('bolOrderId verplicht.');
  if (await isBolOrderCancelled(id)) {
    return { ok: true, alreadyCancelled: true, bolOrderId: id, message: 'Order was al geannuleerd in de portal.' };
  }

  /* Lookup SRS-ordernummer (BOL-NNNN) voor de mail-melding. */
  const pushedState = await readBolSrsPushedState().catch(() => ({ pushed: {} }));
  const srsOrderId = clean(pushedState?.pushed?.[id]?.srsOrderId);

  /* Stap 1: Bol API (tenzij skipBolApi). */
  let bolResult = null;
  if (!opts.skipBolApi) {
    try {
      bolResult = await cancelBolOrderViaApi(id, { reasonCode: opts.reasonCode, orderItemIds: opts.orderItemIds });
    } catch (e) {
      /* Markeer toch in de blob (met error) zodat het zichtbaar is dat er
         iets is gebeurd — gebruiker kan retry of handmatig sluiten in Bol. */
      await recordBolCancellation(id, {
        srsOrderId,
        reasonCode: opts.reasonCode,
        reasonText: opts.reasonText,
        cancelledBy: opts.cancelledBy,
        error: e.message
      });
      return { ok: false, bolOrderId: id, srsOrderId, error: `Bol-cancel faalde: ${e.message}` };
    }
  }

  /* Stap 2: notificatie naar magazijn (SRS-kant). */
  const srsNotif = await notifySrsForCancellation({
    bolOrderId: id,
    srsOrderId,
    reasonCode: opts.reasonCode,
    reasonText: opts.reasonText,
    cancelledBy: opts.cancelledBy
  });

  /* Stap 3: record in blob voor idempotency + history. */
  await recordBolCancellation(id, {
    srsOrderId,
    reasonCode: opts.reasonCode,
    reasonText: opts.reasonText,
    cancelledBy: opts.cancelledBy,
    items: bolResult?.cancelledItems || [],
    bolProcessId: bolResult?.bolProcessId,
    srsNotified: !!srsNotif.sent
  });

  return {
    ok: true,
    bolOrderId: id,
    srsOrderId,
    reasonCode: opts.reasonCode,
    cancelledItems: bolResult?.cancelledItems || [],
    bolProcessId: bolResult?.bolProcessId,
    srsNotificationSent: !!srsNotif.sent,
    srsNotificationTo: srsNotif.to || null
  };
}
