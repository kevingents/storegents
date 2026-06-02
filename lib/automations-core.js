/**
 * lib/automations-core.js
 *
 * Gedeelde bouwstenen voor de slimme e-mail-automations: HTML-shell (per-winkel
 * gebrand), productkaart, en kleine helpers. Hergebruikt door de registry.
 */

export const clean = (v) => String(v == null ? '' : v).trim();
export const lc = (v) => clean(v).toLowerCase();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const cleanEmail = (e) => { const s = lc(e); return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : ''; };
export const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* sku(lc) → totale (positieve) voorraad over alle filialen. */
export function buildStockBySku(rows) {
  const m = new Map();
  for (const r of (rows || [])) {
    const sku = lc(r.sku);
    if (!sku) continue;
    const v = Number(r.voorraad) || 0;
    if (v > 0) m.set(sku, (m.get(sku) || 0) + v);
  }
  return m;
}

export function makeLookup(cache) {
  return (sku) => (cache.bySku && cache.bySku[lc(sku)]) || (cache.byBarcode && cache.byBarcode[lc(sku)]) || null;
}

/* Parse een SRS-datum (YYYY-MM-DD of met tijd) → Date of null. */
export function parseDate(s) {
  const t = Date.parse(clean(s));
  return Number.isNaN(t) ? null : new Date(t);
}

/* Bewerkbaar e-mail-thema (bron-van-waarheid: marketing/email-template.json via
   email-template-store.js). Deze defaults gelden als er nog niets is ingesteld. */
export const EMAIL_THEME_DEFAULTS = {
  brandName: 'GENTS',
  headerBg: '#071B3A',
  buttonBg: '#071B3A',
  textColor: '#111111',
  pageBg: '#f6f7f9',
  logoUrl: '',
  greetingPrefix: 'Hoi',
  signoff: 'Tot snel',
  footerText: 'Je ontvangt deze mail omdat je je bij GENTS hebt aangemeld voor updates.',
  buttonLabel: 'Bekijk de collectie',
  shopUrl: 'https://gents.nl'
};
const theme = (t) => ({ ...EMAIL_THEME_DEFAULTS, ...(t || {}) });

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const HEAD_FONT = "Georgia,'Times New Roman',serif";

export function ctaButton(label, url, t) {
  const th = theme(t);
  /* Gecentreerde, bullet-proof knop. */
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0"><tr><td align="center" bgcolor="${esc(th.buttonBg)}" style="border-radius:8px">
    <a href="${esc(url || th.shopUrl)}" style="display:inline-block;background:${esc(th.buttonBg)};color:#fff;text-decoration:none;font-family:${FONT};font-size:14px;font-weight:600;letter-spacing:.3px;padding:13px 26px;border-radius:8px">${esc(label || th.buttonLabel)}</a>
  </td></tr></table>`;
}

export function voucherBox(txt, t) {
  const th = theme(t);
  return txt
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0"><tr><td style="background:#faf8f4;border:1px solid ${esc(th.headerBg)}22;border-left:4px solid ${esc(th.buttonBg)};border-radius:8px;padding:14px 16px;font-family:${FONT};font-size:14px;color:${esc(th.textColor)}">${esc(txt)}</td></tr></table>`
    : '';
}

/* Branded, modern e-mail-shell. `bodyHtml` is de inhoud; afzender-winkel in de
   header. Het uiterlijk komt uit het (bewerkbare) thema. Tabel-gebaseerd +
   inline styles → betrouwbaar in alle mailclients. */
