export function setCorsHeaders(res, methods = ['GET', 'POST', 'PATCH', 'OPTIONS']) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods.join(', '));
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export function handleCors(req, res, methods = ['GET', 'POST', 'PATCH', 'OPTIONS']) {
  setCorsHeaders(res, methods);

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true;
  }

  return false;
}
