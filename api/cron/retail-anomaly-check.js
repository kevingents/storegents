/**
 * Cron: GET /api/cron/retail-anomaly-check
 * Schedule: '50 5 * * *'  (na de retail-import van 5:20)
 *
 * Detecteert dagelijks winkels waarvan de omzet sterk afwijkt van dezelfde
 * weekdagen vorig jaar en zet bij grote dalingen een signaal in de Takenplanner
 * (voor de groep uit de Merchandiser-signalen-config). Drempel/venster + aan-uit
 * staan in de in-tool config (anomaly.*). Handmatig: ?adminToken=…
 */

import { trackedCron } from '../../lib/cron-auto-track.js';
import { isCronAuthorized } from '../../lib/cron-auth.js';
import { detectAnomalies } from '../../lib/retail-anomaly.js';
import { readPortalConfig, anomalyAlertConfig, merchandiserAlertConfig } from '../../lib/portal-config-store.js';
import { upsertTask, generateDueInstances } from '../../lib/taken-store.js';

export const maxDuration = 45;

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (!isCronAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    const portalCfg = await readPortalConfig().catch(() => ({}));
    const cfg = anomalyAlertConfig(portalCfg);
    if (!cfg.enabled) return res.status(200).json({ success: true, skipped: 'anomaly-uit' });

    const data = await detectAnomalies({ windowDays: cfg.windowDays, thresholdPct: cfg.thresholdPct });
    const dalingen = data.dalingen || [];

    /* Takenplanner-signaal bij dalingen, naar de gedeelde alert-groep. */
    let taskCreated = false;
    const groep = merchandiserAlertConfig(portalCfg).alertGroep;
    if (groep) {
      const has = dalingen.length > 0;
      await upsertTask({
        id: 'task-omzet-anomalie',
        title: has ? `Omzet-daling bij ${dalingen.length} winkel${dalingen.length > 1 ? 's' : ''}` : 'Omzet: geen grote afwijkingen',
        description: has
          ? dalingen.slice(0, 12).map((r) => `• ${r.store}: ${r.devPct}% (€ ${Math.round(r.recent).toLocaleString('nl-NL')} vs € ${Math.round(r.base).toLocaleString('nl-NL')} vorig jaar)`).join('\n')
          : 'Alle winkels binnen de drempel t.o.v. vorig jaar.',
        assignType: 'group',
        assigneeId: groep,
        assigneeName: merchandiserAlertConfig(portalCfg).alertGroepNaam || groep,
        recurrence: { freq: 'daily' },
        active: has
      }, 'anomaly-cron');
      if (has) { await generateDueInstances(); taskCreated = true; }
    }

    return res.status(200).json({
      success: true,
      window: data.window,
      thresholdPct: cfg.thresholdPct,
      flagged: data.flaggedCount,
      dalingen: dalingen.map((r) => ({ store: r.store, devPct: r.devPct })),
      taskCreated
    });
  } catch (e) {
    console.error('[cron/retail-anomaly-check]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}

export default trackedCron('retail-anomaly-check', handler);
