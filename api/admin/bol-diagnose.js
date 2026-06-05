/**
 * GET /api/admin/bol-diagnose
 *
 * Snelle gezondheidscheck voor de Bol-integratie: validateert token-fetch,
 * leest 1 offer (simpele auth-check) en probeert een mini-process-status-call
 * om te zien of de credentials in de juiste scope zitten.
 *
 * Bedoeld voor wanneer offer-export 403's geeft en je niet weet of het ligt
 * aan demo↔prod-mismatch, gerouleerde credentials, of een echt account-issue.
 */

import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { getBolConfig, invalidateBolToken, bolGet, bolOrdersVersion } from '../../lib/bol-client.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store');
  if (requireAdmin(req, res)) return;

  const cfg = getBolConfig();
  const report = {
    success: true,
    configured: cfg.configured,
    demo: cfg.demo,
    base: cfg.base,
    prefix: cfg.prefix,
    version: cfg.version,
    missing: cfg.missing,
    checks: []
  };

  if (!cfg.configured) {
    report.success = false;
    report.message = `Bol niet gekoppeld — ontbrekend: ${cfg.missing.join(', ')}`;
    return res.status(200).json(report);
  }

  /* Force-fresh token bij elke diagnose-call zodat we niet op cache leunen. */
  invalidateBolToken();

  /* Check 1: minimal offers-list (vraagt slechts page=1) — als auth fout is,
     krijgen we 401/403 direct. */
  try {
    const t0 = Date.now();
    const data = await bolGet('/offers', { query: { page: 1 } });
    report.checks.push({
      name: 'offers-list',
      ok: true,
      ms: Date.now() - t0,
      hint: Array.isArray(data?.offers) ? `${data.offers.length} offers in pagina 1` : 'API responded'
    });
  } catch (e) {
    report.success = false;
    report.checks.push({ name: 'offers-list', ok: false, error: String(e?.message || '').slice(0, 300) });
  }

  /* Check 2: orders-list (andere endpoint, andere scope-eis) */
  try {
    const t0 = Date.now();
    const data = await bolGet('/orders', { query: { status: 'OPEN' }, version: bolOrdersVersion() });
    report.checks.push({
      name: 'orders-list',
      ok: true,
      ms: Date.now() - t0,
      hint: Array.isArray(data?.orders) ? `${data.orders.length} open orders` : 'API responded'
    });
  } catch (e) {
    report.checks.push({ name: 'orders-list', ok: false, error: String(e?.message || '').slice(0, 300) });
  }

  /* Check 3: process-status van non-bestaand ID. Verwacht 404 (= scope OK).
     Krijgen we 403, dan zit het token mogelijk in verkeerde scope/demo. */
  try {
    const t0 = Date.now();
    await bolGet('/shared/process-status/0');
    report.checks.push({ name: 'process-status-scope', ok: true, ms: Date.now() - t0, hint: 'endpoint reachable' });
  } catch (e) {
    const msg = String(e?.message || '');
    const code = msg.match(/\((\d+)\)/)?.[1];
    if (code === '404') {
      report.checks.push({ name: 'process-status-scope', ok: true, hint: '404 (verwacht) — scope OK' });
    } else {
      report.success = false;
      report.checks.push({
        name: 'process-status-scope',
        ok: false,
        error: msg.slice(0, 300),
        suggestie: code === '403'
          ? 'Token heeft geen toegang tot /shared/process-status — check BOL_DEMO env (1 vs 0) + credentials.'
          : 'Onverwachte fout op process-status endpoint.'
      });
    }
  }

  return res.status(200).json(report);
}
