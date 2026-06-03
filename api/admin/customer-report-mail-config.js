import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { readMailConfig, writeMailConfig, previewRecipients } from '../../lib/customer-report-mail.js';

/**
 * GET  /api/admin/customer-report-mail-config  → huidige config
 * POST /api/admin/customer-report-mail-config  → opslaan
 *   body: { enabled, includeStoreEmails, includePodium, extraRecipients:[{name,email}] }
 *
 * Config van de klanten-rapport mail (ontvangers + aan/uit). Bron van waarheid
 * is de blob admin/customer-report-mail.json (instelbaar in de tool, geen env).
 */

export const maxDuration = 20;

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ success: false, message: 'Alleen GET/POST.' });
  if (requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const config = await readMailConfig();
      const recipientPreview = await previewRecipients(config).catch(() => null);
      return res.status(200).json({ success: true, config, recipientPreview });
    }
    const b = parseBody(req);
    const config = await writeMailConfig({
      enabled: b.enabled,
      includeStoreEmails: b.includeStoreEmails,
      includePodium: b.includePodium,
      extraRecipients: b.extraRecipients
    }, 'admin');
    const recipientPreview = await previewRecipients(config).catch(() => null);
    return res.status(200).json({ success: true, config, recipientPreview, message: 'Instellingen opgeslagen.' });
  } catch (error) {
    console.error('[admin/customer-report-mail-config]', error);
    return res.status(200).json({ success: false, message: error.message || 'Config-actie mislukte.' });
  }
}
