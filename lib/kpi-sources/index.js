/**
 * lib/kpi-sources/index.js — central source-resolver voor het KPI-systeem.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  WAT DOET DIT?
 * ═══════════════════════════════════════════════════════════════════
 *
 * Gegeven een KPI-key (bv. 'sales_revenue') route de berekening naar de
 * juiste fetcher in deze folder. Elke fetcher exporteert default een
 * async functie `compute(ctx) → { value, meta }`.
 *
 * Hierdoor is "een nieuwe KPI toevoegen" letterlijk:
 *   1. lib/kpi-sources/<key>.js maken
 *   2. Entry toevoegen aan SOURCE_MAP hieronder
 *   3. Entry toevoegen aan DEFAULT_KPIS in kpi-registry.js
 *
 * De compute-functie krijgt context:
 *   {
 *     store:    string  - winkelnaam (bv. 'GENTS Arnhem'). '' voor global-scope KPIs.
 *     fromDate: string  - ISO yyyy-mm-dd (begin periode)
 *     toDate:   string  - ISO yyyy-mm-dd (eind periode, inclusief)
 *     period:   string  - 'day'|'week'|'month'|'quarter'|'year' (hint)
 *     branchId: string  - SRS branchId voor store (resolved via business-config)
 *   }
 *
 * En returnt:
 *   {
 *     value:    number|null  - de actuele KPI-waarde voor die periode
 *     meta:     Object       - extra info: source, computedAt, evt sub-getallen
 *   }
 *
 * BELANGRIJK: een fetcher MAG `value: null` returnen met `meta.error`
 * als data tijdelijk niet beschikbaar is. Niet crashen — null betekent
 * "geen data", admin-UI rendert dan een streepje ipv waarde.
 *
 * ═══════════════════════════════════════════════════════════════════
 */

/* ─── Source-registry ─────────────────────────────────────────────── */

const SOURCE_MAP = {
  /* Financieel */
  'sales-revenue':         () => import('./sales-revenue.js'),
  'sales-units':           () => import('./sales-units.js'),
  'conversion-rate':       () => import('./conversion-rate.js'),

  /* Customer */
  'customers-new':         () => import('./customers-new.js'),
  'customers-with-bon':    () => import('./customers-with-bon.js'),
  'customers-with-email':  () => import('./customers-with-email.js'),

  /* Service */
  'on-time-delivery':      () => import('./on-time-delivery.js'),
  'overdue-orders':        () => import('./overdue-orders.js'),
  'online-warehouse-speed':() => import('./online-warehouse-speed.js'),

  /* Kwaliteit */
  'stock-corrections':     () => import('./stock-corrections.js'),
  'unavailable-lines':     () => import('./unavailable-lines.js'),

  /* Composite */
  'omnichannel-score':     () => import('./omnichannel-score.js')
};

/* ─── Helpers ─────────────────────────────────────────────────────── */

function nullResult(reason) {
  return {
    value: null,
    meta: { error: reason || 'not-implemented', computedAt: new Date().toISOString() }
  };
}

/**
 * Resolve fromDate/toDate uit ofwel directe ISO-strings, ofwel een period-shorthand
 * ('this-month', 'last-week', etc). Gebruik dit in de fetchers voor consistente parsing.
 */
export function resolvePeriodRange({ fromDate, toDate, period } = {}, refNow = new Date()) {
  /* Als from+to expliciet zijn doorgegeven: gebruik die direct */
  if (fromDate && toDate) {
    return {
      fromDate: String(fromDate).slice(0, 10),
      toDate:   String(toDate).slice(0, 10),
      period:   period || 'custom'
    };
  }

  const now = new Date(refNow);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();

  const fmt = (dt) => dt.toISOString().slice(0, 10);

  switch ((period || 'this-month').toLowerCase()) {
    case 'today': {
      const t = fmt(now);
      return { fromDate: t, toDate: t, period: 'day' };
    }
    case 'this-week':
    case 'week': {
      const dayOfWeek = now.getUTCDay() || 7; /* maandag=1, zondag=7 */
      const start = new Date(Date.UTC(y, m, d - dayOfWeek + 1));
      const end = new Date(Date.UTC(y, m, d));
      return { fromDate: fmt(start), toDate: fmt(end), period: 'week' };
    }
    case 'last-week': {
      const dayOfWeek = now.getUTCDay() || 7;
      const end = new Date(Date.UTC(y, m, d - dayOfWeek));
      const start = new Date(Date.UTC(y, m, d - dayOfWeek - 6));
      return { fromDate: fmt(start), toDate: fmt(end), period: 'week' };
    }
    case 'this-month':
    case 'month': {
      const start = new Date(Date.UTC(y, m, 1));
      const end = new Date(Date.UTC(y, m + 1, 0));
      return { fromDate: fmt(start), toDate: fmt(end), period: 'month' };
    }
    case 'last-month': {
      const start = new Date(Date.UTC(y, m - 1, 1));
      const end = new Date(Date.UTC(y, m, 0));
      return { fromDate: fmt(start), toDate: fmt(end), period: 'month' };
    }
    case 'this-quarter':
    case 'quarter': {
      const q = Math.floor(m / 3);
      const start = new Date(Date.UTC(y, q * 3, 1));
      const end = new Date(Date.UTC(y, q * 3 + 3, 0));
      return { fromDate: fmt(start), toDate: fmt(end), period: 'quarter' };
    }
    case 'this-year':
    case 'year': {
      const start = new Date(Date.UTC(y, 0, 1));
      const end = new Date(Date.UTC(y, 11, 31));
      return { fromDate: fmt(start), toDate: fmt(end), period: 'year' };
    }
    default: {
      const start = new Date(Date.UTC(y, m, 1));
      const end = new Date(Date.UTC(y, m + 1, 0));
      return { fromDate: fmt(start), toDate: fmt(end), period: 'month' };
    }
  }
}

/* ─── Public API ──────────────────────────────────────────────────── */

/**
 * Roep de fetcher voor een KPI aan en return het resultaat.
 *
 * @param {string} fetcherKey  zoals gedefinieerd in KPI.source.fetcher
 * @param {Object} ctx         { store, fromDate, toDate, period, branchId }
 * @returns {Promise<{value: number|null, meta: Object}>}
 */
export async function computeKpiValue(fetcherKey, ctx = {}) {
  const key = String(fetcherKey || '').trim();
  if (!key) return nullResult('missing-fetcher-key');

  const loader = SOURCE_MAP[key];
  if (!loader) return nullResult(`unknown-fetcher:${key}`);

  try {
    const mod = await loader();
    const fn = mod.default;
    if (typeof fn !== 'function') return nullResult(`no-default-export:${key}`);
    const result = await fn(ctx);
    /* Normaliseer naar { value, meta } */
    if (result && typeof result === 'object' && 'value' in result) {
      return {
        value: result.value === undefined ? null : result.value,
        meta: result.meta || { computedAt: new Date().toISOString() }
      };
    }
    /* Als de fetcher direct een number returneerde, accepteer dat ook */
    if (typeof result === 'number') {
      return { value: result, meta: { computedAt: new Date().toISOString() } };
    }
    return nullResult('invalid-fetcher-output');
  } catch (e) {
    return {
      value: null,
      meta: {
        error: e.message || 'fetcher-crashed',
        computedAt: new Date().toISOString()
      }
    };
  }
}

/**
 * Lijst alle source-keys die geregistreerd zijn (voor admin-UI / debug).
 */
export function listSourceKeys() {
  return Object.keys(SOURCE_MAP);
}

export default {
  computeKpiValue,
  resolvePeriodRange,
  listSourceKeys
};
