/**
 * Cron: GET /api/cron/merchandiser-snapshot
 * Schedule: '40 5 * * *'  (na de voorraad- + retail-import van 5:20)
 *
 * Bouwt dagelijks de Merchandiser-samenvatting, bewaart een snapshot (voor
 * historie/trend) en zet — als drempels worden overschreden — een signaal in de
 * Takenplanner (eenmalige taak voor de ingestelde groep). Drempels + groep staan
 * in de in-tool config (Instellingen → Merchandiser-signalen), niet in Vercel.
 * Handmatig: ?adminToken=… of x-admin-token header.
 */

import { trackedCron } from '../../lib/cron-auto-track.js';
import { isCronAuthorized } from '../../lib/cron-auth.js';
import { buildMerchandiser } from '../../lib/merchandiser.js';
import { mutateJsonBlob } from '../../lib/json-blob-store.js';
import { upsertTask, generateDueInstances, todayNL } from '../../lib/taken-store.js';

export const maxDuration = 60;
const SNAPSHOT_PATH = 'srs/merchandiser-snapshot.json';
const MAX_HISTORY = 90;

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (!isCronAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    const ov = await buildMerchandiser('overview', { limit: 12 });
    const cfg = ov.alertConfig || {};
    const alerts = ov.alerts || [];
    const today = todayNL();

    const compact = {
      date: today,
      generatedAt: new Date().toISOString(),
      misgrijpen: (ov.misgrijpen && ov.misgrijpen.totaal) || 0,
      herverdelingUnits: (ov.herverdeling && ov.herverdeling.units) || 0,
      herverdelingValue: (ov.herverdeling && ov.herverdeling.value) || 0,
      overvoorraadValue: ov.overvoorraadValue || 0,
      hardmoverPct: ov.doorverkoop ? ov.doorverkoop.hardmoverPct : null,
      slowmoverPct: ov.doorverkoop ? ov.doorverkoop.slowmoverPct : null,
      alerts
    };

    /* Snapshot + rollende historie. */
    await mutateJsonBlob(SNAPSHOT_PATH, (d0) => {
      const d = (d0 && typeof d0 === 'object') ? d0 : {};
      const history = Array.isArray(d.history) ? d.history.filter((h) => h.date !== today) : [];
      history.push({ date: today, misgrijpen: compact.misgrijpen, herverdelingUnits: compact.herverdelingUnits, overvoorraadValue: compact.overvoorraadValue, alerts: alerts.length });
      while (history.length > MAX_HISTORY) history.shift();
      return { latest: compact, history };
    }, { fallback: { latest: null, history: [] } });

    /* Takenplanner-signaal: alleen als alerts aan staan én er een groep is gekozen. */
    let taskCreated = false;
    if (cfg.alertsEnabled && cfg.alertGroep) {
      const has = alerts.length > 0;
      await upsertTask({
        id: 'task-merchandiser-alert',
        title: has ? `Merchandiser: ${alerts.length} signaal${alerts.length > 1 ? 'en' : ''} vandaag` : 'Merchandiser: binnen drempels',
        description: has ? alerts.map((a) => '• ' + a.message).join('\n') : 'Geen overschrijdingen vandaag.',
        assignType: 'group',
        assigneeId: cfg.alertGroep,
        assigneeName: cfg.alertGroepNaam || cfg.alertGroep,
        recurrence: { freq: 'daily' },
        active: has
      }, 'merchandiser-cron');
      if (has) { await generateDueInstances(); taskCreated = true; }
    }

    return res.status(200).json({ success: true, date: today, alerts: alerts.length, alertTypes: alerts.map((a) => a.type), taskCreated, snapshot: compact });
  } catch (e) {
    console.error('[cron/merchandiser-snapshot]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}

export default trackedCron('merchandiser-snapshot', handler);
