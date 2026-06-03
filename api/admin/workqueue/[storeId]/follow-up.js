import { createFollowUp } from '../../../../lib/admin-workqueue/store.js';
import { sendError } from '../../../../lib/api-error.js';
import { requireAdmin } from '../../../../lib/cors.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, { message: 'Alleen POST is toegestaan.', source: 'workqueue_api', endpoint: req.url });
  if (requireAdmin(req, res)) return;
  const { assignee, dueAt, reason, context = {} } = req.body || {};
  const { storeId } = req.query || {};
  if (!storeId || !assignee || !dueAt || !reason) return sendError(res, 400, { message: 'Ontbrekende velden.', source: 'workqueue_api', endpoint: req.url });
  const task = createFollowUp({ storeId, assignee, dueAt, reason, context });
  return res.status(201).json({ success: true, taskId: task.id, status: task.status });
}
