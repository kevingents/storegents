/**
 * Cron: GET /api/cron/gala-crawl
 * Schedule: '40 6 * * *'  (dagelijks)
 *
 * Crawlt publieke bronnen (Reddit-zoek + agenda/lustrum-pagina's) op gala-/
 * lustrum-datums van studentenverenigingen en voegt nieuwe vondsten toe aan de
 * gala-kalender als 'vermoedelijk' (te verifiëren). Extra bronnen + aan/uit via
 * de in-tool config (galaCrawl). Handmatig: ?adminToken=…
 */

import { trackedCron } from '../../lib/cron-auto-track.js';
import { isCronAuthorized } from '../../lib/cron-auth.js';
import { crawlGala, DEFAULT_SOURCES } from '../../lib/gala-crawl.js';
import { seedEvents, writeCrawlLog } from '../../lib/gala-events-store.js';
import { readPortalConfig } from '../../lib/portal-config-store.js';

export const maxDuration = 90;

function extraSources(cfg) {
  const list = (cfg && cfg.galaCrawl && Array.isArray(cfg.galaCrawl.sources)) ? cfg.galaCrawl.sources : [];
  return list.map((u) => ({ url: String(u), kind: (String(u).includes('reddit.com') && String(u).includes('.json')) ? 'reddit' : 'html' }));
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (!isCronAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    const cfg = await readPortalConfig().catch(() => ({}));
    if (cfg.galaCrawl && cfg.galaCrawl.enabled === false) {
      return res.status(200).json({ success: true, skipped: 'crawl-uit' });
    }
    const sources = [...DEFAULT_SOURCES, ...extraSources(cfg)];
    const r = await crawlGala({ sources });
    const seeded = r.events.length ? await seedEvents(r.events) : { added: 0 };
    const log = { at: new Date().toISOString(), checked: r.checked, gevonden: r.events.length, toegevoegd: seeded.added, error: r.error || null };
    await writeCrawlLog(log);
    return res.status(200).json({ success: true, ...log });
  } catch (e) {
    console.error('[cron/gala-crawl]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}

export default trackedCron('gala-crawl', handler);
