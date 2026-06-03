/**
 * lib/customer-report-mail.js
 *
 * Gedeelde bouwstenen voor de klanten-rapport mail (het "volledige overzicht"):
 *  - periode-logica (wekelijks = deze maand t/m vandaag, maandelijks = vorige maand)
 *  - tijd-gebonden kleurdrempels voor "% met e-mail vs target"
 *  - de e-mail-HTML (alle winkels gesorteerd op % met e-mail + totalen + conversie
 *    + podium + nieuwe targets volgende maand)
 *  - ontvanger-resolutie (winkel-emails + extra genoemde personen)
 *  - config-store (blob admin/customer-report-mail.json) via mutateJsonBlob
 *
 * Gebruikt door:
 *  - api/cron/customer-mail-run.js          (geplande verzending)
 *  - api/admin/customer-report-test-mail.js (testmail naar 1 adres)
 *  - api/admin/customer-report-mail-config.js (config lezen/opslaan)
 */

import { baseMailHtml } from './gents-mailer.js';
import { getAllStoreEmails } from './store-emails-store.js';
import { readJsonBlob, mutateJsonBlob } from './json-blob-store.js';

export const CUSTOMER_REPORT_MAIL_CONFIG_PATH = 'admin/customer-report-mail.json';

/* Standaard: automatische verzending UIT (de gebruiker zet 'm aan na het testen). */
export const DEFAULT_MAIL_CONFIG = Object.freeze({
  enabled: false,
  includeStoreEmails: true,
  extraRecipients: [],   // [{ name, email }]
  includePodium: true
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const num = (v) => Number(v || 0);
const round = (v) => Math.round(Number(v) || 0);
const iso = (d) => d.toISOString().slice(0, 10);
const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const BAND_COLORS = { green: '#16a34a', orange: '#d97706', red: '#dc2626', muted: '#94a3b8' };
export function bandColor(band) { return BAND_COLORS[band] || BAND_COLORS.muted; }

/* ── Periode-logica ─────────────────────────────────────────────────────── */

/**
 * @param {'weekly'|'monthly'} mode
 * @param {Date} [now]
 * @returns {{mode, label, range:{from,to}, asOfDay:number, isFinal:boolean, targetsMonth:{year,month}|null}}
 */
export function computeReportRanges(mode, now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  if (mode === 'monthly') {
    const firstThis = new Date(Date.UTC(y, m, 1));
    const lastPrev = new Date(firstThis.getTime() - 86400000);
    const firstPrev = new Date(Date.UTC(lastPrev.getUTCFullYear(), lastPrev.getUTCMonth(), 1));
    return {
      mode: 'monthly',
      label: firstPrev.toLocaleDateString('nl-NL', { month: 'long', year: 'numeric' }),
      range: { from: iso(firstPrev), to: iso(lastPrev) },
      asOfDay: lastPrev.getUTCDate(),
      isFinal: true,
      /* "De nieuwe targets voor de maand erop" = de maand die nu (op de 1e) start. */
      targetsMonth: { year: y, month: m + 1 }
    };
  }
  /* weekly: deze maand vanaf de 1e t/m vandaag (de maandag waarop de cron draait). */
  const firstThis = new Date(Date.UTC(y, m, 1));
  return {
    mode: 'weekly',
    label: `deze maand t/m ${now.toLocaleDateString('nl-NL', { day: '2-digit', month: 'short' })}`,
    range: { from: iso(firstThis), to: iso(now) },
    asOfDay: now.getUTCDate(),
    isFinal: false,
    targetsMonth: null
  };
}

/**
 * Tijd-gebonden kleurband voor "% met e-mail vs target".
 *  - maandafsluiting (isFinal): ≥100 groen · ≥80 oranje · <80 rood
 *  - lopende maand: na 7 dgn ≥25%, na 14 dgn ≥50%, na 21 dgn ≥75% = groen, anders rood
 *    (eerste week: neutraal/groen, nog geen rode drempel)
 */
export function pctBand(pct, refDay, isFinal) {
  if (pct == null) return 'muted';
  if (isFinal) return pct >= 100 ? 'green' : pct >= 80 ? 'orange' : 'red';
  const day = Number(refDay) || 0;
  const greenAt = day >= 22 ? 75 : day >= 15 ? 50 : day >= 8 ? 25 : null;
  if (greenAt == null) return pct > 0 ? 'green' : 'muted';
  return pct >= greenAt ? 'green' : 'red';
}

/* ── Per-winkel metrieken ───────────────────────────────────────────────── */

export function newCountOf(r) { return num(r.newCustomers ?? r.newCount ?? r.total); }

export function rowMetrics(r) {
  const nieuw = newCountOf(r);
  const withEmail = num(r.withEmail);
  const withoutEmail = r.withoutEmail != null ? num(r.withoutEmail) : Math.max(0, nieuw - withEmail);
  const target = num(r.targetInschrijvingen);
  const bonnen = num(r.totalReceiptsInStore);
  const pctEmail = target > 0 ? round((withEmail / target) * 100) : null;   /* hoe dicht bij target (alleen met-email telt) */
  const conv = bonnen > 0 ? round((withEmail / bonnen) * 100) : null;        /* conversie: met-email ÷ totaal bonnen */
  return { store: r.store, nieuw, withEmail, withoutEmail, target, bonnen, pctEmail, conv };
}

export function sortByEmailPct(metrics) {
  return [...metrics].sort((a, b) => {
    const ap = a.pctEmail, bp = b.pctEmail;
    if (ap == null && bp == null) return b.withEmail - a.withEmail;
    if (ap == null) return 1;
    if (bp == null) return -1;
    if (bp !== ap) return bp - ap;
    return b.withEmail - a.withEmail;
  });
}

/* ── E-mail HTML ────────────────────────────────────────────────────────── */

export function buildOverviewEmailHtml({ mode, label, range, rows, asOfDay, isFinal, nextTargets, includePodium = true }) {
  const metrics = (rows || []).map(rowMetrics);
  const sorted = sortByEmailPct(metrics);

  const T = metrics.reduce((a, r) => {
    a.nieuw += r.nieuw; a.withEmail += r.withEmail; a.withoutEmail += r.withoutEmail;
    a.target += r.target; a.bonnen += r.bonnen; return a;
  }, { nieuw: 0, withEmail: 0, withoutEmail: 0, target: 0, bonnen: 0 });
  const totPctEmail = T.target > 0 ? round((T.withEmail / T.target) * 100) : null;
  const totConv = T.bonnen > 0 ? round((T.withEmail / T.bonnen) * 100) : null;

  const periodLine = `<p style="margin:0 0 16px;color:#3a4a5a;font-size:14px">Periode: <strong>${esc(range.from)}</strong> t/m <strong>${esc(range.to)}</strong></p>`;

  const kpiCard = (lbl, value, sub, color) => `
    <td style="padding:6px" width="33%" valign="top">
      <div style="border:1px solid #e1e6eb;border-radius:14px;padding:14px 16px;background:#fff">
        <div style="font-size:11px;color:#3a4a5a;text-transform:uppercase;letter-spacing:.06em">${esc(lbl)}</div>
        <div style="font-size:26px;font-weight:600;color:${color || '#0a1f33'};margin-top:4px;line-height:1">${esc(value)}</div>
        ${sub ? `<div style="font-size:12px;color:#64748b;margin-top:4px">${esc(sub)}</div>` : ''}
      </div>
    </td>`;
  const kpis = `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:6px"><tr>
      ${kpiCard('Inschrijvingen totaal', String(T.nieuw), `${sorted.length} winkels`, '#0a1f33')}
      ${kpiCard('Met e-mail', String(T.withEmail), 'telt mee voor target', '#16a34a')}
      ${kpiCard('% met e-mail vs target', totPctEmail == null ? '—' : totPctEmail + '%', `${T.withEmail} / ${T.target || '—'}`, bandColor(pctBand(totPctEmail, asOfDay, isFinal)))}
    </tr><tr>
      ${kpiCard('Zonder e-mail', String(T.withoutEmail), 'telt niet mee', '#dc2626')}
      ${kpiCard('Totaal bonnen', String(T.bonnen), 'kassabonnen periode', '#0a1f33')}
      ${kpiCard('Conversie (met e-mail ÷ bonnen)', totConv == null ? '—' : totConv + '%', `${T.withEmail} / ${T.bonnen || '—'}`, '#0a1f33')}
    </tr></table>`;

  let podium = '';
  if (includePodium && mode === 'weekly') {
    const top = [...metrics].filter((r) => r.withEmail > 0).sort((a, b) => b.withEmail - a.withEmail).slice(0, 3);
    if (top.length) {
      const medals = ['#d4af37', '#9ca3af', '#b87333']; /* goud / zilver / brons */
      podium = `<h3 style="margin:20px 0 8px;font-size:15px;color:#0a1f33">Podium — meeste inschrijvingen mét e-mail</h3>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>${top.map((r, i) => `
        <td width="33%" style="padding:6px" valign="top"><div style="border:1px solid #e1e6eb;border-left:4px solid ${medals[i]};border-radius:12px;padding:12px 14px;background:#fff">
          <div style="font-size:12px;color:#64748b;font-weight:700">${i + 1}e plaats</div>
          <div style="font-size:15px;font-weight:600;color:#0a1f33;margin-top:2px">${esc(r.store)}</div>
          <div style="font-size:13px;color:#16a34a;font-weight:600;margin-top:2px">${r.withEmail} met e-mail</div>
        </div></td>`).join('')}</tr></table>`;
    }
  }

  const th = (t, align = 'left') => `<th style="padding:8px 10px;border-bottom:2px solid #e1e6eb;text-align:${align};font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#3a4a5a">${t}</th>`;
  const td = (v, align = 'left', extra = '') => `<td style="padding:8px 10px;border-bottom:1px solid #eef2f7;font-size:13px;color:#0a1f33;text-align:${align};${extra}">${v}</td>`;
  const pctHtml = (pct, band) => pct == null ? `<span style="color:#94a3b8">—</span>` : `<strong style="color:${bandColor(band)}">${pct}%</strong>`;
  const bodyRows = sorted.map((r) => {
    const band = pctBand(r.pctEmail, asOfDay, isFinal);
    return `<tr>
      ${td(`<strong>${esc(r.store)}</strong>`)}
      ${td(String(r.nieuw), 'right')}
      ${td(`<span style="color:#16a34a;font-weight:600">${r.withEmail}</span>`, 'right')}
      ${td(`<span style="color:#94a3b8">${r.withoutEmail}</span>`, 'right')}
      ${td(r.target ? String(r.target) : '—', 'right')}
      ${td(pctHtml(r.pctEmail, band), 'right')}
      ${td(r.bonnen ? String(r.bonnen) : '—', 'right')}
      ${td(r.conv == null ? '<span style="color:#94a3b8">—</span>' : r.conv + '%', 'right')}
    </tr>`;
  }).join('');
  const totalRow = `<tr style="background:#f8fafc">
    ${td('<strong>TOTAAL</strong>')}
    ${td(`<strong>${T.nieuw}</strong>`, 'right')}
    ${td(`<strong style="color:#16a34a">${T.withEmail}</strong>`, 'right')}
    ${td(`<strong style="color:#94a3b8">${T.withoutEmail}</strong>`, 'right')}
    ${td(`<strong>${T.target || '—'}</strong>`, 'right')}
    ${td(`<strong style="color:${bandColor(pctBand(totPctEmail, asOfDay, isFinal))}">${totPctEmail == null ? '—' : totPctEmail + '%'}</strong>`, 'right')}
    ${td(`<strong>${T.bonnen || '—'}</strong>`, 'right')}
    ${td(`<strong>${totConv == null ? '—' : totConv + '%'}</strong>`, 'right')}
  </tr>`;
  const table = `<h3 style="margin:20px 0 8px;font-size:15px;color:#0a1f33">Per winkel — gesorteerd op % met e-mail</h3>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #e1e6eb;border-radius:14px;overflow:hidden">
      <thead><tr style="background:#f1f5f9">${th('Winkel')}${th('Nieuw', 'right')}${th('Met e-mail', 'right')}${th('Zonder', 'right')}${th('Target', 'right')}${th('% e-mail', 'right')}${th('Bonnen', 'right')}${th('Conversie', 'right')}</tr></thead>
      <tbody>${bodyRows || '<tr><td colspan="8" style="padding:10px;color:#94a3b8">Geen data voor deze periode.</td></tr>'}${bodyRows ? totalRow : ''}</tbody>
    </table>`;

  let nextSection = '';
  if (nextTargets && nextTargets.byStore && nextTargets.month) {
    const mk = nextTargets.month;
    const monthName = new Date(Date.UTC(mk.year, mk.month - 1, 1)).toLocaleDateString('nl-NL', { month: 'long', year: 'numeric' });
    const trows = sorted.map((r) => {
      const t = nextTargets.byStore[r.store] || {};
      const tv = t.customers_new;
      return `<tr>${td(`<strong>${esc(r.store)}</strong>`)}${td(tv != null ? String(tv) : '<span style="color:#94a3b8">—</span>', 'right')}</tr>`;
    }).join('');
    nextSection = `<h3 style="margin:24px 0 8px;font-size:15px;color:#0a1f33">Nieuwe targets — ${esc(monthName)}</h3>
      <p style="margin:0 0 8px;color:#64748b;font-size:13px">De inschrijvingen-targets voor de komende maand.</p>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #e1e6eb;border-radius:14px;overflow:hidden">
        <thead><tr style="background:#f1f5f9">${th('Winkel')}${th('Target inschrijvingen', 'right')}</tr></thead>
        <tbody>${trows || '<tr><td colspan="2" style="padding:10px;color:#94a3b8">Nog geen targets ingesteld.</td></tr>'}</tbody>
      </table>`;
  }

  const legend = isFinal
    ? `<p style="font-size:12px;color:#64748b;margin-top:16px">Kleur % e-mail (maandafsluiting): <span style="color:#16a34a">groen ≥100%</span> · <span style="color:#d97706">oranje 80–100%</span> · <span style="color:#dc2626">rood &lt;80%</span>. Alleen inschrijvingen mét e-mail tellen mee voor de target.</p>`
    : `<p style="font-size:12px;color:#64748b;margin-top:16px">Kleur % e-mail loopt mee met de maand: na 7 dagen ≥25%, na 14 dagen ≥50%, na 21 dagen ≥75% = groen, daaronder rood. Alleen inschrijvingen mét e-mail tellen mee voor de target.</p>`;

  return baseMailHtml({
    title: mode === 'monthly' ? `Klanten — maandoverzicht ${label}` : `Klanten — overzicht ${label}`,
    intro: mode === 'monthly'
      ? `Volledig klantoverzicht over ${label} (vorige maand), met de totalen en de nieuwe targets voor de komende maand.`
      : `Volledig klantoverzicht voor deze maand t/m vandaag, met de totalen. Gesorteerd op hoe dicht elke winkel bij de e-mail-target zit.`,
    bodyHtml: `${periodLine}${kpis}${podium}${table}${nextSection}${legend}
      <p style="font-size:12px;color:#64748b;margin-top:14px">Instellen onder <strong>Instellingen → Klantenrapport e-mail</strong> en <strong>Rapportages → Klanten-targets</strong>.</p>`
  });
}

/* ── Ontvangers ─────────────────────────────────────────────────────────── */

export async function resolveOverviewRecipients(config = DEFAULT_MAIL_CONFIG) {
  const set = new Set();
  if (config.includeStoreEmails !== false) {
    try {
      const map = await getAllStoreEmails();
      for (const v of Object.values(map || {})) {
        const e = String(v || '').trim().toLowerCase();
        if (e && EMAIL_RE.test(e)) set.add(e);
      }
    } catch { /* geen winkel-emails beschikbaar */ }
  }
  for (const r of (config.extraRecipients || [])) {
    const e = String(r?.email || '').trim().toLowerCase();
    if (e && EMAIL_RE.test(e)) set.add(e);
  }
  return [...set];
}

/* ── Config-store ───────────────────────────────────────────────────────── */

export async function readMailConfig() {
  const c = await readJsonBlob(CUSTOMER_REPORT_MAIL_CONFIG_PATH, { ...DEFAULT_MAIL_CONFIG });
  return {
    ...DEFAULT_MAIL_CONFIG,
    ...(c && typeof c === 'object' ? c : {}),
    extraRecipients: Array.isArray(c?.extraRecipients) ? c.extraRecipients : []
  };
}

export async function writeMailConfig(patch = {}, actor = 'admin') {
  return mutateJsonBlob(CUSTOMER_REPORT_MAIL_CONFIG_PATH, (cur) => {
    const next = { ...DEFAULT_MAIL_CONFIG, ...(cur && typeof cur === 'object' ? cur : {}) };
    if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
    if (patch.includeStoreEmails !== undefined) next.includeStoreEmails = !!patch.includeStoreEmails;
    if (patch.includePodium !== undefined) next.includePodium = !!patch.includePodium;
    if (patch.extraRecipients !== undefined) {
      next.extraRecipients = (Array.isArray(patch.extraRecipients) ? patch.extraRecipients : [])
        .map((x) => ({ name: String(x?.name || '').trim().slice(0, 80), email: String(x?.email || '').trim().toLowerCase() }))
        .filter((x) => x.email && EMAIL_RE.test(x.email));
    }
    next.updatedAt = new Date().toISOString();
    next.updatedBy = String(actor || 'admin');
    return next;
  }, { fallback: { ...DEFAULT_MAIL_CONFIG } });
}
