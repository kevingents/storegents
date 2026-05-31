/**
 * GET /api/admin/srs-verkopen-diagnose
 *
 * READ-ONLY diagnose van het nieuwste verkopen_*.csv.gz op de SRS-SFTP.
 * Rapporteert de échte kolomkoppen, kandidaat-marker-kolommen (order/web/kanaal),
 * distinct-waarden van lage-cardinaliteit kolommen, de uitsplitsing per
 * verkoop_soort (rijen + bedrag) en een paar voorbeeldrijen.
 *
 * Doel: vaststellen hoe pick/fulfilment-weborders in de export staan, zodat de
 * winkel-omzet-import ze correct als webshop kan uitsluiten i.p.v. als
 * winkelomzet te tellen. Schrijft niets weg.
 *
 * Auth: admin-token vereist.
 */

import { diagnoseVerkopen } from '../../lib/srs-retail-import.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });

  try {
    const sampleSize = Math.max(1, Math.min(20, Number(req.query.sample || 5)));
    const result = await diagnoseVerkopen({ sampleSize });
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json(result);
  } catch (error) {
    console.error('[admin/srs-verkopen-diagnose]', error);
    return res.status(500).json({ success: false, message: error.message || 'Diagnose mislukt.' });
  }
}
