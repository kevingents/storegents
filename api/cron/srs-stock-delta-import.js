/**
 * Cron: GET /api/cron/srs-stock-delta-import
 * Schedule: every 5 minutes between 06:00 and 22:00 (zie vercel.json).
 *
 * Pakt het laatste delta stock XML bestand uit de SRS SFTP folder en mergt
 * de rows in de per-branch snapshot Blob. De portaal-frontend kan vervolgens
 * via /api/admin/stock/snapshot?store=… razendsnel uit Blob lezen ipv per
 * barcode een SOAP-call te doen.
 *
 * Optioneel: ?mode=full doet de volledige stock XML (zwaarder, 1x per dag).
 *
 * Werkwijze (zie srs.docx, Stock niveau 2):
 *   1. SFTP list /production/stock/delta  → nieuwste *.xml
 *   2. Parse XML → rows per branchId
 *   3. mergeBranchSnapshot per branchId (laatste wint)
 *   4. bumpSnapshotIndex
 *
 * Env-vars vereist:
 *   SRS_STOCK_SFTP_HOST
 *   SRS_STOCK_SFTP_USER
 *   SRS_STOCK_SFTP_PASSWORD
 *   SRS_STOCK_DELTA_FOLDER  (default /production/stock/delta)
 *   SRS_STOCK_FULL_FOLDER   (default /production/stock/full)
 */

import { importLatestStockXml } from '../../lib/srs-stock-sftp-client.js';
import {
  mergeBranchSnapshot,
  replaceBranchSnapshot,
  bumpSnapshotIndex
} from '../../lib/srs-stock-snapshot-store.js';
import { trackedCron } from '../../lib/cron-auto-track.js';

function isAuthorized(req) {
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  if (ua.includes('vercel-cron')) return true;
  if (req.headers['x-vercel-cron']) return true;
  const adminToken = String(process.env.ADMIN_TOKEN || (globalThis.crypto?.randomUUID?.() || String(Math.random()))).trim();
  const token = String(req.headers['x-admin-token'] || req.query?.adminToken || '').trim();
  return Boolean(adminToken && token && token === adminToken);
}

function groupRowsByBranch(rows = []) {
  const byBranch = new Map();
  for (const row of rows) {
    const branchId = String(row?.branchId || '').trim();
    if (!branchId) continue;
    if (!byBranch.has(branchId)) byBranch.set(branchId, []);
    byBranch.get(branchId).push(row);
  }
  return byBranch;
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen GET/POST.' });
  }
  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  const mode = String(req.query.mode || 'delta').toLowerCase() === 'full' ? 'full' : 'delta';
  const maxFiles = Math.max(1, Math.min(Number(req.query.maxFiles || 1) || 1, 5));

  const startedAt = new Date();

  try {
    const result = await importLatestStockXml({ mode, maxFiles });

    if (!result.rows.length) {
      return res.status(200).json({
        success: true,
        mode,
        message: result.message || `Geen rows uit SRS ${mode} stock XML.`,
        files: result.files || [],
        durationMs: Date.now() - startedAt.getTime()
      });
    }

    const byBranch = groupRowsByBranch(result.rows);
    const perBranch = [];
    let totalAdded = 0;
    let totalUpdated = 0;
    let totalRows = 0;

    for (const [branchId, rows] of byBranch.entries()) {
      try {
        const merged = mode === 'full'
          ? await replaceBranchSnapshot(branchId, rows)
          : await mergeBranchSnapshot(branchId, rows);

        if (mode === 'full') {
          perBranch.push({ branchId, mode, rowCount: merged.rowCount, replaced: true });
          totalRows += merged.rowCount || 0;
        } else {
          perBranch.push({
            branchId,
            mode,
            rowCount: merged.rowCount,
            added: merged.added,
            updated: merged.updated
          });
          totalAdded += merged.added || 0;
          totalUpdated += merged.updated || 0;
          totalRows += merged.rowCount || 0;
        }
      } catch (error) {
        perBranch.push({
          branchId,
          mode,
          error: error.message || String(error)
        });
      }
    }

    const indexAfter = await bumpSnapshotIndex({
      branchIds: Array.from(byBranch.keys()),
      mode,
      fileCount: (result.files || []).length,
      rowCount: totalRows
    });

    return res.status(200).json({
      success: true,
      mode,
      files: result.files,
      totals: {
        branches: byBranch.size,
        rows: totalRows,
        added: totalAdded,
        updated: totalUpdated
      },
      perBranch,
      index: indexAfter,
      durationMs: Date.now() - startedAt.getTime()
    });
  } catch (error) {
    console.error('[srs-stock-delta-import]', error);
    return res.status(500).json({
      success: false,
      mode,
      message: error.message || 'Onverwachte fout in delta stock import.',
      durationMs: Date.now() - startedAt.getTime()
    });
  }
}

export default trackedCron('srs-stock-delta-import', handler);
