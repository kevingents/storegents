/**
 * Admin-endpoint voor welkom-mail automation.
 *
 *   GET    /api/admin/welkom-mail                            → config + stats
 *   POST   ?action=dry-run                                    → preview wat zou worden gestuurd
 *   POST   ?action=run-now            body: { onlyStore?: 'GENTS Amsterdam' }
 *   POST   ?action=save-config        body: { stores: {...}, lookbackHours?, maxPerRun? }
 *   POST   ?action=save-store         body: { store: 'GENTS Amsterdam', enabled, subject, fromLocalPart, voucherCode }
 *   POST   ?action=test-mail          body: { to, store } → 1 mail naar test-adres
 */

import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { runWelkomMailAutomation } from '../../lib/welkom-mail-automation.js';
import {
  getWelkomMailConfig,
  saveWelkomMailConfig,
  saveStoreConfig,
  readWelkomMailStats,
  markWelkomMailSent
} from '../../lib/welkom-mail-store.js';
import { sendMail, baseMailHtml } from '../../lib/gents-mailer.js';

export const maxDuration = 300;

function clean(v) { return String(v == null ? '' : v).trim(); }

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const [cfg, stats] = await Promise.all([getWelkomMailConfig(), readWelkomMailStats()]);
      return res.status(200).json({ success: true, config: cfg, stats });
    }

    const action = clean(req.query?.action);
    const body = parseBody(req);

    if (action === 'dry-run') {
      const out = await runWelkomMailAutomation({ dryRun: true, onlyStore: clean(body.onlyStore) });
      return res.status(200).json({ success: true, ...out });
    }

    if (action === 'run-now') {
      const out = await runWelkomMailAutomation({ dryRun: false, onlyStore: clean(body.onlyStore) });
      return res.status(200).json({ success: true, ...out });
    }

    if (action === 'save-config') {
      const patch = {};
      if (body.lookbackHours != null) patch.lookbackHours = Math.max(1, Math.min(168, Number(body.lookbackHours) || 24));
      if (body.maxPerRun != null) patch.maxPerRun = Math.max(1, Math.min(500, Number(body.maxPerRun) || 50));
      if (body.stores && typeof body.stores === 'object') patch.stores = body.stores;
      const cfg = await saveWelkomMailConfig(patch);
      return res.status(200).json({ success: true, config: cfg });
    }

    if (action === 'save-store') {
      const store = clean(body.store);
      if (!store) return res.status(400).json({ success: false, message: 'store verplicht' });
      const patch = {};
      if (body.enabled != null) patch.enabled = !!body.enabled;
      if (body.branchId != null) patch.branchId = clean(body.branchId);
      if (body.subject != null) patch.subject = clean(body.subject).slice(0, 200);
      if (body.fromLocalPart != null) patch.fromLocalPart = clean(body.fromLocalPart).toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 60);
      if (body.voucherCode != null) patch.voucherCode = clean(body.voucherCode).toUpperCase().slice(0, 30);
      if (body.addressLine != null) patch.addressLine = clean(body.addressLine).slice(0, 300);
      if (body.openingHours != null) patch.openingHours = clean(body.openingHours).slice(0, 300);
      if (body.alterationsInfo != null) patch.alterationsInfo = clean(body.alterationsInfo).slice(0, 800);
      if (body.loyaltyInfo != null) patch.loyaltyInfo = clean(body.loyaltyInfo).slice(0, 800);
      const cfg = await saveStoreConfig(store, patch);
      return res.status(200).json({ success: true, config: cfg });
    }

    if (action === 'test-mail') {
      const to = clean(body.to);
      const store = clean(body.store) || 'GENTS Amsterdam';
      if (!to) return res.status(400).json({ success: false, message: 'to verplicht.' });
      const cfg = await getWelkomMailConfig();
      const storeCfg = cfg.stores?.[store] || {};
      const domain = (process.env.GENTS_MAIL_DOMAIN || 'gents.mail.nl');
      const lp = clean(storeCfg.fromLocalPart || 'hallo').toLowerCase().replace(/[^a-z0-9._-]/g, '');
      const fromAddr = `${lp}@${domain}`;
      const fromHeader = `${store} <${fromAddr}>`;
      /* Voor test: stuur de echte welkom-template (zoals klant zou krijgen)
         met een [TEST] prefix. Geeft meteen visuele preview van de mail. */
      const { runWelkomMailAutomation } = await import('../../lib/welkom-mail-automation.js');
      void runWelkomMailAutomation; /* alleen import-ref voor coherentie */
      const html = baseMailHtml({
        title: 'Welkom bij GENTS (test)',
        intro: 'Test-mail — preview van de welkom-mail',
        bodyHtml: `<p style="font:400 14px/1.55 Inter,system-ui,sans-serif">Test van welkom-mail voor <strong>${store}</strong> · onderwerp <em>${clean(storeCfg.subject) || `Welkom bij ${store}`}</em></p>
          <p style="font:400 13px/1.5 Inter,system-ui,sans-serif;color:#475569">Inhoud-blokken zoals geconfigureerd in admin:</p>
          ${clean(storeCfg.openingHours) ? `<div style="margin:10px 0;padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px"><strong>Openingstijden</strong><br>${clean(storeCfg.openingHours)}</div>` : ''}
          ${clean(storeCfg.alterationsInfo) ? `<div style="margin:10px 0;padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px"><strong>Vermaakkosten</strong><br>${clean(storeCfg.alterationsInfo)}</div>` : ''}
          ${clean(storeCfg.loyaltyInfo) ? `<div style="margin:10px 0;padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px"><strong>Punten sparen voor vouchers</strong><br>${clean(storeCfg.loyaltyInfo)}</div>` : ''}
          ${storeCfg.voucherCode ? `<p>Voucher: <code>${storeCfg.voucherCode}</code></p>` : ''}`,
        footer: `Verstuurd vanuit ${fromHeader} via /api/admin/welkom-mail?action=test-mail`
      });
      try {
        const r = await sendMail({
          to,
          subject: `[TEST] ${clean(storeCfg.subject) || `Welkom bij ${store}`}`,
          html,
          from: fromHeader
        });
        return res.status(200).json({ success: true, sentTo: to, messageId: r?.id || r?.messageId || '', from: fromHeader });
      } catch (e) {
        return res.status(500).json({ success: false, message: e.message || 'Test-mail mislukt.' });
      }
    }

    if (action === 'mark-sent') {
      const email = clean(body.email);
      if (!email) return res.status(400).json({ success: false, message: 'email verplicht.' });
      await markWelkomMailSent(email, { store: clean(body.store), branchId: clean(body.branchId) });
      return res.status(200).json({ success: true, markedSent: email });
    }

    return res.status(400).json({ success: false, message: 'Onbekende action.' });
  } catch (e) {
    console.error('[admin/welkom-mail]', e);
    return res.status(500).json({ success: false, message: e.message || 'Welkom-mail fout.' });
  }
}
