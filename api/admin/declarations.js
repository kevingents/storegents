import { getDeclarations } from '../../lib/declarations-store.js';

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN;

  if (!adminToken) {
    return true;
  }

  return req.headers['x-admin-token'] === adminToken;
}

export default async function handler(req, res) {
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

  const declarations = getDeclarations();

  return res.status(200).json({
    success: true,
    declarations
  });
}
