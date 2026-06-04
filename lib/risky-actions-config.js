/**
 * lib/risky-actions-config.js
 *
 * Welke handelingen vereisen extra kassacode-bevestiging (her-PIN) bovenop de
 * actieve shift-sessie? Hybride model: shift-login is voldoende voor 99% van
 * het werk; alleen voor risicovolle acties komt er een extra check.
 *
 * Default-actions:
 *   - order.cancel-late          (annulering laat in fulfillment-proces)
 *   - voucher.generate-above     (vouchers boven X euro)
 *   - stock.correction-above     (voorraadcorrectie boven X stuks)
 *   - return.refund-above        (refund boven X euro)
 *   - shipping-label.bulk        (bulk-creatie verzendlabels)
 *   - srs.purchase-order         (inkoop-bestelling plaatsen)
 *
 * Admin kan via Instellingen-menu:
 *   - thresholds aanpassen
 *   - acties aan/uit zetten
 *   - eigen risky-actions toevoegen
 */

import { readJsonBlob, mutateJsonBlob } from './json-blob-store.js';

const PATH = 'admin/risky-actions-config.json';
const CACHE_TTL_MS = 5 * 60 * 1000;

const DEFAULT_ACTIONS = [
  {
    key: 'order.cancel-late',
    label: 'Order annuleren (laat in proces)',
    description: 'Annulering nadat label is aangemaakt of order is gepicked.',
    enabled: true,
    threshold: null,
    confirmTtlSeconds: 60
  },
  {
    key: 'voucher.generate-above',
    label: 'Voucher uitgeven (hoog bedrag)',
    description: 'Voucher boven drempelwaarde uitgeven.',
    enabled: true,
    threshold: 100, /* EUR */
    confirmTtlSeconds: 60
  },
  {
    key: 'stock.correction-above',
    label: 'Voorraad-correctie (groot)',
    description: 'Correctie boven drempel-aantal stuks.',
    enabled: true,
    threshold: 5, /* stuks */
    confirmTtlSeconds: 60
  },
  {
    key: 'return.refund-above',
    label: 'Retour-refund (hoog bedrag)',
    description: 'Geld-retour boven drempelwaarde.',
    enabled: true,
    threshold: 250, /* EUR */
    confirmTtlSeconds: 60
  },
  {
    key: 'shipping-label.bulk',
    label: 'Verzendlabels bulk-creatie',
    description: 'Meer dan N labels in 1 actie.',
    enabled: false,
    threshold: 10,
    confirmTtlSeconds: 60
  },
  {
    key: 'srs.purchase-order',
    label: 'SRS inkoop-bestelling',
    description: 'Bestelling plaatsen bij leverancier.',
    enabled: true,
    threshold: null,
    confirmTtlSeconds: 120
  }
];

let __cache = null;
let __cacheAt = 0;

export async function getRiskyActionsConfig({ refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && __cache && (now - __cacheAt) < CACHE_TTL_MS) return __cache;
  const override = await readJsonBlob(PATH, {}).catch(() => ({}));
  const map = {};
  for (const def of DEFAULT_ACTIONS) {
    const ov = override?.[def.key] || {};
    map[def.key] = { ...def, ...ov };
  }
  /* Toegevoegde custom acties uit override */
  for (const [k, v] of Object.entries(override || {})) {
    if (!map[k] && v && typeof v === 'object') {
      map[k] = { key: k, label: v.label || k, enabled: !!v.enabled, threshold: v.threshold ?? null, confirmTtlSeconds: v.confirmTtlSeconds || 60, ...v };
    }
  }
  __cache = { actions: map, asList: Object.values(map), generatedAt: new Date().toISOString() };
  __cacheAt = now;
  return __cache;
}

/** Bepaal of een actie risky is gegeven de payload (bv. bedrag/aantal). */
export async function isRiskyAction(actionKey, payload = {}) {
  const cfg = await getRiskyActionsConfig();
  const def = cfg.actions[actionKey];
  if (!def || def.enabled === false) return { risky: false, reason: 'not-configured' };
  /* Threshold-check: als threshold gezet, alleen risky boven die waarde. */
  if (def.threshold != null) {
    const amount = Number(payload.amount ?? payload.count ?? payload.quantity ?? 0);
    if (Number.isFinite(amount) && amount < Number(def.threshold)) {
      return { risky: false, reason: 'below-threshold', threshold: def.threshold, amount };
    }
  }
  return { risky: true, reason: 'matches-policy', threshold: def.threshold ?? null, ttl: def.confirmTtlSeconds || 60 };
}

export async function upsertRiskyAction(key, patch = {}) {
  if (!key) throw new Error('key verplicht');
  await mutateJsonBlob(PATH, (cur) => {
    const map = (cur && typeof cur === 'object') ? { ...cur } : {};
    const prev = map[key] || {};
    map[key] = {
      ...prev,
      ...patch,
      key,
      updatedAt: new Date().toISOString()
    };
    return map;
  }, { fallback: {} });
  __cache = null; __cacheAt = 0;
  return { key };
}

export async function removeRiskyAction(key) {
  await mutateJsonBlob(PATH, (cur) => {
    const map = (cur && typeof cur === 'object') ? { ...cur } : {};
    delete map[key];
    return map;
  }, { fallback: {} });
  __cache = null; __cacheAt = 0;
  return { key, removed: true };
}
