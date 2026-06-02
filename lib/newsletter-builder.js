/**
 * lib/newsletter-builder.js
 *
 * Block-builder voor nieuwsbrieven: een nieuwsbrief = een geordende lijst blokken
 * (hero, tekst, producten, banner, knop, divider). De header/footer komen uit het
 * bewerkbare thema (emailShell). Render → HTML, opslag in blob, verzenden via een
 * Resend-broadcast naar de hoofd-audience (met ingebouwde uitschrijflink).
 *
 * Blob: marketing/newsletters.json = [{ id, name, subject, preheader, status,
 *   blocks:[...], updatedAt, sentAt?, broadcastId? }]
 */

import { Resend } from 'resend';
import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';
import { getEmailTheme } from './email-template-store.js';
import { emailShell, ctaButton, esc } from './automations-core.js';
import { getStoreSenderConfig, storeFromAddress } from './resend-sender.js';
import { getResendAudienceConfig } from './resend-audience.js';
import { sendGentsMail } from './resend-mailer.js';

const PATH = 'marketing/newsletters.json';
const clean = (v) => String(v == null ? '' : v).trim();
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const HEAD_FONT = "Georgia,'Times New Roman',serif";

/* Beschikbare blok-types + hun standaardwaarden (voor de builder-UI). */
export const BLOCK_DEFS = [
  { type: 'hero', label: 'Hero', defaults: { image: '', title: 'Nieuwe collectie', subtitle: 'Stijlvol. Licht. Comfortabel.', buttonLabel: 'Shop nu', buttonUrl: 'https://gents.nl' } },
  { type: 'text', label: 'Tekst', defaults: { text: 'Schrijf hier je tekst…' } },
  { type: 'products', label: 'Producten', defaults: { title: 'Uitgelicht', items: [{ title: 'Product', image: '', price: '', url: 'https://gents.nl' }] } },
  { type: 'banner', label: 'Banner', defaults: { image: '', url: 'https://gents.nl' } },
  { type: 'button', label: 'Knop', defaults: { label: 'Bekijk de collectie', url: 'https://gents.nl' } },
  { type: 'divider', label: 'Scheiding', defaults: {} }
];

function renderBlock(b, theme) {
  const t = { buttonBg: '#071B3A', textColor: '#111111', ...(theme || {}) };
  switch (b && b.type) {
    case 'hero':
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px"><tr><td>
        ${b.image ? `<img src="${esc(b.image)}" width="528" alt="" style="display:block;width:100%;border-radius:10px;border:0;margin-bottom:14px">` : ''}
        ${b.title ? `<div style="font-family:${HEAD_FONT};font-size:26px;font-weight:700;line-height:1.15;color:${esc(t.textColor)};margin-bottom:6px">${esc(b.title)}</div>` : ''}
        ${b.subtitle ? `<div style="font-family:${FONT};font-size:15px;color:#666;margin-bottom:14px">${esc(b.subtitle)}</div>` : ''}
        ${b.buttonLabel ? ctaButton(b.buttonLabel, b.buttonUrl, theme) : ''}
      </td></tr></table>`;
    case 'text':
      return `<div style="font-family:${FONT};font-size:15px;line-height:1.62;color:${esc(t.textColor)};margin:0 0 18px">${esc(b.text).replace(/\n/g, '<br>')}</div>`;
    case 'products': {
      const items = Array.isArray(b.items) ? b.items : [];
      const cell = (p) => `<td width="50%" valign="top" style="padding:0 6px 12px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #ececec;border-radius:10px;overflow:hidden"><tr><td>
          ${p.image ? `<img src="${esc(p.image)}" width="252" alt="" style="display:block;width:100%;border:0">` : '<div style="height:150px;background:#f4f5f7"></div>'}
          <div style="padding:12px 14px;font-family:${FONT}">
            <div style="font-family:${HEAD_FONT};font-size:15px;font-weight:700;color:${esc(t.textColor)}">${esc(p.title || 'Product')}</div>
            ${p.price ? `<div style="font-size:13px;color:#666;margin:3px 0">${esc(p.price)}</div>` : ''}
            ${p.url ? `<a href="${esc(p.url)}" style="color:${esc(t.buttonBg)};text-decoration:none;font-size:13px;font-weight:600;border-bottom:2px solid ${esc(t.buttonBg)}">Bekijk →</a>` : ''}
          </div>
        </td></tr></table>
      </td>`;
      const rowsHtml = [];
      for (let i = 0; i < items.length; i += 2) rowsHtml.push(`<tr>${cell(items[i])}${items[i + 1] ? cell(items[i + 1]) : '<td width="50%"></td>'}</tr>`);
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px">
        ${b.title ? `<tr><td colspan="2" style="font-family:${HEAD_FONT};font-size:18px;font-weight:700;color:${esc(t.textColor)};padding:0 6px 10px">${esc(b.title)}</td></tr>` : ''}
        ${rowsHtml.join('')}</table>`;
    }
    case 'banner':
      return b.image
        ? `<div style="margin:0 0 18px">${b.url ? `<a href="${esc(b.url)}">` : ''}<img src="${esc(b.image)}" width="528" alt="" style="display:block;width:100%;border-radius:10px;border:0">${b.url ? '</a>' : ''}</div>`
        : '';
    case 'button':
      return `<div style="text-align:center;margin:6px 0 18px">${ctaButton(b.label, b.url, theme)}</div>`;
    case 'divider':
      return `<div style="border-top:1px solid #ececec;margin:8px 0 22px"></div>`;
    default:
      return '';
  }
}

