/**
 * Mijn taken — voor de toegewezen gebruiker zelf (geen admin-token nodig).
 *
 * GET  /api/me/taken?userId=...        → open + recent-afgeronde taken voor deze
 *                                         gebruiker (eigen + via zijn groepen)
 * POST /api/me/taken { action:'complete', instanceId, userId }  → afvinken
 *
 * Identiteit komt mee als userId (query/header x-user-id). De groepen worden
 * server-side bepaald (lid-van), zodat de client die niet hoeft te kennen.
 */

import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import {
  listInstancesForUser, completeInstance, readTaken, todayNL
} from '../../lib/taken-store.js';
import { getGroupsForUser } from '../../lib/user-groups-store.js';

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body || {};
}

function extractUserId(req, body) {
  return String(req.headers['x-user-id'] || req.query?.userId || body?.userId || '').trim();
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  try {
    const body = req.method === 'POST' ? parseBody(req) : {};
    const userId = extractUserId(req, body);
    if (!userId) return res.status(400).json({ success: false, message: 'userId is verplicht.' });

    const groups = await getGroupsForUser(userId).catch(() => []);
    const groupKeys = (groups || []).map((g) => g.key);

    if (req.method === 'POST' && String(body.action || '') === 'complete') {
      /* Alleen afvinken als de instantie echt van deze gebruiker/groep is. */
      const { instances } = await readTaken();
      const inst = instances[String(body.instanceId || '').trim()];
      if (!inst) return res.status(404).json({ success: false, message: 'Taak niet gevonden.' });
      const allowed = (inst.assignType === 'user' && inst.assigneeId === userId)
        || (inst.assignType === 'group' && groupKeys.includes(inst.assigneeId));
      if (!allowed) return res.status(403).json({ success: false, message: 'Deze taak is niet aan jou toegewezen.' });
      const done = await completeInstance(inst.id, userId);
      return res.status(200).json({ success: true, instance: done });
    }

    const list = await listInstancesForUser({ userId, groupKeys });
    const today = todayNL();
    const openCount = list.filter((i) => i.status === 'open').length;
    const overdue = list.filter((i) => i.status === 'open' && i.dueDate < today).length;
    return res.status(200).json({ success: true, today, openCount, overdue, instances: list });
  } catch (error) {
    console.error('[me/taken]', error);
    return res.status(500).json({ success: false, message: error.message || 'Onverwachte fout.' });
  }
}
