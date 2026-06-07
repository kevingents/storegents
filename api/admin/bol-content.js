/**
 * /api/admin/bol-content
 *
 * GET  → content-optimalisatieplan (dekking, gaten, families, per-EAN voorstel).
 *        ?refresh=1 herberekent uit de Shopify-cache.
 * POST → { action:'refresh' }            herbereken het plan
 *        { action:'push', eans:[...], dryRun }  bouw/push bol-content
 *                          dryRun!=false → toont alleen het payload (veilig).
 *                          dryRun===false → schrijft live naar bol (vereist creds).
 *
 * Auth: admin-token vereist. De live-push is bewust achter dryRun:false gezet.
 */

import { buildBolContentPlan, readBolContentPlan, isPlanFresh } from '../../lib/bol-content-optimizer.js';
import { pushBolContent, runBolContentAuto, discoverBolCatalog, ensureBolFamilies } from '../../lib/bol-content-writer.js';
import { isBolConfigured } from '../../lib/bol-client.js';
import { getBolSettings } from '../../lib/bol-settings-store.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';
import { readJsonBlob } from '../../lib/json-blob-store.js';

/* Welke live-write-actie vereist welke veiligheidstoggle (Instellingen → bol). */
const LIVE_CONTENT_TOGGLE = { push: 'contentAuto', auto: 'contentAuto', families: 'familiesAuto' };

export const maxDuration = 300;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const refresh = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());
      let plan = refresh ? null : await readBolContentPlan();
      if (!plan || !isPlanFresh(plan)) plan = await buildBolContentPlan();
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      /* Push-voortgang: hoeveel content er live naar bol is gestuurd + wanneer. */
      const pushState = await readJsonBlob('marketplace/bol-content-state.json', { byEan: {} }).catch(() => ({ byEan: {} }));
      const pushedByEan = (pushState && pushState.byEan) || {};
      let laatstePush = null;
      for (const e of Object.keys(pushedByEan)) { const at = pushedByEan[e] && pushedByEan[e].at; if (at && (!laatstePush || at > laatstePush)) laatstePush = at; }
      return res.status(200).json({ success: true, bolGekoppeld: isBolConfigured(), pushStatus: { gepushtTotaal: Object.keys(pushedByEan).length, laatstePush }, ...plan });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const action = String(body.action || '').toLowerCase();

      /* Veiligheids-gate: een LIVE content-/family-push (dryRun===false) mag pas
         als de bijbehorende toggle AAN staat. Dit voorkomt dat de admin-route de
         GENTS-regel omzeilt (Channable's bol-content moet eerst UIT vóór wij
         pushen — anders vechten twee systemen om dezelfde content). De cron
         checkte dit al; nu de handmatige route ook. */
      if (LIVE_CONTENT_TOGGLE[action] && body.dryRun === false) {
        const settings = await getBolSettings();
        if (!settings[LIVE_CONTENT_TOGGLE[action]]) {
          return res.status(409).json({
            success: false,
            message: `Live bol-${action === 'families' ? 'families' : 'content'}-push staat uit. Zet eerst Channable's bol-content UIT en activeer de toggle in Instellingen → bol.com voordat je live schrijft.`
          });
        }
      }

      if (action === 'refresh') {
        const plan = await buildBolContentPlan();
        return res.status(200).json({ success: true, ...plan });
      }

      if (action === 'push') {
        const dryRun = body.dryRun !== false; /* standaard veilig */
        const out = await pushBolContent({ eans: body.eans || [], dryRun });
        return res.status(200).json({ success: true, bolGekoppeld: isBolConfigured(), ...out });
      }

      if (action === 'auto') {
        /* Autonoom alle push-klare producten optimaliseren (alleen wat wijzigde). */
        const dryRun = body.dryRun !== false;
        const out = await runBolContentAuto({ dryRun, maxPush: Number(body.maxPush) || 300 });
        return res.status(200).json({ success: true, bolGekoppeld: isBolConfigured(), ...out });
      }

      if (action === 'discover') {
        /* Lees de echte bol-attribuut-id's + labels voor één EAN uit de catalogus. */
        const out = await discoverBolCatalog(body.ean);
        return res.status(200).json({ success: true, ...out });
      }

      if (action === 'families') {
        /* Maak families aan waar ze ontbreken (overschrijft bestaande niet). */
        const dryRun = body.dryRun !== false;
        const out = await ensureBolFamilies({ dryRun, maxCheck: Number(body.maxCheck) || 40 });
        return res.status(200).json({ success: true, bolGekoppeld: isBolConfigured(), ...out });
      }

      return res.status(400).json({ success: false, message: 'Onbekende action (refresh|push|auto|discover|families).' });
    }

    return res.status(405).json({ success: false, message: 'Alleen GET/POST.' });
  } catch (error) {
    console.error('[admin/bol-content]', error);
    return res.status(500).json({ success: false, message: error.message || 'bol-content mislukt.' });
  }
}
