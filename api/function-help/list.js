import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { getFunctionHelpItems, FUNCTION_HELP_CATEGORIES } from '../../lib/function-help-store.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  }

  try {
    const items = await getFunctionHelpItems();
    return res.status(200).json({
      success: true,
      count: items.length,
      items,
      categories: FUNCTION_HELP_CATEGORIES
    });
  } catch (error) {
    console.error('[function-help/list]', error);
    return res.status(500).json({ success: false, message: error.message || 'Function help kon niet worden opgehaald.' });
  }
}
