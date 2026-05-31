/**
 * GET /api/admin/ai-visibility
 *
 * AI-vindbaarheid: technische readiness-audit van de live site + (on-demand)
 * live AI-test-queries tegen Claude.
 *
 * Query:
 *   ?refresh=1    → her-run de readiness-audit (live-site scan)
 *   ?run=tests    → draai de AI-test-queries live (kost AI-tokens); anders
 *                   wordt de laatst gecachte test-run getoond.
 *
 * Read-only richting de site/Shopify. Auth: admin-token vereist.
 */

import {
  runAiReadiness, readAiReadiness, isReadinessFresh,
  runAiTestQueries, readAiTestQueries
} from '../../lib/ai-visibility.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 60;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });

  try {
    const refresh = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());
    const runTests = String(req.query.run || '').toLowerCase() === 'tests';

    let readiness = refresh ? null : await readAiReadiness();
    let cached = Boolean(readiness);
    if (!readiness || !isReadinessFresh(readiness)) {
      readiness = await runAiReadiness();
      cached = false;
    }

    let tests;
    if (runTests) {
      tests = await runAiTestQueries({});
    } else {
      tests = await readAiTestQueries();
    }

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({ success: true, cached, readiness, tests, testsRan: runTests });
  } catch (error) {
    console.error('[admin/ai-visibility]', error);
    return res.status(500).json({ success: false, message: error.message || 'AI-vindbaarheid mislukt.' });
  }
}
