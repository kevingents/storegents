/**
 * Admin-endpoint voor pak-mail automation.
 *
 *   GET    /api/admin/pak-mail
 *   POST   ?action=dry-run
 *   POST   ?action=run-now            body: { maxPerRun? }
 *   POST   ?action=save               body: { config: {...}, lookbackDays?, maxPerRun? }
 *   POST   ?action=reset-defaults
 *   POST   ?action=preview            body: { testFirstName?, testEmail? }
 *   POST   ?action=test-mail          body: { to, testFirstName? }
 *   POST   ?action=domain-status
 */

import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import {
  getPakMailConfig,
  savePakMailConfig,
  readPakMailStats,
  getPakMailDefaults
} from '../../lib/pak-mail-store.js';
import { runPakMailAutomation, buildPakMailHtml } from '../../lib/pak-mail-automation.js';
import { buildSenderFromHeader, tryGoogleReviews } from '../../lib/welkom-mail-automation.js';
import { sendMail } from '../../lib/gents-mailer.js';

export const maxDuration = 300;
const clean = (v) => String(v == null ? '' : v).trim();
const parseBody = (req) => (req.body && typeof req.body === 'object') ? req.body : (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const [cfg, stats] = await Promise.all([getPakMailConfig(), readPakMailStats()]);
      return res.status(200).json({ success: true, config: cfg, stats, defaults: getPakMailDefaults() });
    }

    const action = clean(req.query?.action);
    const body = parseBody(req);

    if (action === 'dry-run') {
      const out = await runPakMailAutomation({ dryRun: true });
      return res.status(200).json({ success: true, ...out });
    }

    if (action === 'run-now') {
      const batchCap = Number(body.maxPerRun) > 0 ? Math.min(500, Math.floor(Number(body.maxPerRun))) : undefined;
      const out = await runPakMailAutomation({ dryRun: false, maxPerRun: batchCap });
      return res.status(200).json({ success: true, ...out });
    }

    if (action === 'save') {
      const patch = {};
      if (body.config && typeof body.config === 'object') patch.config = body.config;
      if (body.lookbackDays != null) patch.lookbackDays = Math.max(1, Math.min(180, Number(body.lookbackDays) || 30));
      if (body.maxPerRun != null) patch.maxPerRun = Math.max(1, Math.min(500, Number(body.maxPerRun) || 50));
      const cfg = await savePakMailConfig(patch);
      return res.status(200).json({ success: true, config: cfg });
    }

    if (action === 'reset-defaults') {
      const cfg = await savePakMailConfig({ config: getPakMailDefaults() });
      return res.status(200).json({ success: true, config: cfg, message: 'Alle content-velden gereset naar default.' });
    }

    if (action === 'preview') {
      const full = await getPakMailConfig();
      const cfg = full.config;
      let googleReviews = null;
      try { googleReviews = await tryGoogleReviews('GENTS', { branchId: '15' }); } catch {}
      const fakeCustomer = { firstName: clean(body.testFirstName) || 'Kevin' };
      const html = buildPakMailHtml(fakeCustomer, cfg, { googleReviews });
      return res.status(200).json({ success: true, html });
    }

    if (action === 'test-mail') {
      const to = clean(body.to);
      if (!to) return res.status(400).json({ success: false, message: 'to verplicht.' });
      const full = await getPakMailConfig();
      const cfg = full.config;
      let googleReviews = null;
      try { googleReviews = await tryGoogleReviews('GENTS', { branchId: '15' }); } catch {}
      const fakeCustomer = { firstName: clean(body.testFirstName) || 'Kevin' };
      const html = buildPakMailHtml(fakeCustomer, cfg, { googleReviews });
      const fromHeader = buildSenderFromHeader('GENTS', { senderName: cfg.senderName, senderEmail: cfg.senderEmail });
      try {
        const r = await sendMail({
          to,
          subject: `[TEST] ${clean(cfg.subject) || 'Je nieuwe pak'}`,
          html,
          from: fromHeader,
          tags: [{ name: 'category', value: 'pak-mail-test' }]
        });
        return res.status(200).json({ success: true, sentTo: to, messageId: r?.id || '', from: fromHeader });
      } catch (e) {
        return res.status(500).json({ success: false, message: e.message || 'Test-mail mislukt.' });
      }
    }

    if (action === 'domain-status') {
      const full = await getPakMailConfig();
      const senderEmail = clean(full.config?.senderEmail);
      if (!senderEmail) return res.status(200).json({ success: true, status: 'unknown', message: 'Geen senderEmail.' });
      const domain = senderEmail.split('@')[1] || '';
      if (!domain) return res.status(200).json({ success: true, status: 'invalid' });
      if (!process.env.RESEND_API_KEY) return res.status(200).json({ success: true, domain, status: 'unknown', message: 'RESEND_API_KEY niet ingesteld.' });
      try {
        const { Resend } = await import('resend');
        const r = new Resend(process.env.RESEND_API_KEY);
        const list = await r.domains.list();
        const items = Array.isArray(list?.data?.data) ? list.data.data : Array.isArray(list?.data) ? list.data : [];
        const found = items.find((d) => clean(d.name).toLowerCase() === domain.toLowerCase());
        if (!found) return res.status(200).json({ success: true, domain, status: 'not-added', message: `Domein ${domain} niet in Resend.` });
        const rs = clean(found.status).toLowerCase();
        return res.status(200).json({
          success: true, domain,
          status: rs === 'verified' ? 'verified' : rs || 'pending',
          message: rs === 'verified' ? 'Domein geverifieerd.' : `Resend status: ${rs || 'pending'}.`
        });
      } catch (e) {
        return res.status(200).json({ success: true, domain, status: 'error', message: e.message?.slice(0, 200) });
      }
    }

    return res.status(400).json({ success: false, message: 'Onbekende action.' });
  } catch (e) {
    console.error('[admin/pak-mail]', e);
    return res.status(500).json({ success: false, message: e.message || 'Pak-mail fout.' });
  }
}
