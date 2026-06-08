import { trackedCron } from '../../lib/cron-auto-track.js';
import { listRules, markFired, updateRuleState } from '../../lib/alert-rules-store.js';
import { evaluateRule, buildWarehouseIds } from '../../lib/alert-rules-eval.js';
import { readVoorraadRows } from '../../lib/srs-voorraad-store.js';
import { readProductAudit } from '../../lib/shopify-product-audit.js';
import { readBolOrders } from '../../lib/bol-orders.js';
import { sendGentsMail } from '../../lib/resend-mailer.js';
import { createNotification } from '../../lib/store-notifications-store.js';

export const maxDuration = 60;

/**
 * Cron (uur): evalueer alle actieve slimme-alert-regels en vuur acties (e-mail +
 * portal-melding). Edge-getriggerd + dedupe via lastFired/lastState. Read-only
 * behalve de eigen regel-state. Schedule: 0 * * * * (elk uur).
 */
async function handler(req, res) {
  const secret = String(process.env.ALERT_RULES_CRON_SECRET || process.env.CRON_SECRET || '').trim();
  const incoming = String(req.headers.authorization || req.query.secret || '').replace(/^Bearer\s+/i, '').trim();
  if (secret && incoming !== secret) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    const rules = (await listRules()).filter((r) => r.actief !== false);
    if (!rules.length) return res.status(200).json({ success: true, evaluated: 0, fired: 0 });

    const needsStock = rules.some((r) => r.trigger?.type === 'stock-threshold');
    const needsAudit = rules.some((r) => r.trigger?.type === 'event' && r.trigger?.event !== 'new-bol-order');
    const needsBol = rules.some((r) => r.trigger?.type === 'event' && r.trigger?.event === 'new-bol-order');
    const [voorraadRows, audit, bolOrders] = await Promise.all([
      needsStock ? readVoorraadRows() : Promise.resolve([]),
      needsAudit ? readProductAudit() : Promise.resolve(null),
      needsBol ? readBolOrders() : Promise.resolve(null)
    ]);

    /* NL-lokale datum/tijd. */
    const nl = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' }));
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
    const ctx = {
      voorraadRows, audit, bolOrders, warehouseIds: buildWarehouseIds(),
      today, weekday: nl.getDay(), dayOfMonth: nl.getDate(), hour: nl.getHours()
    };

    let firedCount = 0;
    for (const rule of rules) {
      const r = evaluateRule(rule, ctx);
      if (!r.fired) { if (r.state !== undefined) await updateRuleState(rule.id, r.state); continue; }
      firedCount += 1;

      const subject = `[GENTS] ${r.subject || rule.naam}`;
      const bodyText = r.message || rule.naam;
      const htmlBody = `<p>${escapeHtml(bodyText).replace(/\n/g, '<br>')}</p><p style="color:#64748b;font-size:12px">Slimme alert: <strong>${escapeHtml(rule.naam)}</strong></p>`;

      const mailTo = String(rule.ownerEmail || '').trim() || String(process.env.ALERT_RULES_FALLBACK_EMAIL || '').trim();
      try {
        if (rule.actie?.email !== false && mailTo) {
          await sendGentsMail({ to: mailTo, subject, html: htmlBody, text: bodyText, type: 'slimme-alert', meta: { ruleId: rule.id } });
        } else if (rule.actie?.email !== false) {
          console.warn('[alert-rules-eval] geen ontvanger (ownerEmail leeg + geen ALERT_RULES_FALLBACK_EMAIL) — regel', rule.id, rule.naam);
        }
      } catch (e) { console.error('[alert-rules-eval] mail faalde', rule.id, e.message); }

      try {
        if (rule.actie?.notificatie !== false) {
          await createNotification({
            stores: (rule.ownerStores && rule.ownerStores.length) ? rule.ownerStores : ['*'],
            title: r.subject || rule.naam,
            body: bodyText.slice(0, 2000),
            severity: rule.trigger?.type === 'stock-threshold' ? 'warning' : 'info',
            createdBy: 'slimme-alert'
          });
        }
      } catch (e) { console.error('[alert-rules-eval] notificatie faalde', rule.id, e.message); }

      await markFired(rule.id, r.state ?? null);
    }

    return res.status(200).json({ success: true, evaluated: rules.length, fired: firedCount });
  } catch (error) {
    console.error('[alert-rules-eval]', error);
    return res.status(500).json({ success: false, message: error.message || 'Alert-evaluatie mislukt.' });
  }
}

function escapeHtml(s) { return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

export default trackedCron('alert-rules-eval', handler);
