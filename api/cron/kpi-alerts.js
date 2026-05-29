/**
 * Cron: GET /api/cron/kpi-alerts
 * Schedule: '0 7 * * *' (dagelijks 07:00 UTC = 08:00/09:00 NL)
 *
 * Doel:
 *   1. Voor elke enabled KPI in de registry: bereken values voor "this-month"
 *      over alle per-store winkels.
 *   2. Vergelijk value vs target:
 *        - hasTarget + achievementPct < 60  → DANGER
 *        - hasTarget + achievementPct < 80  → WARN
 *        - Geen target maar threshold-crossing:
 *            value crosses thresholds.danger → DANGER
 *            value crosses thresholds.warn   → WARN
 *   3. Stuur per unieke (kpi, store, level) max 1 alert per dag — throttling
 *      via lib/kpi-alerts-store.js.
 *   4. Bundel alle alerts in 1 mail naar ADMIN_ALERTS_EMAIL.
 *
 * Query overrides:
 *   ?dryRun=true       — bereken, niet versturen
 *   ?force=true        — negeer throttle (verstuur ook al was vandaag al)
 *   ?kpi=sales_revenue — beperk tot 1 KPI
 */

import { readKpiRegistry } from '../../lib/kpi-registry.js';
import { trackedCron } from '../../lib/cron-auto-track.js';
import { computeKpiValue, resolvePeriodRange } from '../../lib/kpi-sources/index.js';
import { getTargetsForStores } from '../../lib/kpi-targets-store.js';
import { listBranchesFromConfig, BUSINESS_CONFIG } from '../../lib/business-config.js';
import { isAlertAlreadySentToday, recordAlertSent } from '../../lib/kpi-alerts-store.js';
import { sendMail, baseMailHtml, rowsTable } from '../../lib/gents-mailer.js';

function isAuthorized(req) {
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  if (ua.includes('vercel-cron')) return true;
  if (req.headers['x-vercel-cron']) return true;
  const adminToken = String(process.env.ADMIN_TOKEN || '').trim();
  const token = String(req.headers['x-admin-token'] || req.query?.adminToken || '').trim();
  return Boolean(adminToken && token && token === adminToken);
}

function getBranchIdForStore(storeName) {
  const found = BUSINESS_CONFIG.branches.list.find((b) => b.store === storeName);
  return found ? found.branchId : null;
}

function alertRecipients() {
  const list = String(
    process.env.ADMIN_ALERTS_EMAIL ||
    process.env.ADMIN_ALERTS_TO ||
    process.env.OPS_NOTIFY_EMAIL ||
    ''
  )
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : ['admin@gents.nl'];
}

function classify(value, target, direction, thresholds) {
  /* Returns null (geen alert) | { level, achievementPct?, reason } */
  if (value == null || Number.isNaN(value)) return null;
  if (target != null && target > 0) {
    const pct = direction === 'lower-better'
      ? (target / Math.max(value, 0.0001)) * 100
      : (value / target) * 100;
    if (pct < 60) return { level: 'danger', achievementPct: pct, reason: 'target' };
    if (pct < 80) return { level: 'warn', achievementPct: pct, reason: 'target' };
    return null;
  }
  /* Geen target → kijk naar thresholds */
  const t = thresholds || {};
  if (direction === 'lower-better') {
    if (t.danger != null && value >= t.danger) return { level: 'danger', reason: 'threshold' };
    if (t.warn != null && value >= t.warn)     return { level: 'warn', reason: 'threshold' };
  } else {
    if (t.danger != null && value <= t.danger) return { level: 'danger', reason: 'threshold' };
    if (t.warn != null && value <= t.warn)     return { level: 'warn', reason: 'threshold' };
  }
  return null;
}

