import { getCustomers } from '../../lib/srs-customers-client.js';
import { upsertCustomersInMap, markFullRebuild, readVerenigingMap } from '../../lib/students-vereniging-store.js';

/**
 * GET /api/cron/students-vereniging-rebuild
 *
 * Nightly cron die de vereniging-cache (students-omzet) opnieuw opbouwt
 * door alle SRS klanten paginated door te scannen.
 *
 * Strategie:
 *   - Verwerkt zo veel mogelijk pages binnen maxRuntimeMs (default 50s)
 *   - State (volgende page) wordt opgeslagen in vereniging-map zelf
 *   - Volgende cron-run pakt verder waar hij stopte
 *   - finalize=true wanneer laatste page < pageSize → markFullRebuild
 *
 * Manual trigger (via Cron-overzicht):
 *   POST /api/admin/cron-trigger { key: 'students-vereniging-rebuild' }
 */

const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_MAX_RUNTIME_MS = 50000;

function clean(value) { return String(value || '').trim(); }

function isAuthorizedCron(req) {
  const expected = clean(process.env.CRON_SECRET || '');
  const adminToken = clean(process.env.ADMIN_TOKEN || '');
  const authHeader = clean(req.headers['authorization'] || '');
  const querySecret = clean(req.query.secret || '');
  const queryAdminToken = clean(req.query.adminToken || req.query.admin_token || '');
  const headerAdminToken = clean(req.headers['x-admin-token'] || req.headers['x-admin-pin'] || '');
  const userAgent = clean(req.headers['user-agent'] || '');

  if (adminToken && (queryAdminToken === adminToken || headerAdminToken === adminToken)) return true;
  if (!expected) return userAgent.includes('vercel-cron/1.0');
  return authHeader === `Bearer ${expected}` || querySecret === expected;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen GET of POST.' });
  }
  if (!isAuthorizedCron(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  const pageSize = Math.max(50, Math.min(1000, Number(req.query.pageSize || DEFAULT_PAGE_SIZE)));
  const maxRuntimeMs = Math.max(5000, Math.min(120000, Number(req.query.maxRuntimeMs || DEFAULT_MAX_RUNTIME_MS)));
  const forceRestart = ['1', 'true', 'yes'].includes(String(req.query.restart || '').toLowerCase());

  const startedAt = Date.now();

  try {
    /* Bepaal startpage: gebruik state uit registry (lastResumePage) of begin opnieuw */
    let map = await readVerenigingMap();
    let page = forceRestart ? 1 : Number(map._cronResumePage || 1);
    if (!Number.isFinite(page) || page < 1) page = 1;

    let totalCustomersInRun = 0;
    let totalAdded = 0;
    let totalUpdated = 0;
    let pagesProcessed = 0;
    let exhausted = false;

    while (Date.now() - startedAt < maxRuntimeMs - 5000) {
      const { customers = [] } = await getCustomers({ page, pageSize });

      if (!customers.length) {
        exhausted = true;
        break;
      }

      const upsertResult = await upsertCustomersInMap(customers);
      totalCustomersInRun += customers.length;
      totalAdded += upsertResult.added;
      totalUpdated += upsertResult.updated;
      pagesProcessed += 1;

      if (customers.length < pageSize) {
        exhausted = true;
        break;
      }

      page += 1;
    }

    /* State updaten: next-page bewaren OF reset bij exhausted */
    map = await readVerenigingMap();
    if (exhausted) {
      delete map._cronResumePage;
      await markFullRebuild(0); /* totalCustomersScanned wordt geüpdatet door markFullRebuild */
      map = await readVerenigingMap(); /* refresh na markFullRebuild */
    } else {
      map._cronResumePage = page + 1; /* volgende cron pakt deze page op */
    }
    /* Schrijf state expliciet als we niet exhausted zijn */
    if (!exhausted) {
      const { writeVerenigingMap } = await import('../../lib/students-vereniging-store.js');
      await writeVerenigingMap(map);
    }

    const runtimeMs = Date.now() - startedAt;
    const message = exhausted
      ? `Cache rebuild voltooid: ${pagesProcessed} pages · ${totalCustomersInRun} klanten · ${totalAdded} nieuw met vereniging · ${totalUpdated} bestaand bijgewerkt`
      : `Partial rebuild: ${pagesProcessed} pages · ${totalCustomersInRun} klanten verwerkt · resume op page ${page + 1} bij volgende run`;

    return res.status(200).json({
      success: true,
      mode: 'students_vereniging_rebuild',
      exhausted,
      pagesProcessed,
      totalCustomersInRun,
      totalAdded,
      totalUpdated,
      nextResumePage: exhausted ? null : (page + 1),
      totalWithVereniging: map.totalWithVereniging || 0,
      lastFullRebuildAt: map.lastFullRebuildAt,
      runtimeMs,
      message
    });
  } catch (error) {
    console.error('[cron/students-vereniging-rebuild] error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Cron rebuild mislukt.',
      runtimeMs: Date.now() - startedAt
    });
  }
}
