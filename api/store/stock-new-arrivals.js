import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { readBranchSnapshot } from '../../lib/srs-stock-snapshot-store.js';
import { listAllBranches } from '../../lib/branch-metrics.js';
import { getNewArrivals, upsertArticles, articleKey, getRegistryStats } from '../../lib/srs-articles-registry.js';

/**
 * GET /api/store/stock-new-arrivals?days=14&limit=50
 *
 * Returnt artikelen die voor het eerst in een SRS-snapshot opdoken in de
 * laatste N dagen. Augmented met huidige totalPieces + branchCount per
 * artikel.
 *
 * Bij elke call wordt de registry "bijgewerkt": nieuwe artikelen die nog
 * niet in de registry zaten worden alsnog opgenomen (met firstSeenAt=now).
 * Dat zorgt dat we altijd verse data hebben, zelfs zonder cron-hook.
 *
 * Eerste call ooit: bootstrap-modus — alle huidige artikelen krijgen
 * firstSeenAt=null en worden uitgesloten van de new-arrivals lijst.
 * Vanaf daarna worden alleen TRULY new articleKeys gemarkeerd als nieuw.
 *
 * Response:
 *   {
 *     success,
 *     days, limit,
 *     count,
 *     bootstrap: true|false,           // was deze call de bootstrap?
 *     newDiscoveredThisRequest,        // hoeveel artikelen werden nu pas toegevoegd
 *     stats: { totalArticles, bootstrap, withFirstSeen, bootstrappedAt },
 *     arrivals: [{
 *       key, firstSeenAt, lastSeenAt,
 *       barcode, sku, articleNumber, title, color, size,
 *       totalPieces, branchCount
 *     }]
 *   }
 */

function clean(v) { return String(v || '').trim(); }

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET.' });
  }

  const days = Math.max(1, Math.min(90, Number(req.query.days || 14)));
  const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));

  try {
    /* Lees alle branch-snapshots parallel */
    const allBranches = listAllBranches();
    const branchIds = allBranches.map((b) => b.branchId).filter(Boolean);

    const snapshots = await Promise.all(branchIds.map(async (bid) => {
      try {
        const snap = await readBranchSnapshot(bid);
        return { branchId: bid, snap };
      } catch {
        return { branchId: bid, snap: null };
      }
    }));

    /* Verzamel ALLE rows voor de registry-upsert */
    const allRows = [];
    for (const { snap } of snapshots) {
      if (snap && Array.isArray(snap.rows)) allRows.push(...snap.rows);
    }

    const upsertResult = await upsertArticles(allRows);
    const stats = await getRegistryStats();
    const arrivals = await getNewArrivals({ days, limit });

    /* Verrijk met huidige totalPieces + branchCount uit de live snapshots */
    const piecesByKey = new Map();
    for (const { snap } of snapshots) {
      if (!snap || !Array.isArray(snap.rows)) continue;
      for (const r of snap.rows) {
        const key = articleKey(r);
        if (!key) continue;
        const pieces = Number(r.pieces || 0);
        const entry = piecesByKey.get(key) || { pieces: 0, branches: new Set() };
        entry.pieces += pieces;
        if (pieces > 0) entry.branches.add(snap.branchId);
        piecesByKey.set(key, entry);
      }
    }

    const enriched = arrivals.map((a) => {
      const p = piecesByKey.get(a.key) || { pieces: 0, branches: new Set() };
      return {
        key: a.key,
        firstSeenAt: a.firstSeenAt,
        lastSeenAt: a.lastSeenAt,
        barcode: clean(a.barcode),
        sku: clean(a.sku),
        articleNumber: clean(a.articleNumber),
        title: clean(a.title),
        color: clean(a.color),
        size: clean(a.size),
        totalPieces: p.pieces,
        branchCount: p.branches.size
      };
    });

    return res.status(200).json({
      success: true,
      days,
      limit,
      count: enriched.length,
      bootstrap: upsertResult.bootstrap,
      newDiscoveredThisRequest: upsertResult.added,
      stats,
      arrivals: enriched,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[stock-new-arrivals] error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'New arrivals lookup mislukt.'
    });
  }
}
