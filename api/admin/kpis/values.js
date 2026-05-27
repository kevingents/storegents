/**
 * /api/admin/kpis/values
 *
 * GET ?kpi=sales_revenue&store=GENTS+Arnhem&period=this-month
 *     → compute KPI-waarde voor 1 KPI + 1 winkel + 1 periode
 *
 * GET ?kpi=sales_revenue&period=this-month
 *     → compute voor ALLE per-store winkels in 1 keer
 *     → returnt: { values: { storeName: { value, meta } }, target?: { storeName: targetValue } }
 *
 * GET ?store=GENTS+Arnhem&period=this-month
 *     → compute ALLE enabled KPIs voor 1 winkel
 *
 * GET ?period=this-month  (zonder kpi/store)
 *     → matrix: alle enabled KPI's × alle retail-winkels
 *
 * Het idee: 1 endpoint dat zowel "1 cell" als "hele tabel" levert,
 * afhankelijk van welke filters de UI meegeeft.
 *
 * Auth: admin-token vereist.
 */

import { readKpiRegistry, listKpisForReport } from '../../../lib/kpi-registry.js';
import { computeKpiValue, resolvePeriodRange } from '../../../lib/kpi-sources/index.js';
import { getTargetsForStores } from '../../../lib/kpi-targets-store.js';
import { listBranchesFromConfig, BUSINESS_CONFIG } from '../../../lib/business-config.js';
import { corsJson, requireAdmin } from '../../../lib/request-guards.js';

function getBranchIdForStore(storeName) {
  const found = BUSINESS_CONFIG.branches.list.find((b) => b.store === storeName);
  return found ? found.branchId : null;
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET.' });
  }

  try {
    const q = req.query || {};
    const period = String(q.period || 'this-month');
    const range = resolvePeriodRange({
      fromDate: q.fromDate,
      toDate: q.toDate,
      period
    });

    const reg = await readKpiRegistry();
    const allKpis = reg.kpis.filter((k) => k.enabled);

    const requestedKpiKey = q.kpi ? String(q.kpi).trim() : null;
    const requestedStore = q.store ? String(q.store).trim() : null;
    const requestedReportKey = q.reportKey ? String(q.reportKey).trim() : null;

    /* Welke KPI's gaan we evalueren?
       Filter-prioriteit: kpi > reportKey > alle enabled
       - kpi=xxx       → exact 1 KPI
       - reportKey=yyy → alleen KPI's gekoppeld aan dat rapport (via override of inReports[])
       - geen filter   → alle enabled KPI's (huidige gedrag) */
    let kpisToCompute;
    if (requestedKpiKey) {
      kpisToCompute = allKpis.filter((k) => k.key === requestedKpiKey);
    } else if (requestedReportKey) {
      kpisToCompute = await listKpisForReport(requestedReportKey);
    } else {
      kpisToCompute = allKpis;
    }
    if (kpisToCompute.length === 0) {
      return res.status(404).json({
        success: false,
        message: requestedReportKey
          ? `Geen KPI's gekoppeld aan rapport "${requestedReportKey}".`
          : 'Geen matchende KPI.'
      });
    }

    /* Welke winkels? */
    const allStores = listBranchesFromConfig({ includeInternal: false }).map((b) => b.store);
    const storesToEvaluate = requestedStore ? [requestedStore] : allStores;

    /* Bouw matrix: { kpiKey → { storeName → {value, meta, target, status} } } */
    const matrix = {};
    /* Pre-load targets per (year, month) — we hergebruiken voor alle KPIs */
    const monthDate = new Date(range.toDate || range.fromDate);
    const year = monthDate.getUTCFullYear();
    const month = monthDate.getUTCMonth() + 1;
    const targetsPerStore = await getTargetsForStores(year, month, storesToEvaluate);

    for (const kpi of kpisToCompute) {
      const row = {};
      /* Voor global-scope KPIs: 1 compute zonder store, kopieer waarde naar elke store */
      if (kpi.scope === 'global') {
        const result = await computeKpiValue(kpi.source.fetcher, {
          store: '',
          branchId: '',
          fromDate: range.fromDate,
          toDate: range.toDate,
          period: range.period
        });
        for (const store of storesToEvaluate) {
          row[store] = { ...result, target: null, kpiKey: kpi.key };
        }
      } else {
        for (const store of storesToEvaluate) {
          const result = await computeKpiValue(kpi.source.fetcher, {
            store,
            branchId: getBranchIdForStore(store),
            fromDate: range.fromDate,
            toDate: range.toDate,
            period: range.period
          });
          const target = targetsPerStore[store]?.[kpi.key] ?? null;
          row[store] = { ...result, target, kpiKey: kpi.key };
        }
      }
      matrix[kpi.key] = row;
    }

    return res.status(200).json({
      success: true,
      range,
      kpis: kpisToCompute.map((k) => ({
        key: k.key,
        label: k.label,
        unit: k.unit,
        direction: k.direction,
        category: k.category,
        scope: k.scope,
        thresholds: k.thresholds
      })),
      stores: storesToEvaluate,
      matrix,
      generatedAt: new Date().toISOString()
    });
  } catch (e) {
    console.error('[admin/kpis/values]', e);
    return res.status(500).json({ success: false, message: e.message || 'Values-call faalde.' });
  }
}
