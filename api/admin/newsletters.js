/**
 * /api/admin/newsletters
 *
 * Block-builder voor nieuwsbrieven.
 *   GET                      → { newsletters:[...], blockTypes:[...] }
 *   GET ?id=                 → { newsletter, html (preview) }
 *   POST ?action=save        { id?, name, subject, preheader, blocks }  → opslaan/aanmaken
 *   POST ?action=preview     { blocks, preheader }                       → live preview-HTML (niet opgeslagen)
 *   POST ?action=delete      { id }
 *   POST ?action=duplicate   { id }
 *   POST ?action=send-test   { id, email }
 *   POST ?action=send        { id }   → Resend-broadcast naar hoofd-audience
 *
 * Auth: admin-token vereist.
 */

import {
  listNewsletters, getNewsletter, saveNewsletter, deleteNewsletter, duplicateNewsletter,
  previewNewsletter, renderNewsletterHtml, sendNewsletterTest, sendNewsletterBroadcast,
  startNewsletterAbTest, sendNewsletterAbWinner, BLOCK_DEFS
} from '../../lib/newsletter-builder.js';
import { getAbTestByNewsletter, getAbTest } from '../../lib/ab-test-store.js';
import { getEmailTheme } from '../../lib/email-template-store.js';
import { hasResendKey } from '../../lib/resend-audience.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 60;

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}
const slim = (n) => ({ id: n.id, name: n.name, subject: n.subject, status: n.status, updatedAt: n.updatedAt, sentAt: n.sentAt, blocks: n.blocks });

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  if (!hasResendKey()) return res.status(200).json({ success: true, connected: false, message: 'Resend niet gekoppeld (RESEND_API_KEY ontbreekt).' });

  try {
    if (req.method === 'GET') {
      const id = String(req.query?.id || '').trim();
      if (id) {
        const nl = await getNewsletter(id);
        if (!nl) return res.status(404).json({ success: false, message: 'Niet gevonden.' });
        return res.status(200).json({ success: true, connected: true, newsletter: nl, html: await previewNewsletter(id), abTest: await getAbTestByNewsletter(id).catch(() => null) });
      }
      const list = (await listNewsletters()).map(slim).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      return res.status(200).json({ success: true, connected: true, newsletters: list, blockTypes: BLOCK_DEFS });
    }

    const action = String(req.query?.action || '').trim();
    const body = parseBody(req);

    if (action === 'save') return res.status(200).json({ success: true, newsletter: slim(await saveNewsletter(body)) });
    if (action === 'delete') { await deleteNewsletter(String(body.id || '')); return res.status(200).json({ success: true }); }
    if (action === 'duplicate') return res.status(200).json({ success: true, newsletter: slim(await duplicateNewsletter(String(body.id || ''))) });
    if (action === 'preview') {
      const theme = await getEmailTheme();
      const html = renderNewsletterHtml({ blocks: Array.isArray(body.blocks) ? body.blocks : [], preheader: body.preheader || '' }, theme);
      return res.status(200).json({ success: true, html });
    }
    if (action === 'send-test') {
      try { return res.status(200).json({ success: true, ...(await sendNewsletterTest(String(body.id || ''), String(body.email || ''))) }); }
      catch (e) { return res.status(400).json({ success: false, message: e.message }); }
    }
    if (action === 'send') {
      try { return res.status(200).json({ success: true, ...(await sendNewsletterBroadcast(String(body.id || ''))) }); }
      catch (e) { return res.status(400).json({ success: false, message: e.message }); }
    }
    if (action === 'ab-start') {
      try { return res.status(200).json({ success: true, abTest: await startNewsletterAbTest(String(body.id || ''), { subjectA: body.subjectA, subjectB: body.subjectB, samplePct: body.samplePct }) }); }
      catch (e) { return res.status(400).json({ success: false, message: e.message }); }
    }
    if (action === 'ab-status') {
      const t = body.testId ? await getAbTest(String(body.testId)) : await getAbTestByNewsletter(String(body.id || ''));
      return res.status(200).json({ success: true, abTest: t });
    }
    if (action === 'ab-winner') {
      try { return res.status(200).json({ success: true, ...(await sendNewsletterAbWinner(String(body.testId || ''), { variant: body.variant })) }); }
      catch (e) { return res.status(400).json({ success: false, message: e.message }); }
    }
    return res.status(400).json({ success: false, message: 'Onbekende actie.' });
  } catch (e) {
    console.error('[admin/newsletters]', e);
    return res.status(500).json({ success: false, message: e.message || 'Nieuwsbrief-actie mislukt.' });
  }
}
