export function setCorsHeaders(res, methods = ['GET', 'POST', 'OPTIONS']) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods.join(', '));
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, authorization');
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

export function isAdminRequest(req) {
  const adminToken = String(process.env.ADMIN_TOKEN || '12345').trim();
  const given = String(req.headers['x-admin-token'] || req.query.adminToken || '').trim();
  return Boolean(adminToken && given && given === adminToken);
}

export function requireAdmin(req, res) {
  if (isAdminRequest(req)) return false;
  res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  return true;
}
