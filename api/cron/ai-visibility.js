import { trackedCron } from '../../lib/cron-auto-track.js';
import { runAiReadiness } from '../../lib/ai-visibility.js';

export const maxDuration = 60;

/**
 * Cron: ververs de technische AI-readiness-audit 1× per dag (live-site scan).
 * De AI-test-queries (Claude, kost tokens) draaien NIET automatisch — die start
 * je handmatig vanuit de pagina. Schedule: 5 4 * * *.
 */
async function handler(req, res) {
  const secret = String(process.env.SHOPIFY_PRODUCTS_CRON_SECRET || process.env.CRON_SECRET || '').trim();
  const incoming = String(req.headers.authorization || req.query.secret || '').replace(/^Bearer\s+/i, '').trim();
  if (secret && incoming !== secret) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }
  try {
    const r = await runAiReadiness();
    return res.status(200).json({ success: true, refreshedAt: r.refreshedAt, score: r.score, site: r.site });
  } catch (error) {
    console.error('[ai-visibility cron]', error);
    return res.status(500).json({ success: false, message: error.message || 'AI-readiness mislukt.' });
  }
}

export default trackedCron('ai-visibility', handler);
