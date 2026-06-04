/**
 * Admin-endpoint voor per-user IP-whitelist (thuiswerk).
 *
 *   GET    /api/admin/user-ip-whitelist                       → alle whitelists
 *   GET    /api/admin/user-ip-whitelist?personnelId=1011       → 1 user
 *   POST   /api/admin/user-ip-whitelist                       → upsert
 *           body: { personnelId, label, defaultStore, entries: [{ip, label}] }
 *   DELETE /api/admin/user-ip-whitelist?personnelId=1011       → verwijder
 */

import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { readAllWhitelists, readWhitelistForPersonnel, setWhitelistEntries, removeWhitelist } from '../../lib/user-ip-whitelist-store.js';

export const maxDuration = 20;

function clean(v) { return String(v == null ? '' : v).trim(); }

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'DELETE', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'DELETE', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const pid = clean(req.query.personnelId);
      if (pid) {
        const one = await readWhitelistForPersonnel(pid);
        return res.status(200).json({ success: true, whitelist: one });
      }
      const all = await readAllWhitelists();
      return res.status(200).json({
        success: true,
        count: Object.keys(all).length,
        whitelists: all
      });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const personnelId = clean(body.personnelId);
      if (!personnelId) return res.status(400).json({ success: false, message: 'personnelId verplicht.' });
      const entries = Array.isArray(body.entries) ? body.entries : [];
      const label = clean(body.label);
      const defaultStore = clean(body.defaultStore);
      const actor = clean(req.headers['x-actor'] || 'admin');
      const r = await setWhitelistEntries(personnelId, { entries, label, defaultStore }, actor);
      return res.status(200).json({ success: true, ...r });
    }

    if (req.method === 'DELETE') {
      const personnelId = clean(req.query.personnelId);
      if (!personnelId) return res.status(400).json({ success: false, message: 'personnelId verplicht.' });
      const r = await removeWhitelist(personnelId);
      return res.status(200).json({ success: true, ...r });
    }

    return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
  } catch (e) {
    console.error('[admin/user-ip-whitelist]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
