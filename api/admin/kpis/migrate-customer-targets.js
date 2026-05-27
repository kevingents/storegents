/**
 * /api/admin/kpis/migrate-customer-targets
 *
 * Eenmalig (idempotent) migratie-endpoint: kopieert alle data uit
 * admin/customer-targets.json naar admin/kpi-config.json. Bestaande
 * KPI-targets worden NIET overschreven — alleen ontbrekende velden
 * worden bijgevuld.
 *
 * Resultaat:
 *   { migrated, skipped, months: [...] }
 *
 * Customer-targets-store blijft bestaan (oude UI/endpoint blijven werken).
 * Nieuwe data wordt via admin/kpis/targets ook zichtbaar.
 *
 * Auth: admin-token vereist.
 */

import { migrateCustomerTargetsToKpi } from '../../../lib/kpi-targets-store.js';
import { corsJson, requireAdmin } from '../../../lib/request-guards.js';

function actorFromReq(req) {
  return String(req.headers?.['x-actor'] || req.headers?.['x-user-email'] || 'admin');
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen POST.' });
  }

  try {
    const result = await migrateCustomerTargetsToKpi(actorFromReq(req));
    return res.status(200).json({
      success: true,
      ...result,
      message: result.migrated > 0
        ? `${result.migrated} target-waardes gemigreerd over ${result.months.length} maanden. ${result.skipped} overgeslagen (al aanwezig of leeg).`
        : 'Geen targets om te migreren — KPI-config bevat al alles of customer-targets is leeg.'
    });
  } catch (e) {
    console.error('[admin/kpis/migrate-customer-targets]', e);
    return res.status(500).json({ success: false, message: e.message || 'Migratie faalde.' });
  }
}
