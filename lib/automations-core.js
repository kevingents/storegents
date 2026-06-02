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

/* Branded e-mail-shell. `bodyHtml` is de inhoud; afzender-winkel in de header. */
export function emailShell({ store = '', firstName = '', bodyHtml = '', footer = '' }) {
  const hi = firstName ? `Hoi ${esc(firstName)},` : 'Hoi,';
  return `<!doctype html><html><body style="margin:0;background:#f6f7f9;padding:24px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden">
        <tr><td style="background:#071B3A;color:#fff;padding:18px 24px;font-family:Arial,sans-serif;font-size:18px;font-weight:bold">GENTS${store ? ' ' + esc(store) : ''}</td></tr>
        <tr><td style="padding:22px 24px;font-family:Arial,sans-serif;color:#111;font-size:14px;line-height:1.5">
          <p style="margin:0 0 12px">${hi}</p>
          ${bodyHtml}
          <p style="margin:16px 0 0;color:#555;font-size:13px">Tot snel${store ? ' in ' + esc(store) : ''}!</p>
        </td></tr>
        <tr><td style="padding:14px 24px;border-top:1px solid #eee;font-family:Arial,sans-serif;color:#999;font-size:11px">
          Je ontvangt deze mail omdat je je bij GENTS hebt aangemeld voor updates.${footer ? ' ' + footer : ''}
        </td></tr>
      </table>
    </td></tr></table>
  </body></html>`;
}

export function productCard(p) {
  const sizes = Array.isArray(p.matchedSizes) ? p.matchedSizes : (Array.isArray(p.sizes) ? p.sizes : []);
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px">
      <tr>
        <td width="110" valign="top">${p.image ? `<img src="${esc(p.image)}" width="100" alt="" style="border-radius:8px;display:block">` : ''}</td>
        <td valign="top" style="padding-left:14px;font-family:Arial,sans-serif;color:#111">
          <div style="font-size:15px;font-weight:bold">${esc(p.title || 'Item')}</div>
          ${sizes.length ? `<div style="font-size:13px;color:#555;margin:3px 0">Op voorraad in: <strong>${esc(sizes.join(', '))}</strong></div>` : ''}
          ${p.url ? `<a href="${esc(p.url)}" style="display:inline-block;margin-top:6px;background:#071B3A;color:#fff;text-decoration:none;font-size:13px;padding:8px 14px;border-radius:6px">Bekijk</a>` : ''}
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
