/**
 * lib/automation-runner.js
 *
 * Generieke runner voor zowel de vaste registry-automations (verjaardag, win-back,
 * replenishment, …) als door de gebruiker/AI gemaakte custom-automations. Eén
 * scan-loop (executeScan) verzorgt: klanten scannen, dedupe (cooldown + recheck),
 * en versturen via de per-winkel Resend-afzender met het bewerkbare thema.
 *
 * Verstuurt ALLEEN bij dryRun=false. Per run gemaximeerd (maxPerRun). Idempotent.
 */

import { getCustomers, getTransactions } from './srs-customers-client.js';
import { branchIdToStoreName } from './business-config.js';
import { getStoreSenderConfig, storeFromAddress, storeReplyTo } from './resend-sender.js';
import { sendGentsMail } from './resend-mailer.js';
import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';
import { readProductsCache } from './shopify-products-cache.js';
import { AUTOMATIONS } from './automations-registry.js';
import { cleanEmail, clean, lc, sleep, makeLookup, parseDate, buildPurchaseProfile, emailShell, voucherBox, ctaButton, esc } from './automations-core.js';
import { getEmailTheme } from './email-template-store.js';
import {
  listCustomAutomations, getCustomAutomation, patchCustomAutomation, describeRule
} from './custom-automations-store.js';

const blobPath = (id) => `marketing/automation-${id}.json`;

export async function getAutomationConfig(id) {
  const def = AUTOMATIONS[id];
  if (!def) throw new Error(`Onbekende automation: ${id}`);
  const stored = await readJsonBlob(blobPath(id), null).catch(() => null);
  return { enabled: false, ...def.defaults, sent: {}, processed: {}, lastRun: null, lastResult: null, ...(stored || {}) };
}
export async function saveAutomationConfig(id, patch = {}) {
  const cur = await getAutomationConfig(id);
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  await writeJsonBlob(blobPath(id), next);
  return next;
}

function slimConfig(def, cfg) {
  const values = {};
  for (const f of def.fields) values[f.key] = cfg[f.key];
  return { enabled: !!cfg.enabled, values, sentCount: Object.keys(cfg.sent || {}).length, lastRun: cfg.lastRun, lastResult: cfg.lastResult };
}

export async function listAutomationsStatus() {
  const registry = [];
  for (const def of Object.values(AUTOMATIONS)) {
    const cfg = await getAutomationConfig(def.id);
    registry.push({ id: def.id, type: 'registry', label: def.label, description: def.description, fields: def.fields, config: slimConfig(def, cfg) });
  }
  const custom = (await listCustomAutomations()).map((c) => ({
    id: c.id, type: 'custom', label: c.label, description: describeRule(c.rule || {}),
    enabled: !!c.enabled, content: c.content, rule: c.rule, maxPerRun: c.maxPerRun || 80,
    sentCount: Object.keys(c.sent || {}).length, lastRun: c.lastRun, lastResult: c.lastResult
  }));
  return { registry, custom };
}

/* ─── Gedeelde scan-loop ─── */
async function executeScan({ def, cfg, id, dryRun, cap, theme, senderCfg, ctx }) {
  const now = Date.now();
  const maxPages = Math.max(1, Number(def.maxPages || 80));
  const cooldownMs = (Number(def.cooldownDays) || 0) * 86400000;
  const recheckMs = (Number(def.recheckDays) || 0) * 86400000;

  const sent = { ...(cfg.sent || {}) };
  const processed = { ...(cfg.processed || {}) };
  const seen = new Set();
  const candidates = [];
  const perStore = {};
  let scanned = 0, evaluated = 0, pushed = 0, errors = 0;

  outer:
  for (let page = 1; page <= maxPages && evaluated < cap; page++) {
    let batch;
    try { batch = await getCustomers({ page, pageSize: 500 }); } catch (_) { break; }
    const rows = Array.isArray(batch) ? batch : (batch?.customers || batch?.rows || []);
    if (!rows.length) break;
    for (const c of rows) {
      if (evaluated >= cap) break outer;
      const allow = c.allowMailings === true || lc(c.allowMailings) === 'true';
      const email = cleanEmail(c.email);
      if (!allow || !email || seen.has(email)) continue;
      seen.add(email);
      scanned++;
      if (sent[email] && cooldownMs && (now - sent[email]) < cooldownMs) continue;
      if (typeof def.eligible === 'function' && !def.eligible(c, ctx, cfg)) continue;
      if (def.needsTransactions && recheckMs && processed[email] && (now - processed[email]) < recheckMs) continue;

      evaluated++;
      if (def.needsTransactions) processed[email] = now;

      let transactions = null;
      if (def.needsTransactions) {
        try { const tr = await getTransactions({ customerId: c.customerId }); transactions = (tr && (tr.transactions || tr)) || []; }
        catch (_) { continue; }
      }
      let m;
      try { m = def.match(c, ctx, cfg, transactions); } catch (_) { m = null; }
      if (!m) continue;

      const store = branchIdToStoreName(c.registeredInBranchId) || '';
      perStore[store || 'Onbekend'] = (perStore[store || 'Onbekend'] || 0) + 1;
      candidates.push({ email, store, match: m });

      if (!dryRun) {
        try {
          const built = def.email(c, store, m, ctx, cfg, theme);
          await sendGentsMail({
            to: email, subject: built.subject, html: built.html,
            from: storeFromAddress(store, senderCfg), replyTo: storeReplyTo(store, senderCfg),
            headers: { 'List-Unsubscribe': `<mailto:afmelden@${senderCfg.domain}>` },
            type: `automation-${id}`, store, meta: { automation: id, kind: m.kind }
          });
          sent[email] = now;
          pushed++;
          await sleep(200);
        } catch (_) { errors++; }
      }
    }
    if (rows.length < 500) break;
  }

  const result = {
    ok: true, dryRun, automation: id, scanned, evaluated, candidates: candidates.length, pushed, errors, perStore,
    sample: candidates.slice(0, 8).map((c) => ({ email: c.email, store: c.store, kind: c.match.kind }))
  };
  return { result, sent, processed };
}

