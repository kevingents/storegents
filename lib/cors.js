export function setCorsHeaders(req, res, methods = ['GET', 'POST', 'PATCH', 'OPTIONS']) {
  const allowedOrigins = [
    'https://gents.nl',
    'https://www.gents.nl',
    'https://gents-mode.myshopify.com',
    'https://storegents.vercel.app'
  ];

  const origin = req.headers.origin;

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', methods.join(', '));
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
}

export function handleOptions(req, res, methods) {
  setCorsHeaders(req, res, methods);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  return null;
}