export function renderNewsletterHtml(nl, theme) {
  const body = (nl.blocks || []).map((b) => renderBlock(b, theme)).join('');
  return emailShell({ theme, greeting: false, preheader: nl.preheader || '', bodyHtml: body });
}

/* ── CRUD ── */
export async function listNewsletters() {
  const l = await readJsonBlob(PATH, []).catch(() => []);
  return Array.isArray(l) ? l : [];
}
async function writeAll(list) { await writeJsonBlob(PATH, list); }
export async function getNewsletter(id) { return (await listNewsletters()).find((n) => n.id === id) || null; }

export async function saveNewsletter({ id, name, subject, preheader, blocks } = {}) {
  const list = await listNewsletters();
  if (id) {
    const i = list.findIndex((n) => n.id === id);
    if (i < 0) throw new Error('Nieuwsbrief niet gevonden.');
    list[i] = {
      ...list[i],
      name: clean(name).slice(0, 120) || list[i].name,
      subject: clean(subject).slice(0, 160),
      preheader: clean(preheader).slice(0, 160),
      blocks: Array.isArray(blocks) ? blocks.slice(0, 60) : list[i].blocks,
      updatedAt: new Date().toISOString()
    };
    await writeAll(list);
    return list[i];
  }
  const obj = {
    id: 'nl-' + Math.random().toString(36).slice(2, 9),
    name: clean(name).slice(0, 120) || 'Nieuwe nieuwsbrief',
    subject: clean(subject).slice(0, 160),
    preheader: clean(preheader).slice(0, 160),
    status: 'concept',
    blocks: Array.isArray(blocks) ? blocks : [{ type: 'hero', ...BLOCK_DEFS[0].defaults }],
    updatedAt: new Date().toISOString(), createdAt: new Date().toISOString()
  };
  list.push(obj);
  await writeAll(list);
  return obj;
}

export async function deleteNewsletter(id) { await writeAll((await listNewsletters()).filter((n) => n.id !== id)); return true; }
export async function duplicateNewsletter(id) {
  const src = await getNewsletter(id);
  if (!src) throw new Error('Nieuwsbrief niet gevonden.');
  return saveNewsletter({ name: src.name + ' (kopie)', subject: src.subject, preheader: src.preheader, blocks: src.blocks });
}

/* ── Verzenden ── */
export async function previewNewsletter(id) {
  const nl = await getNewsletter(id);
  if (!nl) throw new Error('Nieuwsbrief niet gevonden.');
  return renderNewsletterHtml(nl, await getEmailTheme());
}

export async function sendNewsletterTest(id, email) {
  const nl = await getNewsletter(id);
  if (!nl) throw new Error('Nieuwsbrief niet gevonden.');
  const e = clean(email).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('Ongeldig test-e-mailadres.');
  const [theme, senderCfg] = await Promise.all([getEmailTheme(), getStoreSenderConfig()]);
  await sendGentsMail({
    to: e, subject: '[TEST] ' + (nl.subject || nl.name), html: renderNewsletterHtml(nl, theme),
    from: storeFromAddress('', senderCfg), type: 'nieuwsbrief-test', meta: { newsletter: id }
  });
  return { ok: true, email: e };
}

export async function sendNewsletterBroadcast(id) {
  const nl = await getNewsletter(id);
  if (!nl) throw new Error('Nieuwsbrief niet gevonden.');
  const key = clean(process.env.RESEND_API_KEY);
  if (!key) throw new Error('RESEND_API_KEY ontbreekt.');
  const audCfg = await getResendAudienceConfig();
  if (!audCfg.mainAudienceId) throw new Error('Geen hoofd-audience in Resend. Draai eerst de audience-sync / vul Resend.');
  const [theme, senderCfg] = await Promise.all([getEmailTheme(), getStoreSenderConfig()]);
  const resend = new Resend(key);
  const created = await resend.broadcasts.create({
    audienceId: audCfg.mainAudienceId,
    from: storeFromAddress('', senderCfg),
    subject: nl.subject || nl.name,
    name: nl.name,
    html: renderNewsletterHtml(nl, theme)
  });
  if (created.error) throw new Error(created.error.message || 'Broadcast aanmaken mislukte.');
  const broadcastId = created.data && created.data.id;
  const sent = await resend.broadcasts.send({ broadcastId });
  if (sent.error) throw new Error(sent.error.message || 'Broadcast versturen mislukte.');

  const list = await listNewsletters();
  const i = list.findIndex((n) => n.id === id);
  if (i >= 0) { list[i] = { ...list[i], status: 'verzonden', broadcastId, sentAt: new Date().toISOString() }; await writeAll(list); }
  return { ok: true, broadcastId };
}
