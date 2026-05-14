import { appendAudit, canTransition, getWorkflow, updateWorkflow, validateWorkflowStatus } from '../../../lib/admin-workqueue/store.js';
import { sendError } from '../../../lib/api-error.js';
import { setRequestHeaders, withRequestLog } from '../../../lib/request-context.js';

export default async function handler(req, res) {
  const ctx = withRequestLog(req, 'admin/workqueue'); setRequestHeaders(res, ctx.requestId);
  if (req.method !== 'PATCH') return sendError(res, 405, { message: 'Alleen PATCH is toegestaan.', source: 'workqueue_api', endpoint: req.url });
  const { storeId } = req.query || {};
  const { workflowStatus, lastHandledBy = null, note = null } = req.body || {};
  if (!storeId || !validateWorkflowStatus(workflowStatus)) return sendError(res, 400, { message: 'Ongeldige input.', source: 'workqueue_api', endpoint: req.url, details: { storeId, workflowStatus } });
  const current = getWorkflow(storeId);
  if (!canTransition(current.workflowStatus, workflowStatus)) return sendError(res, 409, { message: 'Ongeldige status transitie.', source: 'workqueue_api', endpoint: req.url, details: { from: current.workflowStatus, to: workflowStatus } });
  const updated = updateWorkflow(storeId, { workflowStatus, lastHandledBy, note });
  appendAudit({ storeId, from: current.workflowStatus, to: workflowStatus, lastHandledBy, note, requestId: ctx.requestId });
  ctx.info('status updated', storeId, workflowStatus);
  return res.status(200).json({ success: true, storeId, workflow: updated });
}
