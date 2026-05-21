/**
 * Cron: GET /api/cron/google-reviews-snapshot
 * Schedule: '0 4 * * *' (dagelijks 04:00 UTC)
 *
 * Doel:
 *   1. Voor elke GENTS-winkel: huidige Google Reviews rating + count snapshotten
 *      in trend-store (voor trend-grafiek 12 mnd terug).
 *   2. Detecteer nieuwe lage reviews (≤3★, niet eerder gezien) en stuur een
 *      notificatie naar de winkel + regio-manager.
 *
 * Query overrides voor testing:
 *   ?dryRun=true       — bereken, niet opslaan
 *   ?skipNotify=true   — geen notificaties
 *   ?store=GENTS X     — alleen 1 winkel
 */

import { listBranches } from '../../lib/branch-metrics.js';
import { getGoogleReviewsForStore } from '../../lib/google-reviews-client.js';
import { recordSnapshot } from '../../lib/google-reviews-trend-store.js';
import { flagNewReviews, markReviewsSeen } from '../../lib/google-reviews-seen-store.js';
import { createNotification } from '../../lib/store-notifications-store.js';
import { trackedCron } from '../../lib/cron-auto-track.js';

function isAuthorized(req) {
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  if (ua.includes('vercel-cron')) return true;
  if (req.headers['x-vercel-cron']) return true;
  const adminToken = String(process.env.ADMIN_TOKEN || '12345').trim();
  const token = String(req.headers['x-admin-token'] || req.query?.adminToken || '').trim();
  return Boolean(adminToken && token && token === adminToken);
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
  const skipNotify = String(req.query.skipNotify || '').toLowerCase() === 'true';
  const onlyStore = String(req.query.store || '').trim();

  const branches = listBranches();
  const targets = onlyStore ? branches.filter((b) => b.store === onlyStore) : branches;

  const results = [];
  let totalSnapshots = 0;
  let totalNotifications = 0;

  for (const branch of targets) {
    const row = { store: branch.store, branchId: branch.branchId };
    try {
      const data = await getGoogleReviewsForStore({ store: branch.store, branchId: branch.branchId });
      const rating = Number(data.rating || 0);
      const reviewCount = Number(data.reviewCount || data.userRatingsTotal || 0);
      row.rating = rating;
      row.reviewCount = reviewCount;

      /* 1. Trend-snapshot */
      if (!dryRun && rating > 0) {
        const snap = await recordSnapshot(branch.store, { rating, reviewCount });
        row.snapshot = snap;
        totalSnapshots += 1;
      }

      /* 2. Detecteer nieuwe lage reviews (≤3★, ongezien) */
      const reviews = Array.isArray(data.reviews) ? data.reviews : [];
      if (reviews.length) {
        const flagged = await flagNewReviews(branch.store, reviews);
        const newLowReviews = flagged.filter((r) => r.isNew && Number(r.rating || 0) <= 3);
        row.newLowReviews = newLowReviews.length;

        if (newLowReviews.length && !skipNotify && !dryRun) {
          const samples = newLowReviews.slice(0, 3).map((r) => {
            const text = String(r.text || '').slice(0, 80);
            return `${r.rating}★ ${r.author || 'Anoniem'}${text ? `: "${text}${(r.text || '').length > 80 ? '…' : ''}"` : ''}`;
          }).join('\n');

          try {
            await createNotification({
              stores: [branch.store],
              target: branch.store,
              title: `⚠ ${newLowReviews.length} nieuwe Google review${newLowReviews.length > 1 ? 's' : ''} met lage rating`,
              body: `${samples}\n\nReageer binnen 24u via Google Business profiel.`,
              severity: 'warning',
              link: '/pages/winkel-portaal',
              createdBy: 'cron:google-reviews-snapshot'
            });
            totalNotifications += 1;
            row.notified = true;
          } catch (notifError) {
            row.notifyError = notifError.message;
          }

          /* Markeer ze als gezien zodat ze niet opnieuw notificeren */
          await markReviewsSeen(branch.store, newLowReviews.map((r) => r.derivedId));
        }
      }
    } catch (error) {
      row.error = error.message || String(error);
    }
    results.push(row);
  }

  return res.status(200).json({
    success: true,
    dryRun,
    skipNotify,
    storesProcessed: results.length,
    totalSnapshots,
    totalNotifications,
    results
  });
}

export default trackedCron('google-reviews-snapshot', handler);
