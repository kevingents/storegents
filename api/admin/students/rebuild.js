import { handleCors, setCorsHeaders, requireAdmin } from '../../../lib/cors.js';
import { getCustomers, debugExtractCustomerFields } from '../../../lib/srs-customers-client.js';
import { upsertCustomersInMap, markFullRebuild, readVerenigingMap } from '../../../lib/students-vereniging-store.js';

/**
 * POST /api/admin/students/rebuild
 *
 * Incremental rebuild van de students-vereniging cache. Per call wordt
 * ÉÉN page klanten (default 500) opgehaald uit SRS en in de map gezet.
 *
 * Frontend chained dit door totdat hasMore=false.
 *
 * Query:
 *   ?page=1            — welke pagina (1-based)
 *   ?pageSize=500      — page size (max 1000)
 *   ?finalize=1        — markeer als full-rebuild voltooid (laatste call)
 *
 * Response:
 *   { success, page, pageSize, customersInPage, added, updated, skipped,
 *     hasMore, totalWithVereniging, durationMs }
 */
export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (requireAdmin(req, res)) return;

  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.max(50, Math.min(1000, Number(req.query.pageSize || 500)));
  const finalize = ['1', 'true', 'yes'].includes(String(req.query.finalize || '').toLowerCase());
  const debug = ['1', 'true', 'yes'].includes(String(req.query.debug || '').toLowerCase());

  const startedAt = Date.now();

  try {
    const { customers = [], raw = '' } = await getCustomers({ page, pageSize });

    /* Diagnose: laat zien WELKE velden de bulk-GetCustomers response teruggeeft
       + hoeveel klanten een vereniging-veld hebben. Cruciaal om te zien of de
       bulk-response het vereniging-veld überhaupt bevat (anders blijft de cache
       altijd leeg omdat upsert klanten zonder vereniging skipt). */
    if (debug) {
      const withVereniging = customers.filter((c) => String(c.vereniging || '').trim()).length;
      return res.status(200).json({
        success: true,
        debug: true,
        page,
        pageSize,
        customersInPage: customers.length,
        customersWithVereniging: withVereniging,
        sampleFields: debugExtractCustomerFields(raw),
        sampleCustomers: customers.slice(0, 3).map((c) => ({
          customerId: c.customerId,
          name: c.name,
          vereniging: c.vereniging || null,
          verenigingType: c.verenigingType || null
        })),
        durationMs: Date.now() - startedAt
      });
    }

    /* Upsert deze batch in de cache */
    const upsertResult = await upsertCustomersInMap(customers);

    /* hasMore detectie: als we minder krijgen dan pageSize → laatste pagina */
    const hasMore = customers.length >= pageSize;

    /* Als finalize=1 OF dit is laatste pagina + er werd iets opgehaald → markeer */
    let finalized = null;
    if (finalize || (!hasMore && customers.length > 0)) {
      const totalScanned = page * pageSize - (pageSize - customers.length);
      finalized = await markFullRebuild(totalScanned);
    }

    return res.status(200).json({
      success: true,
      page,
      pageSize,
      customersInPage: customers.length,
      added: upsertResult.added,
      updated: upsertResult.updated,
      skipped: upsertResult.skipped,
      hasMore,
      totalWithVereniging: upsertResult.totalWithVereniging,
      finalized: Boolean(finalized),
      lastFullRebuildAt: finalized?.lastFullRebuildAt || null,
      durationMs: Date.now() - startedAt
    });
  } catch (error) {
    console.error('[admin/students/rebuild] error:', error);
    return res.status(500).json({
      success: false,
      page,
      pageSize,
      durationMs: Date.now() - startedAt,
      message: error.message || 'Rebuild mislukt.'
    });
  }
}
