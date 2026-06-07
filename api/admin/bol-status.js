/**
 * GET /api/admin/bol-status
 *
 * Eén blik op de bol-automatiseringen: welke toggles aan/uit staan (voorraad,
 * prijs, families, content), hoeveel content er ooit gepusht is + wanneer, en
 * hoeveel openstaande voorraad-push-fouten er zijn. Zo zie je direct of er écht
 * iets naar bol gaat i.p.v. te gokken. Auth: admin-token.
 */

import { corsJson, requireAdmin } from '../../lib/request-guards.js';
import { getBolSettings } from '../../lib/bol-settings-store.js';
import { isBolConfigured, getBolConfig } from '../../lib/bol-client.js';
import { readJsonBlob } from '../../lib/json-blob-store.js';
import { readBolStockFailures } from '../../lib/bol-stock-failures-store.js';

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  try {
    const [settings, contentState, failures] = await Promise.all([
      getBolSettings(),
      readJsonBlob('marketplace/bol-content-state.json', { byEan: {} }).catch(() => ({ byEan: {} })),
      readBolStockFailures().catch(() => ({ failed: {} }))
    ]);

    const byEan = (contentState && contentState.byEan) || {};
    const pushedEans = Object.keys(byEan);
    let laatstePush = null;
    for (const e of pushedEans) {
      const at = byEan[e] && byEan[e].at;
      if (at && (!laatstePush || at > laatstePush)) laatstePush = at;
    }
    const openFailures = Object.keys((failures && failures.failed) || {}).length;
    const cfg = getBolConfig();

    return res.status(200).json({
      success: true,
      bolGekoppeld: isBolConfigured(),
      demo: !!cfg.demo,
      toggles: {
        stockAuto: !!settings.stockAuto,
        priceAuto: !!settings.priceAuto,
        familiesAuto: !!settings.familiesAuto,
        contentAuto: !!settings.contentAuto
      },
      stockBuffer: settings.stockBuffer,
      content: {
        gepushtTotaal: pushedEans.length,
        laatstePush,
        stateRefreshedAt: (contentState && contentState.refreshedAt) || null
      },
      voorraad: { openFailures }
    });
  } catch (e) {
    console.error('[admin/bol-status]', e);
    return res.status(200).json({ success: false, message: e.message || 'bol-status mislukt.' });
  }
}
