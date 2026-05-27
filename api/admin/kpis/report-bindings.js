/**
 * /api/admin/kpis/report-bindings
 *
 * GET    → { success, bindings: { reportKey: [kpiKey,...] }, knownReportKeys, availableKpis: [{key,label,unit,category}], pilotReports }
 * PUT    body: { reportKey: 'admin-store-week-report', kpis: ['sales_revenue', 'customers_new'] }
 *        → schrijft binding voor 1 rapport. Lege array = geen KPI's tonen.
 * DELETE body: { reportKey: '...' }
 *        → verwijdert override → terugvallen op DEFAULT_KPIS.inReports[]
 *
 * Auth: admin-token vereist.
 *
 * NB: De "pilotReports" lijst is de canonieke set die de admin-UI als drop-down
 * presenteert. Voeg hier nieuwe rapport-keys toe wanneer je een rapport
 * configureerbaar wil maken. Niet-canonieke keys werken ook (gewoon PUT met
 * een nieuwe reportKey), maar verschijnen niet vanzelf in de UI-dropdown.
 */

import {
  readKpiRegistry,
  listReportBindings,
  setReportBinding,
  deleteReportBinding
} from '../../../lib/kpi-registry.js';
import { corsJson, requireAdmin } from '../../../lib/request-guards.js';

/* Canonical lijst van rapporten waarvoor we KPI-bindings willen exposen in
   de admin-UI. Houdt label/description handig zodat de frontend ze direct
   kan tonen. Nieuwe pilot-rapporten hier toevoegen. */
const PILOT_REPORTS = [
  {
    key: 'admin-store-week-report',
    label: 'Winkel weekrapport',
    description: 'Pick & pack volumes per winkel · dagelijks · te laat / opgelost / open.'
  },
  {
    key: 'admin-customer-weekly-report',
    label: 'Klanten weekrapport',
    description: 'Nieuwe klantinschrijvingen, met-bon-ratio, email-completion per winkel.'
  },
  {
    key: 'admin-omnichannel-score',
    label: 'Omnichannel score',
    description: 'Composite score per winkel — alle KPI\'s gewogen samengevoegd.'
  }
];

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

function actorFromReq(req) {
  return String(
    req.headers['x-actor'] ||
    req.headers['x-user-email'] ||
    req.body?.actor ||
    'admin'
  ).slice(0, 80);
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'PUT', 'DELETE', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const reg = await readKpiRegistry();
      const { bindings, knownReportKeys } = await listReportBindings();

      /* availableKpis: enkel enabled, met essentiele velden voor de UI */
      const availableKpis = reg.kpis
        .filter((k) => k.enabled)
        .map((k) => ({
          key: k.key,
          label: k.label,
          unit: k.unit,
          category: k.category,
          direction: k.direction,
          scope: k.scope,
          hasTarget: !!k.hasTarget,
          /* Default binding (inReports[]) — alleen ter info, override wint */
          defaultInReports: Array.isArray(k.inReports) ? k.inReports : []
        }));

      return res.status(200).json({
        success: true,
        bindings,
        knownReportKeys,
        availableKpis,
        pilotReports: PILOT_REPORTS,
        generatedAt: new Date().toISOString()
      });
    }

    if (req.method === 'PUT') {
      const body = parseBody(req);
      const reportKey = String(body.reportKey || '').trim();
      const kpis = Array.isArray(body.kpis) ? body.kpis : null;
      if (!reportKey) return res.status(400).json({ success: false, message: 'reportKey is verplicht.' });
      if (!kpis)      return res.status(400).json({ success: false, message: 'kpis-array is verplicht.' });

      const cleaned = await setReportBinding(reportKey, kpis, actorFromReq(req));
      return res.status(200).json({
        success: true,
        reportKey,
        kpis: cleaned,
        message: `Binding bijgewerkt: ${cleaned.length} KPI('s) gekoppeld aan ${reportKey}.`
      });
    }

    if (req.method === 'DELETE') {
      const body = parseBody(req);
      const reportKey = String(body.reportKey || req.query?.reportKey || '').trim();
      if (!reportKey) return res.status(400).json({ success: false, message: 'reportKey is verplicht.' });

      const removed = await deleteReportBinding(reportKey, actorFromReq(req));
      return res.status(200).json({
        success: true,
        reportKey,
        removed,
        message: removed
          ? `Binding verwijderd — ${reportKey} valt terug op default KPI's.`
          : `Geen binding gevonden voor ${reportKey}.`
      });
    }

    return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
  } catch (e) {
    console.error('[admin/kpis/report-bindings]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
