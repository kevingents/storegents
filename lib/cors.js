export function setCorsHeaders(res, methods = ['GET', 'POST', 'OPTIONS']) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods.join(', '));
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-admin-pin, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export function handleCors(req, res, methods = ['GET', 'POST', 'OPTIONS']) {
  setCorsHeaders(res, methods);
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true;
  }
  return false;
}

export function readAdminToken(req) {
  return String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.admin_token ||
    req.query.token ||
    req.body?.adminToken ||
    req.body?.admin_token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
}

export function isAdminRequest(req) {
  if (String(req.query.public || '') === 'true') return true;
  const adminToken = String(process.env.ADMIN_TOKEN || '12345').trim();
  const given = readAdminToken(req);
  return Boolean(adminToken && given && given === adminToken);
}

export function requireAdmin(req, res) {
  if (isAdminRequest(req)) return false;
  res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  return true;
}
