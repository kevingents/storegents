/**
 * /api/admin/voorraad-locaties
 *
 * GET                         → { success, summary, generatedAt, sourceFile }  (per-filiaal overzicht)
 * GET ?sku=2900003578026      → alle bin-locaties voor 1 SKU (over filialen)
 * GET ?store=GENTS+Magazijn   → alle locaties van 1 filiaal (max 500)
 * GET ?geblokkeerd=1          → alleen geblokkeerde locaties
 * GET ?staleDays=90           → locaties niet geïnventariseerd in N dagen
 *
 * Leest snapshot uit srs-voorraad-store. Geen SFTP-call.
 *
 * Auth: admin-token vereist.
 */

import { readLocaties } from '../../lib/srs-voorraad-store.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET.' });
  }

  try {
    const data = await readLocaties();
    const rows = Array.isArray(data?.rows) ? data.rows : [];
    const summary = data?.summary || { filialen: [] };

    if (!data?.generatedAt) {
      return res.status(200).json({
        success: true,
        empty: true,
        summary: { filialen: [] },
        message: 'Nog geen locaties-snapshot. Trigger /api/cron/srs-voorraad-import.'
      });
    }

    const sku = String(req.query?.sku || '').trim();
    const store = String(req.query?.store || '').trim();
    const onlyGeblokkeerd = String(req.query?.geblokkeerd || '') === '1';
    const staleDays = Number(req.query?.staleDays || 0);

    /* Specifieke queries → lijst rijen */
    if (sku || store || onlyGeblokkeerd || staleDays > 0) {
      let filtered = rows;
      if (sku)   filtered = filtered.filter((r) => r.sku === sku);
      if (store) filtered = filtered.filter((r) => r.store === store);
      if (onlyGeblokkeerd) filtered = filtered.filter((r) => r.geblokkeerd);
      if (staleDays > 0) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - staleDays);
        const cutoffStr = cutoff.toISOString().slice(0, 10);
        filtered = filtered.filter((r) => {
          const d = String(r.lastInventarisation || '').slice(0, 10);
          return d && d < cutoffStr;
        });
      }
      return res.status(200).json({
        success: true,
        generatedAt: data.generatedAt,
        sourceFile: data.sourceFile || null,
        count: filtered.length,
        rows: filtered.slice(0, 500),
        truncated: filtered.length > 500
      });
    }

    /* Default → per-filiaal summary */
    return res.status(200).json({
      success: true,
      generatedAt: data.generatedAt,
      sourceFile: data.sourceFile || null,
      summary,
      totalRows: rows.length
    });
  } catch (e) {
    console.error('[admin/voorraad-locaties]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
