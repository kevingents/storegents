/**
 * Cron: GET /api/cron/content-new-product-check
 * Schedule: '30 3 * * *' (na de shopify-products-refresh van 03:00)
 *
 * Detecteert NIEUWE Shopify-producten (t.o.v. de vorige run) die GEEN
 * afbeelding hebben en plaatst één samenvattende melding in de Marketing-
 * inbox. De eerste run "seedt" alleen (geen melding) zodat bestaande
 * producten niet als nieuw gemeld worden.
 *
 * Handmatig triggeren: ?adminToken=... of x-admin-token header.
 */

import { readProductsCache } from '../../lib/shopify-products-cache.js';
import { readJsonBlob, writeJsonBlob } from '../../lib/json-blob-store.js';
import { createNotification } from '../../lib/store-notifications-store.js';
import { trackedCron } from '../../lib/cron-auto-track.js';
import { isCronAuthorized } from '../../lib/cron-auth.js';

const SEEN_PATH = 'marketing/content-seen-products.json';

function isAuthorized(req) {
  return isCronAuthorized(req);
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    const cache = await readProductsCache();

    /* Unieke producten + afbeelding-aantal uit de variant-cache. */
    const byProduct = new Map();
    for (const v of Object.values(cache.bySku || {})) {
      const pid = v.productId || v.productHandle;
      if (!pid) continue;
      const ic = Array.isArray(v.images) ? v.images.length : (v.image ? 1 : 0);
      if (!byProduct.has(pid)) byProduct.set(pid, { id: pid, title: v.title || '—', url: v.productUrl || '', imagesCount: ic });
      else if (ic > byProduct.get(pid).imagesCount) byProduct.get(pid).imagesCount = ic;
    }
    const currentIds = [...byProduct.keys()];

    const seenData = await readJsonBlob(SEEN_PATH, { seen: [], seeded: false });
    const seenSet = new Set(Array.isArray(seenData.seen) ? seenData.seen : []);
    const firstRun = !seenData.seeded;

    let newWithoutImage = [];
    let notificationCreated = false;

    if (!firstRun) {
      newWithoutImage = currentIds
        .filter((id) => !seenSet.has(id))
        .map((id) => byProduct.get(id))
        .filter((p) => p && p.imagesCount === 0);

      if (newWithoutImage.length) {
        const sample = newWithoutImage.slice(0, 8).map((p) => `• ${p.title}`).join('\n');
        const extra = newWithoutImage.length > 8 ? `\n…en ${newWithoutImage.length - 8} meer` : '';
        await createNotification({
          stores: ['Marketing'],
          title: `${newWithoutImage.length} nieuw product${newWithoutImage.length === 1 ? '' : 'en'} zonder afbeelding`,
          body: `Nieuw op Shopify maar nog geen beeld:\n${sample}${extra}\n\nGa naar Marketing → Content beheer om ze op te pakken.`,
          severity: 'warning',
          createdBy: 'content-check'
        });
        notificationCreated = true;
      }
    }

    /* Seen-set bijwerken naar de huidige stand. */
    await writeJsonBlob(SEEN_PATH, { seen: currentIds, seeded: true, updatedAt: new Date().toISOString() });

    return res.status(200).json({
      success: true,
      firstRun,
      totalProducts: currentIds.length,
      newWithoutImage: newWithoutImage.length,
      notificationCreated,
      generatedAt: new Date().toISOString()
    });
  } catch (e) {
    console.error('[cron/content-new-product-check]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}

export default trackedCron('content-new-product-check', handler);