export function emailShell({ store = '', firstName = '', bodyHtml = '', footer = '', preheader = '', theme: t } = {}) {
  const th = theme(t);
  const hi = firstName ? `${esc(th.greetingPrefix)} ${esc(firstName)},` : `${esc(th.greetingPrefix)},`;
  const brand = th.logoUrl
    ? `<img src="${esc(th.logoUrl)}" alt="${esc(th.brandName)}" height="30" style="display:block;margin:0 auto;border:0">`
    : `<div style="font-family:${HEAD_FONT};font-size:24px;font-weight:700;letter-spacing:3px;text-transform:uppercase">${esc(th.brandName)}</div>`;
  const sub = store ? `<div style="font-family:${FONT};font-size:11px;letter-spacing:2px;text-transform:uppercase;opacity:.85;margin-top:6px">${esc(store)}</div>` : '';
  const pre = preheader ? `<span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden">${esc(preheader)}</span>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body style="margin:0;padding:0;background:${esc(th.pageBg)};-webkit-font-smoothing:antialiased">
    ${pre}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${esc(th.pageBg)}"><tr><td align="center" style="padding:28px 14px">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.06)">
        <tr><td align="center" style="background:${esc(th.headerBg)};color:#ffffff;padding:30px 24px">${brand}${sub}</td></tr>
        <tr><td style="height:3px;background:${esc(th.buttonBg)}"></td></tr>
        <tr><td style="padding:34px 36px 26px;font-family:${FONT};color:${esc(th.textColor)};font-size:15px;line-height:1.62">
          <p style="margin:0 0 16px;font-size:17px;font-weight:600">${hi}</p>
          ${bodyHtml}
          <p style="margin:22px 0 0;color:#777;font-size:14px">${esc(th.signoff)}${store ? ' in ' + esc(store) : ''},<br><strong style="color:${esc(th.textColor)}">${esc(th.brandName)}${store ? ' ' + esc(store) : ''}</strong></p>
        </td></tr>
        <tr><td style="padding:0 36px"><div style="border-top:1px solid #ececec"></div></td></tr>
        <tr><td align="center" style="padding:18px 36px 26px;font-family:${FONT};color:#9aa0a6;font-size:11.5px;line-height:1.6">
          ${esc(th.footerText)}${footer ? '<br>' + footer : ''}
        </td></tr>
      </table>
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%"><tr><td align="center" style="padding:14px;font-family:${FONT};color:#b6bbc0;font-size:11px">${esc(th.brandName)} · Herenmode</td></tr></table>
    </td></tr></table>
  </body></html>`;
}

export function productCard(p, t) {
  const th = theme(t);
  const sizes = Array.isArray(p.matchedSizes) ? p.matchedSizes : (Array.isArray(p.sizes) ? p.sizes : []);
  const pill = (s) => `<span style="display:inline-block;border:1px solid #dcdfe3;border-radius:4px;padding:2px 8px;margin:0 4px 4px 0;font-size:12px;color:${esc(th.textColor)}">${esc(s)}</span>`;
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;border:1px solid #ececec;border-radius:10px;overflow:hidden">
      <tr>
        <td width="132" valign="top" style="background:#f6f7f9">${p.image ? `<img src="${esc(p.image)}" width="132" alt="" style="display:block;border:0;width:132px">` : '<div style="width:132px;height:132px"></div>'}</td>
        <td valign="top" style="padding:14px 16px;font-family:${FONT};color:${esc(th.textColor)}">
          <div style="font-family:${HEAD_FONT};font-size:17px;font-weight:700;margin-bottom:4px">${esc(p.title || 'Item')}</div>
          ${sizes.length ? `<div style="font-size:12px;color:#777;margin-bottom:4px">In jouw maat op voorraad</div><div style="margin-bottom:8px">${sizes.map(pill).join('')}</div>` : ''}
          ${p.url ? `<a href="${esc(p.url)}" style="display:inline-block;color:${esc(th.buttonBg)};text-decoration:none;font-size:14px;font-weight:600;border-bottom:2px solid ${esc(th.buttonBg)};padding-bottom:1px">Bekijk dit item →</a>` : ''}
        </td>
      </tr>
    </table>`;
}

/* Koopprofiel uit transacties: hoofdgroep(lc) → { sizes:Set, lastTs, count } + lastBuyTs globaal. */
export function buildPurchaseProfile(transactions, lookup, lookbackDays) {
  const cutoff = lookbackDays ? Date.now() - lookbackDays * 86400000 : 0;
  const byHg = new Map();
  let lastBuyTs = 0;
  for (const t of (transactions || [])) {
    const ts = parseDate(t.dateTime)?.getTime() || 0;
    if (cutoff && ts && ts < cutoff) continue;
    if (ts > lastBuyTs) lastBuyTs = ts;
    for (const it of (t.items || [])) {
      const v = lookup(it.sku);
      if (!v) continue;
      const hgKey = lc(v.hoofdgroepOmschrijving || v.hoofdgroep);
      if (!hgKey) continue;
      if (!byHg.has(hgKey)) byHg.set(hgKey, { label: clean(v.hoofdgroepOmschrijving || v.hoofdgroep), sizes: new Set(), lastTs: 0, count: 0 });
      const e = byHg.get(hgKey);
      e.count++;
      if (ts > e.lastTs) e.lastTs = ts;
      const size = clean(v.size);
      if (size) e.sizes.add(size);
    }
  }
  return { byHg, lastBuyTs };
}
