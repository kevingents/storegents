import { getDeclarations } from '../../lib/declarations-store.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || '12345';
  return req.headers['x-admin-token'] === adminToken;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);

  if (!isAuthorized(req)) {
    return res.status(401).json({
      success: false,
      message: 'Niet bevoegd.'
    });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      message: 'Alleen GET is toegestaan.'
    });
  }

  try {
    const declarations = await getDeclarations();

    return res.status(200).json({
      success: true,
      declarations
    });
  } catch (error) {
    console.error('Get admin declarations error:', error);

    return res.status(500).json({
      success: false,
      message: error.message || 'Administratie declaraties konden niet worden opgehaald.'
    });
  }
}
