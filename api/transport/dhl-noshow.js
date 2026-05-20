import { handleCors, setCorsHeaders, isAdminRequest } from '../../lib/cors.js';
import { sendMail, baseMailHtml } from '../../lib/gents-mailer.js';
import {
  addDhlNoshow,
  updateDhlNoshow,
  getDhlNoshows,
  getDhlNoshowStats
} from '../../lib/dhl-noshow-store.js';
import {
  getDhlHubForStoreAsync,
  getDepotEmailForStoreAsync,
  getDhlHubsGroupedAsync,
  getAllDhlHubsMergedAsync
} from '../../lib/dhl-hubs.js';

/**
 * DHL no-show endpoint:
 *
 *  POST /api/transport/dhl-noshow
 *    Winkel meldt dat DHL vandaag niet is geweest voor pickup.
 *    Body: { store, employeeName, dateMissed?, reason?, pickupCount? }
 *    -> slaat melding op + stuurt mail naar DHL depot
 *
 *  GET /api/transport/dhl-noshow
 *    - met admin-token: stats per winkel + recente meldingen
 *    - zonder admin-token: geblokkeerd
 *    Query: sinceDays=90
 */

function field(value) {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function getDepotCc() {
  const raw = String(process.env.DHL_DEPOT_CC || '').trim();
  if (!raw) return [];
  return raw.split(/[,;]/).map((v) => v.trim()).filter(Boolean);
}

function buildDepotMail({ store, employeeName, dateMissed, reason, pickupCount, hub }) {
  const hubLabel = hub ? `${hub.hub} (${hub.email})` : 'onbekend';
  const subject = `DHL pickup gemist — ${store} (${dateMissed})`;
  const rows = [
    { label: 'Winkel', value: store },
    { label: 'Pickup-adres', value: hub?.pickupAddress || '—' },
    { label: 'Verwacht pickup-venster', value: hub?.pickupWindow || '—' },
    { label: 'Datum', value: dateMissed },
    { label: 'Gemeld door', value: employeeName },
    { label: 'Aantal pakketten klaar voor pickup', value: pickupCount > 0 ? String(pickupCount) : 'onbekend' },
    { label: 'Toelichting van winkel', value: reason || '(geen toelichting)' },
    { label: 'Verwerkende hub', value: hubLabel }
  ];

  const rowsHtml = rows.map((r, idx) => `
    <tr>
      <td style="padding:10px 0;${idx < rows.length - 1 ? 'border-bottom:1px solid #eef2f7;' : ''}font-size:14px;color:#3a4a5a;font-weight:700;width:240px;vertical-align:top;">${r.label}</td>
      <td style="padding:10px 0;${idx < rows.length - 1 ? 'border-bottom:1px solid #eef2f7;' : ''}font-size:14px;color:#0a1f33;white-space:pre-line;">${r.value}</td>
    </tr>`).join('');

  const html = baseMailHtml({
    title: 'DHL pickup gemist',
    intro: `De ${store} meldt dat DHL vandaag niet is langsgekomen voor de pakket-pickup. Graag onderzoeken en zo nodig opnieuw inplannen.`,
    bodyHtml: `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
        ${rowsHtml}
      </table>
      <p style="margin:20px 0 0;font-size:13px;color:#3a4a5a;line-height:1.5;">
        Deze melding is automatisch verstuurd vanuit het GENTS Winkelportaal.
        Een eventueel antwoord wordt zichtbaar in het admin-overzicht "DHL Prestaties".
      </p>`,
    footer: 'GENTS Winkelportaal — Transport / DHL pickup melding.'
  });

  const text = rows.map((r) => `${r.label}: ${r.value}`).join('\n');

  return { subject, html, text };
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'PATCH', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'PATCH', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  /* GET = admin overzicht of hub-info per winkel */
  if (req.method === 'GET') {
    /* Hub-info per winkel — geen admin token vereist (winkel-modal heeft dit nodig) */
    if (req.query.hubFor) {
      const hub = await getDhlHubForStoreAsync(String(req.query.hubFor));
      return res.status(200).json({ success: true, hub });
    }
    /* Volledige hub-lijst gegroepeerd per hub */
    if (req.query.hubs === '1') {
      const hubs = await getDhlHubsGroupedAsync();
      return res.status(200).json({ success: true, hubs });
    }
    /* Stats endpoint — admin token vereist */
    if (!isAdminRequest(req)) {
      return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
    }
    try {
      const sinceDays = Math.min(Math.max(Number(req.query.sinceDays || 90), 1), 365);
      const stats = await getDhlNoshowStats({ sinceDays });
      /* Verrijk perStore met hub-info (async per winkel) */
      stats.perStore = await Promise.all(
        (stats.perStore || []).map(async (s) => ({
          ...s,
          hub: await getDhlHubForStoreAsync(s.store)
        }))
      );
      const hubs = await getDhlHubsGroupedAsync();
      return res.status(200).json({ success: true, ...stats, hubs });
    } catch (error) {
      console.error('[dhl-noshow] GET error:', error);
      return res.status(500).json({ success: false, message: error.message || 'Kon stats niet ophalen.' });
    }
  }

  /* PATCH = admin depot-reactie noteren */
  if (req.method === 'PATCH') {
    if (!isAdminRequest(req)) {
      return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
    }
    try {
      const body = req.body || {};
      const id = String(field(body.id) || '').trim();
      const depotResponse = String(field(body.depotResponse) || '').trim();
      if (!id) return res.status(400).json({ success: false, message: 'id ontbreekt.' });
      const updated = await updateDhlNoshow(id, { depotResponse });
      if (!updated) return res.status(404).json({ success: false, message: 'Melding niet gevonden.' });
      return res.status(200).json({ success: true, entry: updated });
    } catch (error) {
      console.error('[dhl-noshow] PATCH error:', error);
      return res.status(500).json({ success: false, message: error.message || 'Patch mislukt.' });
    }
  }

  /* POST = winkel meldt no-show (open, geen admin-token vereist) */
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen GET, POST en PATCH.' });
  }

  try {
    const body = req.body || {};
    const store = String(field(body.store) || '').trim();
    const employeeName = String(field(body.employeeName) || '').trim();
    const dateMissed = String(field(body.dateMissed) || new Date().toISOString().slice(0, 10)).trim();
    const reason = String(field(body.reason) || '').trim().slice(0, 500);
    const pickupCount = Math.max(0, Number(field(body.pickupCount) || 0));

    if (!store || !employeeName) {
      return res.status(400).json({
        success: false,
        message: 'Winkel en medewerker zijn verplicht.'
      });
    }

    /* Hub-info opzoeken voor deze winkel (inclusief admin-overrides) */
    const hub = await getDhlHubForStoreAsync(store);
    const depotEmail = await getDepotEmailForStoreAsync(store);

    /* Opslaan in store — inclusief hub-info zodat admin-overzicht ziet
       welke depot is aangeschreven */
    const entry = await addDhlNoshow({
      store,
      employeeName,
      dateMissed,
      reason,
      pickupCount,
      hub: hub?.hub || '',
      depotEmail: depotEmail || '',
      pickupWindow: hub?.pickupWindow || ''
    });

    /* Mail naar DHL depot (best-effort) */
    let mailStatus = 'skipped';
    let mailError = '';

    if (depotEmail) {
      try {
        const { subject, html, text } = buildDepotMail({
          store,
          employeeName,
          dateMissed,
          reason,
          pickupCount,
          hub
        });
        await sendMail({
          to: depotEmail,
          cc: getDepotCc(),
          subject,
          html,
          text
        });
        mailStatus = 'sent';
        await updateDhlNoshow(entry.id, { mailStatus: 'sent' });
      } catch (error) {
        console.error('[dhl-noshow] mail error:', error);
        mailStatus = 'failed';
        mailError = error.message || 'mail mislukt';
        await updateDhlNoshow(entry.id, { mailStatus: 'failed' });
      }
    } else {
      mailStatus = 'no-depot-email';
      await updateDhlNoshow(entry.id, { mailStatus: 'no-depot-email' });
    }

    return res.status(200).json({
      success: true,
      message:
        mailStatus === 'sent'
          ? `Melding opgeslagen en mail verstuurd naar ${hub?.hub || 'DHL depot'} (${depotEmail}).`
          : mailStatus === 'no-depot-email'
          ? 'Melding opgeslagen — geen depot-email bekend voor deze winkel.'
          : 'Melding opgeslagen — mail naar depot mislukt (' + mailError + ').',
      entry,
      mailStatus,
      hub
    });
  } catch (error) {
    console.error('[dhl-noshow] POST error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Kon DHL no-show melding niet verwerken.'
    });
  }
}
