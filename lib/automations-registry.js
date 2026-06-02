/**
 * lib/automations-registry.js
 *
 * Definities van de slimme e-mail-automations. Elke automation levert:
 *  - velden (voor de UI), defaults, of het koophistorie nodig heeft,
 *  - eligible() : goedkope voorfilter (zonder SOAP),
 *  - match()    : besluit + data voor de mail,
 *  - email()    : { subject, html }.
 * De runner (automation-runner.js) verzorgt het scannen, dedupe en versturen.
 */

import { readProductsCache } from './shopify-products-cache.js';
import { esc, lc, clean, emailShell, productCard, buildPurchaseProfile, makeLookup, parseDate } from './automations-core.js';

const SHOP_URL = 'https://gents.nl';
const ctaButton = (label = 'Bekijk de collectie', url = SHOP_URL) =>
  `<a href="${esc(url)}" style="display:inline-block;margin-top:6px;background:#071B3A;color:#fff;text-decoration:none;font-size:14px;padding:10px 18px;border-radius:6px">${esc(label)}</a>`;
const voucherBox = (txt) => txt
  ? `<div style="margin:14px 0;padding:12px 14px;background:#f1f5f9;border:1px dashed #94a3b8;border-radius:8px;font-size:14px;color:#111">${esc(txt)}</div>`
  : '';

const daysAgo = (ts) => (ts ? Math.round((Date.now() - ts) / 86400000) : null);

