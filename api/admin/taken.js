/**
 * Takenplanner — admin beheer.
 *
 * GET    /api/admin/taken            → { tasks, instances(open), summary, assignable:{users,groups} }
 * POST   /api/admin/taken            → taak opslaan (body = taakvelden)
 * POST   /api/admin/taken?action=complete   → { instanceId } afvinken
 * POST   /api/admin/taken?action=generate   → { date? } instanties nu genereren
 * DELETE /api/admin/taken?id=...     → taak verwijderen
 *
 * Auth: x-admin-token / adminToken (gelijk aan andere admin-endpoints).
 */

import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import {
  readTaken, listTasks, upsertTask, deleteTask,
  completeInstance, generateDueInstances, listInstances,
  summarize, describeRecurrence
} from '../../lib/taken-store.js';
import { listGroups } from '../../lib/user-groups-store.js';
import { getAllOfficeUsers } from '../../lib/office-users-store.js';
import { getAllUserPermissions } from '../../lib/user-permissions-store.js';

function isAuthorized(req) {
  const adminToken = String(process.env.ADMIN_TOKEN || (globalThis.crypto?.randomUUID?.() || String(Math.random()))).trim();
  const token = String(
    req.headers['x-admin-token'] || req.headers['x-admin-pin'] ||
    req.query?.adminToken || req.query?.admin_token ||
    req.body?.adminToken || req.body?.admin_token || ''
  ).replace(/^Bearer\s+/i, '').trim();
  return Boolean(adminToken && token && token === adminToken);
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body || {};
}

/** Bouw de lijst van toewijsbare personen (office-users + permission-snapshots). */
async function buildAssignableUsers() {
  const byId = new Map();
  try {
    const office = await getAllOfficeUsers();
    for (const u of Object.values(office || {})) {
      if (u.active === false) continue;
      byId.set(u.userId, { id: u.userId, name: u.name || u.email || u.userId, email: u.email || '' });
    }
  } catch { /* skip */ }
  try {
    const perms = await getAllUserPermissions();
    for (const [pid, e] of Object.entries(perms || {})) {
      if (byId.has(pid)) continue;
      const name = e.snapshot?.name || e.name || pid;
      byId.set(pid, { id: pid, name, email: e.snapshot?.email || '' });
    }
  } catch { /* skip */ }
  return [...byId.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), 'nl'));
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'DELETE', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'DELETE', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  try {
    if (req.method === 'GET') {
      const [tasks, state, openInstances, groups, users] = await Promise.all([
        listTasks(),
        readTaken(),
        listInstances({ status: 'open' }),
        listGroups().catch(() => []),
        buildAssignableUsers()
      ]);
      return res.status(200).json({
        success: true,
        tasks: tasks.map((t) => ({ ...t, recurrenceLabel: describeRecurrence(t.recurrence) })),
        instances: openInstances,
        summary: summarize(state),
        assignable: {
          users,
          groups: groups.map((g) => ({ id: g.key, name: g.name, memberCount: (g.memberIds || []).length }))
        }
      });
    }

    if (req.method === 'POST') {
      const action = String(req.query.action || '').trim();
      const body = parseBody(req);
      const actor = String(req.headers['x-actor'] || body.actor || 'admin').trim() || 'admin';

      if (action === 'complete') {
        const inst = await completeInstance(body.instanceId, actor);
        if (!inst) return res.status(404).json({ success: false, message: 'Instantie niet gevonden.' });
        return res.status(200).json({ success: true, instance: inst });
      }
      if (action === 'generate') {
        const created = await generateDueInstances(body.date || undefined);
        return res.status(200).json({ success: true, created: created.length, instances: created });
      }

      const task = await upsertTask(body, actor);
      return res.status(200).json({ success: true, task: { ...task, recurrenceLabel: describeRecurrence(task.recurrence) } });
    }

    if (req.method === 'DELETE') {
      const id = String(req.query.id || '').trim();
      if (!id) return res.status(400).json({ success: false, message: 'id is verplicht.' });
      const r = await deleteTask(id);
      return res.status(200).json({ success: true, ...r });
    }

    return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
  } catch (error) {
    console.error('[admin/taken]', error);
    return res.status(500).json({ success: false, message: error.message || 'Onverwachte fout.' });
  }
}
