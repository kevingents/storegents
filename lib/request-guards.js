import { handleCors, setCorsHeaders } from './cors.js';

export function corsJson(req, res, methods = ['GET', 'POST', 'OPTIONS']) {
  if (handleCors(req, res, methods)) return true;
  setCorsHeaders(res, methods);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return false;
}

export function getAdminToken() {
  return process.env.ADMIN_TOKEN || '12345';
}

export function readAdminToken(req) {
  return String(
    req.headers?.['x-admin-token'] ||
    req.headers?.authorization ||
    req.query?.adminToken ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
}

export function isAdmin(req) {
  if (String(req.query?.public || '') === 'true') return true;
  return readAdminToken(req) === getAdminToken();
}

export function requireAdmin(req, res) {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, message: 'Niet bevoegd.' });
    return false;
  }
  return true;
}

export function requirePost(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, message: 'Alleen POST is toegestaan.' });
    return false;
  }
  return true;
}

export function requireGet(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
    return false;
  }
  return true;
}
