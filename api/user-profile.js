import { handleCors, setCorsHeaders } from '../lib/cors.js';
import { getUserProfile, saveUserProfile } from '../lib/user-profile-store.js';

/**
 * /api/user-profile
 *   GET  ?role=admin OR ?role=employee&store=X&employeeName=Y
 *   POST { role, store?, employeeName?, name?, birthday?, theme?, email? }
 *
 * GEEN admin-auth nodig — winkel-medewerkers moeten zelf hun profile
 * kunnen beheren. De user-id wordt gebouwd uit role + store + employeeName
 * dus elke combinatie is een aparte 'user'.
 *
 * Voor admin: role=admin is voldoende (één admin-profile gedeeld).
 */
function parseBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

function clean(v) { return String(v ?? '').trim(); }

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'GET') {
    const role = clean(req.query.role) === 'admin' ? 'admin' : 'employee';
    const store = clean(req.query.store);
    const employeeName = clean(req.query.employeeName || req.query.employee);
    if (role !== 'admin' && (!store || !employeeName)) {
      return res.status(400).json({ success: false, message: 'role=employee vereist store + employeeName.' });
    }
    try {
      const profile = await getUserProfile({ role, store, employeeName });
      return res.status(200).json({ success: true, profile });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message || 'Lezen mislukt.' });
    }
  }

  if (req.method === 'POST') {
    try {
      const body = parseBody(req);
      const role = clean(body.role) === 'admin' ? 'admin' : 'employee';
      const store = clean(body.store);
      const employeeName = clean(body.employeeName);
      if (role !== 'admin' && (!store || !employeeName)) {
        return res.status(400).json({ success: false, message: 'role=employee vereist store + employeeName.' });
      }
      const profile = await saveUserProfile({
        role,
        store,
        employeeName,
        name: body.name,
        birthday: body.birthday,
        theme: body.theme,
        email: body.email
      });
      return res.status(200).json({ success: true, profile });
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message || 'Opslaan mislukt.' });
    }
  }

  return res.status(405).json({ success: false, message: 'Alleen GET/POST.' });
}
