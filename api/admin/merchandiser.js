/**
 * /api/admin/merchandiser
 *
 * Merchandising-analyses bovenop voorraad + verkoop-advies. Eén endpoint, vier views:
 *   GET ?view=overview      → samenvatting (voorraad-gezondheid + top herverdeling/misgrijpen/doorverkoop)
 *   GET ?view=herverdeling  → winkel↔winkel verplaats-suggesties (overschot → tekort)
 *   GET ?view=misgrijpen    → SKU's out-of-stock terwijl ideaal > 0 (+ elders beschikbaar?)
 *   GET ?view=doorverkoop   → per winkel hardmover/slowmover/dekking + kansen + overvoorraad
 *   &limit=300 (max regels)
 *
 * Auth: admin. Leest alleen bestaande blobs (geen schrijf-actie, geen SRS-call).
 */

import { corsJson, requireAdmin } from '../../lib/request-guards.js';
import { buildMerchandiser } from '../../lib/merchandiser.js';
import { readPortalConfig, merchandiserAlertConfig } from '../../lib/portal-config-store.js';
import { boekUitwisseling } from '../../lib/srs-uitwisseling-create-client.js';
import { getStoreNameByBranchId } from '../../lib/branch-metrics.js';

export const maxDuration = 30;

const VIEWS = new Set(['overview', 'herverdeling', 'misgrijpen', 'doorverkoop']);

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body;
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  /* POST = herverdeling doorzetten naar SRS als uitwisseling (verplaatsing). */
  if (req.method === 'POST') {
    try {
      const b = parseBody(req);
      const cfg = merchandiserAlertConfig(await readPortalConfig());
      if (!cfg.verplaatsEnabled) {
        return res.status(200).json({ success: false, code: 'VERPLAATS_DISABLED', message: 'Verplaatsen naar SRS staat uit. Zet aan in Instellingen → Merchandiser-signalen.' });
      }
      const vanFil = String(b.vanFil || b.vanFiliaal || '').trim();
      const naarFil = String(b.naarFil || b.naarFiliaal || '').trim();
      const barcode = String(b.barcode || b.sku || '').trim();
      const units = Math.floor(Number(b.units || b.aantal || 0));
      if (!vanFil || !naarFil) return res.status(400).json({ success: false, message: 'vanFil en naarFil zijn verplicht.' });
      if (vanFil === naarFil) return res.status(400).json({ success: false, message: 'Van- en naar-winkel mogen niet gelijk zijn.' });
      if (!barcode) return res.status(400).json({ success: false, message: 'Barcode/SKU ontbreekt.' });
      if (!units || units < 1) return res.status(400).json({ success: false, message: 'Aantal moet ≥ 1 zijn.' });

      const ref = (b.referentie || `Merchandiser herverdeling ${getStoreNameByBranchId(vanFil)}→${getStoreNameByBranchId(naarFil)}`).slice(0, 100);
      const result = await boekUitwisseling({ vanFiliaal: vanFil, naarFiliaal: naarFil, referentie: ref, regels: [{ barcode, aantal: units }] });
      return res.status(200).json({ success: !!result.success, status: result.status || '', message: result.success ? 'Verplaatsing aangemaakt in SRS.' : (result.status || 'SRS gaf geen bevestiging.'), van: getStoreNameByBranchId(vanFil), naar: getStoreNameByBranchId(naarFil), units });
    } catch (e) {
      console.error('[admin/merchandiser POST]', e);
      return res.status(500).json({ success: false, message: e.message || 'Verplaatsing mislukt.' });
    }
  }

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET/POST.' });

  try {
    const q = req.query || {};
    const view = VIEWS.has(String(q.view || '').toLowerCase()) ? String(q.view).toLowerCase() : 'overview';
    let limit = parseInt(q.limit, 10);
    if (!Number.isFinite(limit) || limit < 1) limit = 300;
    limit = Math.min(limit, 1000);

    const data = await buildMerchandiser(view, { limit });
    return res.status(200).json({ success: true, ...data });
  } catch (e) {
    console.error('[admin/merchandiser]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
