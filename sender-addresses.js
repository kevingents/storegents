import { getDeclarations } from '../lib/declarations-store.js';
import { handleCors, setCorsHeaders } from '../lib/cors.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);

  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      message: 'Alleen GET is toegestaan.'
    });
  }

  try {
    const store = String(req.query.store || '').trim();

    if (!store) {
      return res.status(400).json({
        success: false,
        message: 'Winkel ontbreekt.'
      });
    }

    const allDeclarations = await getDeclarations();

    const declarations = allDeclarations.filter((item) => {
      return String(item.store || '').trim() === store;
    });

    return res.status(200).json({
      success: true,
      declarations
    });
  } catch (error) {
    console.error('Get declarations error:', error);

    return res.status(500).json({
      success: false,
      message: error.message || 'Declaraties konden niet worden opgehaald.'
    });
  }
}
