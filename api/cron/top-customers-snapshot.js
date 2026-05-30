/**
 * Cron: bouw de dagelijkse top-klanten snapshot (Shopify lifetime besteding).
 *
 * Scant Shopify-klanten (GraphQL, gepagineerd, page-cap via TOP_CUSTOMERS_MAX_PAGES),
 * sorteert op besteding en bewaart de top-N in reports/top-customers.json.
 * De rapport-fetcher 'top-klanten' leest alleen die blob — geen live API-call
 * tijdens de export.
 *
 * Handmatig triggeren: /api/cron/top-customers-snapshot?secret=<CRON_SECRET>
 */

import { trackedCron } from '../../lib/cron-auto-track.js';
import { buildTopCustomersSnapshot, writeTopCustomers } from '../../lib/top-customers-store.js';

async function handler(req, res) {
  /* Vercel stuurt bij cron-invocatie Authorization: Bearer <CRON_SECRET> mee.
     Daarop vertrouwen we (niet op de spoofbare user-agent). Zonder secret:
     geen auth-gate (legacy gedrag, consistent met overige crons). */
  const secret = process.env.TOP_CUSTOMERS_CRON_SECRET || process.env.CRON_SECRET || '';
  const incoming = String(req.headers.authorization || req.query.secret || '')
    .replace(/^Bearer\s+/i, '').trim();
  if (secret && incoming !== secret) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  try {
    const maxPages = Number(req.query.maxPages) || undefined;
    const keep = Number(req.query.keep) || undefined;
    const snapshot = await buildTopCustomersSnapshot({ maxPages, keep });
    await writeTopCustomers(snapshot);
    return res.status(200).json({
      success: true,
      generatedAt: snapshot.generatedAt,
      scanned: snapshot.scanned,
      kept: snapshot.customers.length,
      truncated: snapshot.truncated,
      note: snapshot.note || ''
    });
  } catch (error) {
    console.error('[cron/top-customers-snapshot]', error);
    return res.status(500).json({ success: false, message: error.message || 'Snapshot mislukt.' });
  }
}

export default trackedCron('top-customers-snapshot', handler);
