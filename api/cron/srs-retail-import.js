/**
 * Cron: GET /api/cron/srs-retail-import
 * Schedule: '20 5 * * *'
 *
 * Vernieuwt dagelijks de winkelprestatie-snapshot (klantentellers + verkopen
 * van de SRS data-export SFTP) voor het marketing-dashboard.
 * Handmatig: ?adminToken=… of x-admin-token header.
 */

import { importRetailPerformance } from '../../lib/srs-retail-import.js';
import { trackedCron } from '../../lib/cron-auto-track.js';
import { isCronAuthorized } from '../../lib/cron-auth.js';

/* Versheidscheck: is de to-datum in de bestandsnaam van gisteren/vandaag?
   Zelfde logica als srs-voorraad-import; >1 dag oud = stale. */
function fileToDateStr(name) {
  const m = String(name || '').match(/_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.csv\.gz$/i);
  return m ? m[2] : null;
}
function isFileStale(sourceFile) {
  const to = fileToDateStr(sourceFile);
  if (!to) return false;
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return to < yesterday.toISOString().slice(0, 10);
}

export const maxDuration = 60;

function isAuthorized(req) {
  return isCronAuthorized(req);
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    const d = await importRetailPerformance();

    /* Versheidscheck: zijn de geïmporteerde bestanden van gisteren/vandaag?
       HTTP 207 (partial) → trackedCron registreert als 'partial' (geel in Cron-overzicht). */
    const staleWarnings = [];
    if (d.sources?.verkopen && isFileStale(d.sources.verkopen)) {
      staleWarnings.push(`Verkopen-bestand mogelijk verouderd: ${d.sources.verkopen}`);
    }
    if (d.sources?.tellers && isFileStale(d.sources.tellers)) {
      staleWarnings.push(`Tellers-bestand mogelijk verouderd: ${d.sources.tellers}`);
    }
    if (staleWarnings.length) {
      console.warn('[cron/srs-retail-import] STALE SRS-BESTANDEN:', staleWarnings.join(' | '));
    }

    return res.status(staleWarnings.length ? 207 : 200).json({
      success: true,
      window: d.window,
      winkels: d.totals?.winkels || 0,
      bezoekers: d.totals?.bezoekers || 0,
      omzet: d.totals?.omzet || 0,
      refreshedAt: d.refreshedAt,
      sources: {
        verkopen: d.sources?.verkopen || null,
        verkopenTo: fileToDateStr(d.sources?.verkopen),
        tellers: d.sources?.tellers || null,
        tellersTo: fileToDateStr(d.sources?.tellers)
      },
      staleWarnings: staleWarnings.length ? staleWarnings : undefined
    });
  } catch (e) {
    console.error('[cron/srs-retail-import]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}

export default trackedCron('srs-retail-import', handler);