function formatValue(value, unit) {
  if (value == null || Number.isNaN(value)) return '–';
  const n = Number(value);
  if (unit === 'eur') {
    return '€ ' + Math.round(n).toLocaleString('nl-NL');
  }
  if (unit === 'pct') return n.toFixed(1) + '%';
  if (unit === 'days') return n.toFixed(1) + ' dagen';
  return Math.round(n).toLocaleString('nl-NL');
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen GET/POST.' });
  }
  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  const dryRun = String(req.query.dryRun || '').toLowerCase() === 'true';
  const force = String(req.query.force || '').toLowerCase() === 'true';
  const onlyKpi = String(req.query.kpi || '').trim();

  /* 1. KPI's + winkels ophalen */
  const reg = await readKpiRegistry();
  const allKpis = (reg.kpis || []).filter((k) => k.enabled);
  const kpis = onlyKpi ? allKpis.filter((k) => k.key === onlyKpi) : allKpis;
  const stores = listBranchesFromConfig({ includeInternal: false }).map((b) => b.store);

  /* 2. Periode = this-month */
  const range = resolvePeriodRange({ period: 'this-month' });
  const monthDate = new Date(range.toDate || range.fromDate);
  const year = monthDate.getUTCFullYear();
  const month = monthDate.getUTCMonth() + 1;
  const targetsPerStore = await getTargetsForStores(year, month, stores);

  /* 3. Iterate KPIs × stores */
  const alerts = [];
  const errors = [];

  for (const kpi of kpis) {
    if (kpi.scope === 'global') {
      /* 1 compute, 1 alert max */
      try {
        const res = await computeKpiValue(kpi.source.fetcher, {
          store: '',
          fromDate: range.fromDate,
          toDate: range.toDate,
          period: range.period
        });
        const cls = classify(res.value, null, kpi.direction, kpi.thresholds);
        if (cls) {
          if (!force && await isAlertAlreadySentToday({ kpi: kpi.key, store: '', level: cls.level })) continue;
          alerts.push({ kpi, store: '', value: res.value, target: null, classification: cls });
        }
      } catch (err) {
        errors.push({ kpi: kpi.key, store: '', error: String(err?.message || err) });
      }
      continue;
    }
    for (const store of stores) {
      try {
        const res = await computeKpiValue(kpi.source.fetcher, {
          store,
          branchId: getBranchIdForStore(store),
          fromDate: range.fromDate,
          toDate: range.toDate,
          period: range.period
        });
        const target = targetsPerStore[store]?.[kpi.key] ?? null;
        const cls = classify(res.value, target, kpi.direction, kpi.thresholds);
        if (cls) {
          if (!force && await isAlertAlreadySentToday({ kpi: kpi.key, store, level: cls.level })) continue;
          alerts.push({ kpi, store, value: res.value, target, classification: cls });
        }
      } catch (err) {
        errors.push({ kpi: kpi.key, store, error: String(err?.message || err) });
      }
    }
  }

  /* 4. Bundle + send mail */
  let mailSent = false;
  if (alerts.length && !dryRun) {
    const dangerAlerts = alerts.filter((a) => a.classification.level === 'danger');
    const warnAlerts = alerts.filter((a) => a.classification.level === 'warn');

    const rows = alerts.map((a) => ({
      KPI: a.kpi.label,
      Winkel: a.store || 'Globaal',
      Waarde: formatValue(a.value, a.kpi.unit),
      Target: a.target != null ? formatValue(a.target, a.kpi.unit) : '–',
      'Behaald': a.classification.achievementPct
        ? `${Math.round(a.classification.achievementPct)}%`
        : a.classification.reason,
      Niveau: a.classification.level === 'danger' ? 'KRITIEK' : 'WAARSCHUWING'
    }));

    const subject = `[KPI-alert] ${dangerAlerts.length} kritiek · ${warnAlerts.length} waarschuwing`;
    const html = baseMailHtml({
      title: 'KPI-alerts',
      intro: `Goedemorgen,\n\nDe dagelijkse KPI-check heeft ${alerts.length} afwijking(en) gedetecteerd voor deze maand.`,
      bodyHtml: rowsTable(rows, ['KPI', 'Winkel', 'Waarde', 'Target', 'Behaald', 'Niveau']),
      footer: 'Open de admin-portal → KPI-snapshot voor details.'
    });

    try {
      await sendMail({
        to: alertRecipients(),
        subject,
        html,
        text: rows.map((r) => `${r.Niveau}: ${r.KPI} @ ${r.Winkel} = ${r.Waarde} (target ${r.Target}, behaald ${r.Behaald})`).join('\n')
      });
      mailSent = true;
      /* Markeer als verzonden — alleen na succesvolle mail */
      for (const a of alerts) {
        await recordAlertSent({
          kpi: a.kpi.key,
          store: a.store,
          level: a.classification.level,
          value: a.value,
          target: a.target,
          label: a.kpi.label
        });
      }
    } catch (mailErr) {
      errors.push({ kpi: '*', store: '*', error: `mail-send-failed: ${mailErr.message}` });
    }
  }

  return res.status(200).json({
    success: true,
    dryRun,
    force,
    period: range,
    kpisChecked: kpis.length,
    storesChecked: stores.length,
    alertsFound: alerts.length,
    alertsByLevel: {
      danger: alerts.filter((a) => a.classification.level === 'danger').length,
      warn: alerts.filter((a) => a.classification.level === 'warn').length
    },
    mailSent,
    recipients: alertRecipients(),
    errors: errors.length ? errors : undefined,
    alerts: alerts.map((a) => ({
      kpi: a.kpi.key,
      label: a.kpi.label,
      store: a.store,
      value: a.value,
      target: a.target,
      level: a.classification.level,
      reason: a.classification.reason
    })),
    generatedAt: new Date().toISOString()
  });
}

export default trackedCron('kpi-alerts', handler);
