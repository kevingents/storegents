import { handleCors, setCorsHeaders, requireAdmin } from '../../../lib/cors.js';
import { aggregateMailEvents } from '../../../lib/mail-events-store.js';

/**
 * GET /api/admin/vouchers/mail-quality?sinceDays=30
 *
 * Returnt bounce/delivery stats voor voucher-emails. Filtert op
 * subject "Je GENTS voucher" (de prefix die sendVoucherEmail gebruikt).
 *
 * Response:
 *   {
 *     success,
 *     sinceDays,
 *     stats: { total, sent, delivered, bounced, complained, ... },
 *     bounceRate: 2.34,         // %
 *     deliverabilityRate: 96.5, // %
 *     complaintRate: 0.12,      // %
 *     uniqueRecipients,
 *     recipientsWithBounce,
 *     recentBounces: [{...}]
 *   }
 *
 * Toont '–' voor alle waardes als nog geen events zijn ontvangen (= webhook
 * nog niet geconfigureerd in Resend).
 */

function clean(v) { return String(v || '').trim(); }

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (requireAdmin(req, res)) return;

  const sinceDays = Math.min(Math.max(Number(req.query.sinceDays || 30), 1), 365);

  try {
    /* Twee aggregaties: voucher-mails (subject prefix) + alle mails (overall) */
    const [voucherAgg, allAgg] = await Promise.all([
      aggregateMailEvents({ subjectPrefix: 'Je GENTS voucher', sinceDays }),
      aggregateMailEvents({ sinceDays })
    ]);

    return res.status(200).json({
      success: true,
      sinceDays,
      voucher: voucherAgg,
      all: allAgg,
      configured: allAgg.stats.total > 0,
      hint: allAgg.stats.total === 0
        ? 'Nog geen mail-events ontvangen. Configureer Resend webhook URL https://storegents.vercel.app/api/webhooks/resend voor events email.sent / email.delivered / email.bounced / email.complained.'
        : null
    });
  } catch (error) {
    console.error('[admin/vouchers/mail-quality] error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Mail-kwaliteit kon niet worden opgehaald.' });
  }
}
