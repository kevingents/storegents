/**
 * Mail-events store: ontvangt en bewaart e-mail events (delivered, bounced,
 * complained) van Resend webhooks.
 *
 * Blob layout:
 *   mail-events/index.json       — laatste 5000 events (chronologisch, nieuwste eerst)
 *
 * Schema per event:
 *   {
 *     id: 'evt_abc123',           // Resend event id (idempotency)
 *     type: 'email.bounced',
 *     resendMessageId: 're_xyz',
 *     to: 'klant@email.nl',
 *     from: 'GENTS <no-reply@gents.nl>',
 *     subject: 'Je GENTS voucher ...',
 *     occurredAt: '2026-05-20T08:32:01.123Z',
 *     receivedAt: '2026-05-20T08:32:02.000Z',
 *     bounceType: 'hard' | 'soft' | undefined,
 *     reason: 'invalid recipient' | undefined,
 *     tags: { ... }               // Resend tags (we taggen voucher-mails)
 *   }
 *
 * Events ouder dan 90 dagen worden weggegooid bij elke append.
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const INDEX_PATH = 'mail-events/index.json';
const MAX_EVENTS = Number(process.env.MAIL_EVENTS_MAX || 5000);
const MAX_AGE_DAYS = Number(process.env.MAIL_EVENTS_MAX_AGE_DAYS || 90);

function clean(v) { return String(v || '').trim(); }

export async function readMailEvents() {
  const d = await readJsonBlob(INDEX_PATH, { events: [], updatedAt: null });
  if (!Array.isArray(d.events)) d.events = [];
  return d;
}

function pruneOld(events) {
  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 36e5;
  return events.filter((e) => {
    const t = new Date(e.occurredAt || e.receivedAt || 0).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
}

export async function appendMailEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const cleaned = {
    id: clean(event.id),
    type: clean(event.type),
    resendMessageId: clean(event.resendMessageId || event.messageId || event.email_id),
    to: clean(event.to),
    from: clean(event.from),
    subject: clean(event.subject),
    occurredAt: event.occurredAt || event.createdAt || new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    bounceType: event.bounceType || undefined,
    reason: event.reason || undefined,
    tags: event.tags && typeof event.tags === 'object' ? event.tags : undefined
  };

  const d = await readMailEvents();

  /* Dedupliceer op event-id */
  if (cleaned.id && d.events.find((e) => e.id === cleaned.id)) {
    return { duplicate: true, event: cleaned };
  }

  d.events.unshift(cleaned);
  /* Prune oud + cap size */
  d.events = pruneOld(d.events).slice(0, MAX_EVENTS);
  d.updatedAt = new Date().toISOString();
  await writeJsonBlob(INDEX_PATH, d);
  return { duplicate: false, event: cleaned };
}

/**
 * Aggregeer mail-events voor stats.
 *
 * Filters:
 *   subjectPrefix: alleen subjects die starten met X (bv. 'Je GENTS voucher')
 *   tag: 'voucher' (matched events.tags.category === 'voucher')
 *   sinceDays: standaard 30
 */
export async function aggregateMailEvents({
  subjectPrefix = '',
  tagCategory = '',
  sinceDays = 30
} = {}) {
  const d = await readMailEvents();
  const cutoff = Date.now() - sinceDays * 24 * 36e5;

  const filtered = d.events.filter((e) => {
    const t = new Date(e.occurredAt || e.receivedAt || 0).getTime();
    if (!Number.isFinite(t) || t < cutoff) return false;
    if (subjectPrefix && !String(e.subject || '').toLowerCase().startsWith(subjectPrefix.toLowerCase())) return false;
    if (tagCategory && e.tags?.category !== tagCategory) return false;
    return true;
  });

  const stats = {
    total: filtered.length,
    sent: 0,
    delivered: 0,
    bounced: 0,
    bouncedHard: 0,
    bouncedSoft: 0,
    complained: 0,
    delayed: 0,
    opened: 0,
    clicked: 0,
    other: 0
  };

  /* Per recipient kunnen meerdere events binnenkomen (sent, delivered, opened).
     Een 'bounce' wordt het authoritative status. Tracking per recipient. */
  const byRecipient = new Map();
  const recentBounces = [];

  for (const e of filtered) {
    const t = String(e.type || '').toLowerCase();
    if (t.includes('sent')) stats.sent += 1;
    else if (t.includes('delivered')) stats.delivered += 1;
    else if (t.includes('bounced')) {
      stats.bounced += 1;
      if (e.bounceType === 'hard') stats.bouncedHard += 1;
      else if (e.bounceType === 'soft') stats.bouncedSoft += 1;
      if (recentBounces.length < 50) {
        recentBounces.push({
          to: e.to,
          subject: e.subject,
          bounceType: e.bounceType,
          reason: e.reason,
          occurredAt: e.occurredAt
        });
      }
    }
    else if (t.includes('complained')) stats.complained += 1;
    else if (t.includes('delayed')) stats.delayed += 1;
    else if (t.includes('opened')) stats.opened += 1;
    else if (t.includes('clicked')) stats.clicked += 1;
    else stats.other += 1;

    const r = e.to;
    if (r) {
      const cur = byRecipient.get(r) || { events: 0, hasBounce: false, hasComplaint: false };
      cur.events += 1;
      if (t.includes('bounced')) cur.hasBounce = true;
      if (t.includes('complained')) cur.hasComplaint = true;
      byRecipient.set(r, cur);
    }
  }

  /* Berekende ratios — gebruik delivered+bounced als noemer (geen sent want
     niet alle systemen reporten een sent-event consequent) */
  const denominator = Math.max(1, stats.delivered + stats.bounced);
  const bounceRate = Number(((stats.bounced / denominator) * 100).toFixed(2));
  const complaintRate = Number(((stats.complained / denominator) * 100).toFixed(2));
  const deliverabilityRate = Number(((stats.delivered / denominator) * 100).toFixed(2));

  return {
    sinceDays,
    subjectPrefix,
    tagCategory,
    stats,
    bounceRate,
    complaintRate,
    deliverabilityRate,
    uniqueRecipients: byRecipient.size,
    recipientsWithBounce: Array.from(byRecipient.values()).filter((v) => v.hasBounce).length,
    recipientsWithComplaint: Array.from(byRecipient.values()).filter((v) => v.hasComplaint).length,
    recentBounces
  };
}
