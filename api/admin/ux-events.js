import { pushUxEvent } from '../../lib/admin-workqueue/ux-metrics-store.js';
import { sendError } from '../../lib/api-error.js';
const allowed = new Set(['cta_clicked', 'status_changed', 'error_shown', 'retry_clicked']);
export default async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, { message: 'Alleen POST is toegestaan.', source: 'ux_events_api', endpoint: req.url });
  const body = req.body || {};
  if (!allowed.has(body.event)) return sendError(res, 400, { message: 'Onbekend eventtype.', source: 'ux_events_api', endpoint: req.url });
  pushUxEvent({ ...body, at: new Date().toISOString() });
  return res.status(202).json({ success: true });
}
