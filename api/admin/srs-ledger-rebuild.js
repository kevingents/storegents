/**
 * POST /api/admin/srs-ledger-rebuild
 *
 * Herbouwt de dagelijkse retail-ledger uit ÁLLE beschikbare SRS-export-vensters
 * (klantentellers + verkopen), met de weborder-filter toegepast. Zo worden ook
 * oude ledger-dagen ontdaan van weborder-verwerking die ten onrechte als
 * winkelomzet stond. Per (filiaal, dag) wordt overschreven (newest-wins).
 *
 * Body/query (optioneel): { maxWindows }  — beperk het aantal vensters (default 120).
 *
 * Let op: kan even duren (leest meerdere grote gz-bestanden). Idempotent —
 * meerdere keren draaien is veilig.
 *
 * Auth: admin-token vereist.
 */

import { rebuildLedger } from '../../lib/srs-retail-import.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body || {};
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST.' });

  try {
    const body = parseBody(req);
    const maxWindows = Math.max(1, Math.min(500, Number(body.maxWindows || req.query.maxWindows || 120)));
    const result = await rebuildLedger({ maxWindows });
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json(result);
  } catch (error) {
    console.error('[admin/srs-ledger-rebuild]', error);
    return res.status(500).json({ success: false, message: error.message || 'Rebuild mislukt.' });
  }
}
