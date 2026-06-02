/**
 * lib/automation-runner.js
 *
 * Generieke runner voor de registry-automations (verjaardag, win-back,
 * replenishment, …). Verzorgt: config per automation (blob), klanten scannen,
 * dedupe (cooldown + recheck), en versturen via de per-winkel Resend-afzender.
 *
 * Verstuurt ALLEEN bij dryRun=false. Per run gemaximeerd (maxPerRun) zodat de
 * koophistorie-calls (SOAP) beheersbaar blijven; opeenvolgende runs lopen de
 * basis af. Idempotent via sent/processed-maps per automation.
 */

import { getCustomers, getTransactions } from './srs-customers-client.js';
import { branchIdToStoreName } from './business-config.js';
import { getStoreSenderConfig, storeFromAddress, storeReplyTo } from './resend-sender.js';
import { sendGentsMail } from './resend-mailer.js';
import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';
import { AUTOMATIONS } from './automations-registry.js';
import { cleanEmail, clean, lc, sleep } from './automations-core.js';

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

export async function listAutomationsStatus() {
  const out = [];
  for (const def of Object.values(AUTOMATIONS)) {
    const cfg = await getAutomationConfig(def.id);
    out.push({
      id: def.id, label: def.label, description: def.description, fields: def.fields,
      config: slimConfig(def, cfg)
    });
  }
  return out;
}

function slimConfig(def, cfg) {
  const values = {};
  for (const f of def.fields) values[f.key] = cfg[f.key];
  return {
    enabled: !!cfg.enabled, values,
    sentCount: Object.keys(cfg.sent || {}).length,
    lastRun: cfg.lastRun, lastResult: cfg.lastResult
  };
}

/**
 * @param {string} id
 * @param {{dryRun?:boolean, limit?:number}} opts
 */
export async function runAutomation(id, { dryRun = true, limit } = {}) {
  const def = AUTOMATIONS[id];
  if (!def) throw new Error(`Onbekende automation: ${id}`);
  const cfg = await getAutomationConfig(id);
  const cap = Math.max(1, Number(limit || cfg.maxPerRun || 100));
  const maxPages = Math.max(1, Number(def.maxPages || 80));
  const now = Date.now();
  const cooldownMs = (Number(def.cooldownDays) || 0) * 86400000;
  const recheckMs = (Number(def.recheckDays) || 0) * 86400000;

  const ctx = await def.context(cfg);
  if (ctx && ctx.skip) return { ok: true, dryRun, message: ctx.message || 'Niets te doen.' };

  const senderCfg = await getStoreSenderConfig();
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

      /* Dedupe: recent gemaild → overslaan. */
      if (sent[email] && cooldownMs && (now - sent[email]) < cooldownMs) continue;
      /* Goedkope voorfilter (bv. verjaardagsvenster). */
      if (typeof def.eligible === 'function' && !def.eligible(c, ctx, cfg)) continue;
      /* SOAP sparen: kort geleden geëvalueerd → overslaan. */
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
      candidates.push({ email, firstName: clean(c.firstName), store, match: m });

      if (!dryRun) {
        try {
          const built = def.email(c, store, m, ctx, cfg);
          await sendGentsMail({
            to: email,
            subject: built.subject,
            html: built.html,
            from: storeFromAddress(store, senderCfg),
            replyTo: storeReplyTo(store, senderCfg),
            headers: { 'List-Unsubscribe': `<mailto:afmelden@${senderCfg.domain}>` },
            type: `automation-${id}`,
            store,
            meta: { automation: id, kind: m.kind }
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
  if (!dryRun) await saveAutomationConfig(id, { sent, processed, lastRun: new Date().toISOString(), lastResult: result });
  return result;
}

export async function resetAutomation(id) {
  await saveAutomationConfig(id, { sent: {}, processed: {} });
  return { ok: true };
}
