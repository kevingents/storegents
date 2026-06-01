/**
 * /api/admin/gala-events
 *   GET                      → { events:[...] }
 *   POST { ...event }        → toevoegen/bewerken één evenement
 *   POST { seed:[...] }      → bulk-seed (research-import, dedupe)
 *   DELETE ?id=…             → verwijderen
 *
 * Gala-/evenementenkalender voor marketing. Auth: admin-token.
 */

import { corsJson, requireAdmin } from '../../lib/request-guards.js';
import { listEvents, upsertEvent, deleteEvent, seedEvents } from '../../lib/gala-events-store.js';

export const maxDuration = 20;

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body;
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'DELETE', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      return res.status(200).json({ success: true, events: await listEvents() });
    }
    if (req.method === 'POST') {
      const b = parseBody(req);
      if (Array.isArray(b.seed)) {
        const r = await seedEvents(b.seed);
        return res.status(200).json({ success: true, ...r, events: await listEvents() });
      }
      const ev = await upsertEvent(b);
      return res.status(200).json({ success: true, event: ev, events: await listEvents() });
    }
    if (req.method === 'DELETE') {
      const id = String((req.query && req.query.id) || '');
      if (!id) return res.status(400).json({ success: false, message: 'id verplicht.' });
      await deleteEvent(id);
      return res.status(200).json({ success: true, events: await listEvents() });
    }
    return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
  } catch (e) {
    console.error('[admin/gala-events]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
