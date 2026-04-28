import { getDeclarations } from '../lib/declarations-store.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      message: 'Alleen GET is toegestaan.'
    });
  }

  const store = String(req.query.store || '').trim();

  if (!store) {
    return res.status(400).json({
      success: false,
      message: 'Winkel ontbreekt.'
    });
  }

  const declarations = getDeclarations()
    .filter((item) => item.store === store);

  return res.status(200).json({
    success: true,
    declarations
  });
}
