/**
 * /api/admin/resend-sender
 *
 * Per-winkel afzenders voor Resend (bv. denhaag@mail.gents.nl).
 *
 * GET  → { config, senders: [{store, from, localPart, fromName, custom}] }
 * POST ?action=save-base   { domain?, fromName?, defaultLocalPart? }
 *      ?action=save-store   { store, localPart?, fromName? }   (leeg = terug naar standaard)
 *
 * Auth: admin-token vereist.
 */

import { getStoreSenderConfig, saveStoreSenderConfig, listStoreSenders } from '../../lib/resend-sender.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 30;

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const [config, senders] = await Promise.all([getStoreSenderConfig(), listStoreSenders()]);
      return res.status(200).json({ success: true, config: { domain: config.domain, fromName: config.fromName, defaultLocalPart: config.defaultLocalPart }, senders });
    }

    const action = String(req.query?.action || '').trim();
    const body = parseBody(req);

    if (action === 'save-base') {
      const patch = {};
      if (body.domain != null) patch.domain = String(body.domain).trim().slice(0, 80);
      if (body.fromName != null) patch.fromName = String(body.fromName).trim().slice(0, 60);
      if (body.defaultLocalPart != null) patch.defaultLocalPart = String(body.defaultLocalPart).trim().slice(0, 60);
      await saveStoreSenderConfig(patch);
      return res.status(200).json({ success: true, senders: await listStoreSenders() });
    }

    if (action === 'save-store') {
      const store = String(body.store || '').trim();
      if (!store) return res.status(400).json({ success: false, message: 'Winkel ontbreekt.' });
      const cfg = await getStoreSenderConfig();
      const perStore = { ...cfg.perStore };
      const localPart = String(body.localPart || '').trim();
      const fromName = String(body.fromName || '').trim();
      if (!localPart && !fromName) delete perStore[store];          // terug naar standaard
      else perStore[store] = { localPart, fromName };
      await saveStoreSenderConfig({ perStore });
      return res.status(200).json({ success: true, senders: await listStoreSenders() });
    }

    return res.status(400).json({ success: false, message: 'Onbekende actie.' });
  } catch (e) {
    console.error('[admin/resend-sender]', e);
    return res.status(500).json({ success: false, message: e.message || 'Afzender-config mislukt.' });
  }
}
