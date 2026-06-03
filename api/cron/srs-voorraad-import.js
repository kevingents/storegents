/**
 * Cron: GET /api/cron/srs-voorraad-import
 * Schedule: '0 5,11,15 * * *' (3x/dag: 05:00 UTC na de nachtelijke SRS-export,
 *   + 11:00 en 15:00 UTC om intraday-mutaties op te pikken). Pakt telkens het
 *   nieuwste voorraad_*.csv.gz; levert SRS overdag geen nieuw bestand, dan
 *   re-importeert 'ie hetzelfde bestand (geen kwaad, maar ook geen versere data).
 *
 * Haalt de nieuwste voorraad_*.csv.gz + voorraadlocaties_*.csv.gz van de SRS
 * data-export SFTP, parsed ze en schrijft een snapshot via srs-voorraad-store.
 *
 * Query overrides:
 *   ?path=/sub      — andere remote directory (default '/')
 *   ?only=voorraad  — alleen voorraad importeren
 *   ?only=locaties  — alleen locaties importeren
 *
 * Handmatige trigger: admin-token via header of ?adminToken=.
 */

import { importVoorraad, importLocaties, importAll } from '../../lib/srs-voorraad-import.js';
import { importDragers } from '../../lib/srs-dragers-import.js';
import { trackedCron } from '../../lib/cron-auto-track.js';
import { isCronAuthorized } from '../../lib/cron-auth.js';

/* Controleer of het geïmporteerde bestand écht een nieuwe levering is.
   Extracteert de 'to'-datum uit de bestandsnaam (bijv. voorraad_…_2026-06-02.csv.gz → '2026-06-02').
   Een bestand is stale als de to-datum meer dan 1 dag oud is t.o.v. vandaag UTC. */
function fileToDateStr(name) {
  const m = String(name || '').match(/_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.csv\.gz$/i);
  return m ? m[2] : null;
}
function isFileStale(sourceFile) {
  const to = fileToDateStr(sourceFile);
  if (!to) return false; /* geen datum in naam = kan niet beoordelen */
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return to < yesterday.toISOString().slice(0, 10);
}

function isAuthorized(req) {
  return isCronAuthorized(req);
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen GET/POST.' });
  }
  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  const remotePath = String(req.query?.path || '/Dataexport');
  const only = String(req.query?.only || '').toLowerCase();

  try {
    let result;
    if (only === 'voorraad') {
      result = { voorraad: await importVoorraad({ remotePath }), locaties: null, errors: [] };
    } else if (only === 'locaties') {
      result = { voorraad: null, locaties: await importLocaties({ remotePath }), errors: [] };
    } else {
      result = await importAll({ remotePath });
    }

    /* Dragers (verplaatsingen) — additief; mag de voorraad-import nooit laten
       falen. Alleen bij de volledige run (geen ?only). */
    let dragers = null;
    if (!only) {
      try { const d = await importDragers({ remotePath }); dragers = { sourceFile: d.sourceFile, open: d.totals?.dragers || 0 }; }
      catch (e) { console.error('[cron/srs-voorraad-import] dragers-import faalde:', e.message); }
    }

    /* Versheidscheck: is het geïmporteerde bestand van gisteren/vandaag?
       Als de to-datum in de bestandsnaam > 1 dag oud is, zijn er nacht geen
       nieuwe bestanden binnengekomen bij SRS. HTTP 207 → trackedCron registreert
       dit als 'partial' (geel) zodat het opvalt in het Cron-overzicht. */
    const staleWarnings = [];
    if (result.voorraad?.sourceFile && isFileStale(result.voorraad.sourceFile)) {
      staleWarnings.push(`Voorraad-bestand mogelijk verouderd: ${result.voorraad.sourceFile} (to-datum > 1 dag oud)`);
    }
    if (result.locaties?.sourceFile && isFileStale(result.locaties.sourceFile)) {
      staleWarnings.push(`Locaties-bestand mogelijk verouderd: ${result.locaties.sourceFile}`);
    }
    if (dragers?.sourceFile && isFileStale(dragers.sourceFile)) {
      staleWarnings.push(`Dragers-bestand mogelijk verouderd: ${dragers.sourceFile}`);
    }
    if (staleWarnings.length) {
      console.warn('[cron/srs-voorraad-import] STALE SRS-BESTANDEN:', staleWarnings.join(' | '));
    }

    const ok = (result.voorraad || result.locaties) && result.errors.length === 0;
    const hasIssues = !ok || staleWarnings.length > 0;
    return res.status(hasIssues ? 207 : 200).json({
      success: ok,
      voorraad: result.voorraad
        ? { sourceFile: result.voorraad.sourceFile, fileTo: fileToDateStr(result.voorraad.sourceFile), rows: result.voorraad.rowCount }
        : null,
      locaties: result.locaties
        ? { sourceFile: result.locaties.sourceFile, fileTo: fileToDateStr(result.locaties.sourceFile), rows: result.locaties.rowCount }
        : null,
      dragers: dragers
        ? { ...dragers, fileTo: fileToDateStr(dragers.sourceFile) }
        : null,
      staleWarnings: staleWarnings.length ? staleWarnings : undefined,
      errors: result.errors.length ? result.errors : undefined,
      generatedAt: new Date().toISOString()
    });
  } catch (e) {
    console.error('[cron/srs-voorraad-import]', e);
    return res.status(500).json({ success: false, message: e.message || 'Import-fout.' });
  }
}

export default trackedCron('srs-voorraad-import', handler);