/* ─── Vaste registry-automation ─── */
export async function runAutomation(id, { dryRun = true, limit } = {}) {
  const def = AUTOMATIONS[id];
  if (!def) throw new Error(`Onbekende automation: ${id}`);
  const cfg = await getAutomationConfig(id);
  const cap = Math.max(1, Number(limit || cfg.maxPerRun || 100));
  const ctx = await def.context(cfg);
  if (ctx && ctx.skip) return { ok: true, dryRun, message: ctx.message || 'Niets te doen.' };
  const [senderCfg, theme] = await Promise.all([getStoreSenderConfig(), getEmailTheme()]);
  const { result, sent, processed } = await executeScan({ def, cfg, id, dryRun, cap, theme, senderCfg, ctx });
  if (!dryRun) await saveAutomationConfig(id, { sent, processed, lastRun: new Date().toISOString(), lastResult: result });
  return result;
}

export async function resetAutomation(id) {
  await saveAutomationConfig(id, { sent: {}, processed: {} });
  return { ok: true };
}

/* ─── Custom-automation (uit een gewhiteliste regel) ─── */
function buildDefFromCustom(custom) {
  const rule = custom.rule || {};
  const storeSet = new Set((rule.registeredStores || []).map(lc));
  const hgSet = new Set((rule.boughtHoofdgroep || []).map(lc));
  const needsTx = !!custom.needsTransactions;
  const ct = custom.content || {};
  return {
    needsTransactions: needsTx,
    cooldownDays: 120,
    recheckDays: needsTx ? 21 : 0,
    maxPages: 80,
    context: async () => (needsTx ? { lookup: makeLookup(await readProductsCache()) } : {}),
    eligible: (c) => {
      if (storeSet.size && !storeSet.has(lc(branchIdToStoreName(c.registeredInBranchId) || ''))) return false;
      if (rule.minReceiptCount != null && (Number(c.receiptCount) || 0) < rule.minReceiptCount) return false;
      if (rule.birthdayWindowDays != null) {
        const d = parseDate(c.birthDate);
        if (!d) return false;
        const bm = d.getMonth(), bd = d.getDate();
        let ok = false;
        for (let i = 0; i <= rule.birthdayWindowDays; i++) { const t = new Date(Date.now() + i * 86400000); if (t.getMonth() === bm && t.getDate() === bd) { ok = true; break; } }
        if (!ok) return false;
      }
      return true;
    },
    match: (c, ctx, _cfg, transactions) => {
      if (needsTx) {
        const lookback = Math.max(rule.lapsedMaxDays || 730, 730) + 30;
        const prof = buildPurchaseProfile(transactions, ctx.lookup, lookback);
        if (hgSet.size) { let has = false; for (const k of prof.byHg.keys()) if (hgSet.has(k)) { has = true; break; } if (!has) return null; }
        if (rule.lapsedMinDays != null || rule.lapsedMaxDays != null) {
          const since = prof.lastBuyTs ? Math.round((Date.now() - prof.lastBuyTs) / 86400000) : null;
          if (since == null) return null;
          if (rule.lapsedMinDays != null && since < rule.lapsedMinDays) return null;
          if (rule.lapsedMaxDays != null && since > rule.lapsedMaxDays) return null;
        }
      }
      return { kind: 'custom' };
    },
    email: (c, store, _m, _ctx, _cfg, theme) => {
      const intro = ct.intro ? `<p style="margin:0 0 14px">${esc(ct.intro).replace(/\n/g, '<br>')}</p>` : '';
      return { subject: ct.subject || 'Een berichtje van GENTS', html: emailShell({ store, firstName: clean(c.firstName), theme, bodyHtml: intro + voucherBox(ct.voucherText) + ctaButton(ct.buttonLabel, ct.buttonUrl, theme) }) };
    }
  };
}

export async function runCustomAutomation(id, { dryRun = true, limit } = {}) {
  const custom = await getCustomAutomation(id);
  if (!custom) throw new Error('Custom-automation niet gevonden.');
  const def = buildDefFromCustom(custom);
  const cap = Math.max(1, Number(limit || custom.maxPerRun || 80));
  const ctx = await def.context(custom);
  const [senderCfg, theme] = await Promise.all([getStoreSenderConfig(), getEmailTheme()]);
  const { result, sent, processed } = await executeScan({ def, cfg: custom, id, dryRun, cap, theme, senderCfg, ctx });
  if (!dryRun) await patchCustomAutomation(id, { sent, processed, lastRun: new Date().toISOString(), lastResult: result });
  return result;
}

export async function resetCustomAutomation(id) {
  await patchCustomAutomation(id, { sent: {}, processed: {} });
  return { ok: true };
}

/* Voor de cron: draai alle ingeschakelde custom-automations. */
export async function runEnabledCustom({ dryRun = false } = {}) {
  const list = await listCustomAutomations();
  const out = [];
  for (const c of list) if (c.enabled) out.push({ id: c.id, ...(await runCustomAutomation(c.id, { dryRun }).catch((e) => ({ ok: false, error: e.message }))) });
  return out;
}