export const AUTOMATIONS = {
  /* ───────────────── Verjaardag ───────────────── */
  birthday: {
    id: 'birthday',
    label: 'Verjaardag',
    description: 'Persoonlijke verjaardagsmail vanaf de eigen winkel (optioneel met een cadeau-code).',
    needsTransactions: false,
    cooldownDays: 330,
    recheckDays: 0,
    maxPages: 60,
    fields: [
      { key: 'subject', label: 'Onderwerp', type: 'text' },
      { key: 'leadDays', label: 'Dagen vooraf sturen', type: 'number', min: 0, max: 14 },
      { key: 'voucherText', label: 'Cadeau-tekst (optioneel)', type: 'text' },
      { key: 'maxPerRun', label: 'Max mails per run', type: 'number', min: 1, max: 1000 }
    ],
    defaults: { subject: 'Een cadeautje voor jou — fijne verjaardag!', leadDays: 0, voucherText: '', maxPerRun: 300 },
    context: async () => ({}),
    eligible: (c, _ctx, cfg) => {
      const d = parseDate(c.birthDate);
      if (!d) return false;
      const bm = d.getMonth(), bd = d.getDate();
      const lead = Math.max(0, Math.min(14, Number(cfg.leadDays) || 0));
      for (let i = 0; i <= lead; i++) {
        const t = new Date(Date.now() + i * 86400000);
        if (t.getMonth() === bm && t.getDate() === bd) return true;
      }
      return false;
    },
    match: () => ({ kind: 'birthday' }),
    email: (c, store, _m, _ctx, cfg) => ({
      subject: cfg.subject || 'Fijne verjaardag!',
      html: emailShell({
        store, firstName: clean(c.firstName),
        bodyHtml: `<p style="margin:0 0 14px">Van het hele team van GENTS${store ? ' ' + esc(store) : ''}: een hele fijne verjaardag! Bedankt dat je klant bij ons bent.</p>${voucherBox(cfg.voucherText)}<p style="margin:0 0 14px">Kom je verjaardag bij ons vieren met iets moois?</p>${ctaButton('Shop je cadeau', SHOP_URL)}`
      })
    })
  },

  /* ───────────────── Win-back ───────────────── */
  winback: {
    id: 'winback',
    label: 'Win-back',
    description: 'Klanten die al een tijd niets kochten een persoonlijke reminder sturen.',
    needsTransactions: true,
    cooldownDays: 120,
    recheckDays: 21,
    maxPages: 80,
    fields: [
      { key: 'subject', label: 'Onderwerp', type: 'text' },
      { key: 'minDays', label: 'Minimaal stil (dagen)', type: 'number', min: 30, max: 1500 },
      { key: 'maxDays', label: 'Maximaal stil (dagen)', type: 'number', min: 60, max: 2000 },
      { key: 'voucherText', label: 'Cadeau-tekst (optioneel)', type: 'text' },
      { key: 'maxPerRun', label: 'Klanten per run', type: 'number', min: 1, max: 500 }
    ],
    defaults: { subject: 'We missen je bij GENTS', minDays: 180, maxDays: 730, voucherText: '', maxPerRun: 80 },
    context: async () => ({ lookup: makeLookup(await readProductsCache()) }),
    match: (_c, ctx, cfg, transactions) => {
      const maxDays = Math.max(60, Number(cfg.maxDays) || 730);
      const minDays = Math.max(30, Number(cfg.minDays) || 180);
      const prof = buildPurchaseProfile(transactions, ctx.lookup, maxDays + 30);
      const since = daysAgo(prof.lastBuyTs);
      if (since == null || since < minDays || since > maxDays) return null;
      let favHg = '';
      let best = 0;
      for (const e of prof.byHg.values()) if (e.count > best) { best = e.count; favHg = e.label; }
      return { kind: 'winback', daysSince: since, favHg };
    },
    email: (c, store, m, _ctx, cfg) => ({
      subject: cfg.subject || 'We missen je bij GENTS',
      html: emailShell({
        store, firstName: clean(c.firstName),
        bodyHtml: `<p style="margin:0 0 14px">Het is alweer even geleden${m.favHg ? ` sinds je je laatste ${esc(m.favHg.toLowerCase())} bij ons koos` : ''}. We zouden je graag weer in stijl helpen.</p>${voucherBox(cfg.voucherText)}<p style="margin:0 0 14px">Er is genoeg nieuws — kom langs of kijk online.</p>${ctaButton('Bekijk wat nieuw is', SHOP_URL)}`
      })
    })
  },

  /* ───────────────── Replenishment ───────────────── */
  replenishment: {
    id: 'replenishment',
    label: 'Herhaalaankoop',
    description: 'Herinnering om herhaal-artikelen (sokken, overhemden, ondergoed) aan te vullen na een vaste cyclus.',
    needsTransactions: true,
    cooldownDays: 120,
    recheckDays: 21,
    maxPages: 80,
    fields: [
      { key: 'subject', label: 'Onderwerp', type: 'text' },
      { key: 'repeatGroups', label: 'Hoofdgroepen (komma)', type: 'text' },
      { key: 'cycleDays', label: 'Cyclus (dagen)', type: 'number', min: 30, max: 730 },
      { key: 'windowDays', label: 'Marge (dagen)', type: 'number', min: 7, max: 120 },
      { key: 'maxPerRun', label: 'Klanten per run', type: 'number', min: 1, max: 500 }
    ],
    defaults: { subject: 'Tijd om aan te vullen?', repeatGroups: 'Sokken, Ondergoed, Overhemden', cycleDays: 120, windowDays: 45, maxPerRun: 80 },
    context: async (cfg) => ({
      lookup: makeLookup(await readProductsCache()),
      repeatSet: new Set(String(cfg.repeatGroups || '').split(',').map((s) => lc(s)).filter(Boolean))
    }),
    match: (_c, ctx, cfg, transactions) => {
      if (!ctx.repeatSet.size) return null;
      const cycleDays = Math.max(30, Number(cfg.cycleDays) || 120);
      const windowDays = Math.max(7, Number(cfg.windowDays) || 45);
      const prof = buildPurchaseProfile(transactions, ctx.lookup, (cycleDays + windowDays) * 2 + 30);
      const due = [];
      for (const [hgKey, e] of prof.byHg.entries()) {
        if (!ctx.repeatSet.has(hgKey)) continue;
        const since = daysAgo(e.lastTs);
        if (since != null && since >= cycleDays && since <= cycleDays + windowDays) due.push({ label: e.label, daysSince: since });
      }
      return due.length ? { kind: 'replenishment', groups: due } : null;
    },
    email: (c, store, m, _ctx, cfg) => {
      const groups = (m.groups || []).map((g) => g.label).filter(Boolean);
      const list = groups.length > 1 ? groups.slice(0, -1).join(', ') + ' en ' + groups.slice(-1) : (groups[0] || 'je favorieten');
      return {
        subject: cfg.subject || 'Tijd om aan te vullen?',
        html: emailShell({
          store, firstName: clean(c.firstName),
          bodyHtml: `<p style="margin:0 0 14px">Op is op — en jouw ${esc(list.toLowerCase())} zijn misschien wel toe aan vers. We hebben volop voorraad.</p>${ctaButton('Vul je voorraad aan', SHOP_URL)}`
        })
      };
    }
  }
};

export function listAutomationDefs() {
  return Object.values(AUTOMATIONS).map((d) => ({
    id: d.id, label: d.label, description: d.description, fields: d.fields, defaults: d.defaults
  }));
}
