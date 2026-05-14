const workflowState = new Map();
const followUps = [];
const auditLog = [];

const ALLOWED = ['nieuw', 'in_behandeling', 'opgelost'];
const TRANSITIONS = {
  nieuw: new Set(['in_behandeling', 'opgelost']),
  in_behandeling: new Set(['opgelost']),
  opgelost: new Set([])
};

export function validateWorkflowStatus(status) { return ALLOWED.includes(status); }
export function canTransition(from = 'nieuw', to) { return from === to || TRANSITIONS[from]?.has(to); }

export function getWorkflow(storeId) { return workflowState.get(String(storeId)) || { workflowStatus: 'nieuw', lastHandledBy: null, note: null }; }
export function updateWorkflow(storeId, payload) {
  workflowState.set(String(storeId), { ...getWorkflow(storeId), ...payload, updatedAt: new Date().toISOString() });
  return workflowState.get(String(storeId));
}
export function appendAudit(entry) { auditLog.push({ ...entry, at: new Date().toISOString() }); }
export function createFollowUp(task) { const row = { id: `task_${followUps.length + 1}`, status: 'open', ...task, createdAt: new Date().toISOString() }; followUps.push(row); return row; }

export function getAuditLog() { return auditLog; }
