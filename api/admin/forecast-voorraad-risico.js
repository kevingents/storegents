/**
 * GET /api/admin/forecast-voorraad-risico
 *
 * Voorraad-risico voor de forecast: per winkel de bestsellers die bijna leeg zijn
 * (hardmovers), uitverkochte SKUs en verkopende maten die uit voorraad zijn
 * (maatGaten) + dekkingsdagen. Verklaart WAAROM de worst-case kan uitkomen en
 * waar te focussen (bijbestellen / overhevelen). Bron: cached voorraad-advies
 * (lib/voorraad-advies) — geen zware herberekening. 15min cache. Auth: admin-token.
 */

import { corsJson, requireAdmin } from '../../lib/request-guards.js';
import { readVoorraadAdvies } from '../../lib/voorraad-advies.js';

export const maxDuration = 30;

const CACHE = { ts: 0, payload: null };
const TTL_MS = 15 * 60 * 1000;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const refresh = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());
  if (!refresh && CACHE.payload && Date.now() - CACHE.ts < TTL_MS) {
    return res.status(200).json({ ...CACHE.payload, cached: true });
  }

  const advies = await readVoorraadAdvies().catch(() => null);
  if (!advies || !Array.isArray(advies.filialen) || !advies.filialen.length) {
    const payload = { success: true, empty: true, message: 'Nog geen voorraad-advies beschikbaar — draai eerst de voorraad-import/advies.', totals: { winkelsMetRisico: 0, totaalWinkels: 0, totaalHardmovers: 0, totaalUitverkocht: 0 }, winkels: [], bestsellersBijnaLeeg: [] };
    return res.status(200).json({ ...payload, cached: false });
  }

  const winkels = advies.filialen.map((f) => ({
    store: f.store,
    filiaalNummer: f.filiaalNummer,
    status: f.status,
    advies: f.advies,
    hardmovers: f.hardmovers || 0,
    uitverkocht: (f.signals && f.signals.uitverkocht) || 0,
    onderTarget: (f.signals && f.signals.onderTarget) || 0,
    dekkingDagen: f.dekkingDagen,
    maatGaten: (f.maatGaten || []).slice(0, 5).map((g) => ({ size: g.size, sold: g.sold || 0 }))
  })).sort((a, b) => ((b.hardmovers + b.uitverkocht) - (a.hardmovers + a.uitverkocht)));

  const totals = {
    totaalWinkels: winkels.length,
    winkelsMetRisico: winkels.filter((w) => (w.hardmovers + w.uitverkocht) > 0).length,
    totaalHardmovers: winkels.reduce((s, w) => s + w.hardmovers, 0),
    totaalUitverkocht: winkels.reduce((s, w) => s + w.uitverkocht, 0)
  };

  /* Keten-brede bestsellers die (bijna) op zijn — direct bijbestellen. */
  const g = advies.global || advies.totals || {};
  const bestsellersBijnaLeeg = (g.nietAdverteren || []).slice(0, 12).map((x) => ({
    label: x.label || x.sku, sku: x.sku, voorraad: x.voorraad || 0, sold: x.sold || 0, dagen: x.dagen != null ? x.dagen : null
  }));

  const payload = { success: true, generatedAt: advies.generatedAt || null, totals, winkels, bestsellersBijnaLeeg };
  CACHE.ts = Date.now();
  CACHE.payload = payload;
  return res.status(200).json({ ...payload, cached: false });
}
