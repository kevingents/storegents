/**
 * GET /api/admin/mail-log-content?id=<resendId>
 *
 * Haalt de WERKELIJK verstuurde mailinhoud op bij Resend (Retrieve Email). De
 * mail-log bewaart alleen metadata + de Resend message-id; de HTML-body halen we
 * on-demand op zodat we geen grote bodies in de blobs hoeven te bewaren.
 *
 * Auth: admin. Vereist RESEND_API_KEY.
 *
 * Let op: Resend bewaart verzonden mails beperkt in de tijd — heel oude mails
 * kunnen 404 geven.
 */
import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (requireAdmin(req, res)) return;

  const id = String(req.query.id || '').trim();
  if (!id) return res.status(400).json({ success: false, message: 'Mail-id ontbreekt.' });

  const key = String(process.env.RESEND_API_KEY || '').trim();
  if (!key) return res.status(503).json({ success: false, message: 'RESEND_API_KEY ontbreekt in Vercel.' });

  try {
    const r = await fetch(`https://api.resend.com/emails/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (data && (data.message || data.name)) || `Resend gaf HTTP ${r.status}`;
      return res.status(r.status === 404 ? 404 : 502).json({ success: false, message: msg });
    }
    return res.status(200).json({
      success: true,
      id: data.id || id,
      subject: data.subject || '',
      to: data.to || [],
      from: data.from || '',
      html: data.html || '',
      text: data.text || '',
      createdAt: data.created_at || '',
      lastEvent: data.last_event || ''
    });
  } catch (e) {
    return res.status(502).json({ success: false, message: e.message || 'Ophalen bij Resend mislukt.' });
  }
}
