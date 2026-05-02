function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  }

  try {
    const mod = await import('../exchanges.js');
    return mod.default(req, res);
  } catch (error) {
    console.error('SRS exchanges/open safe fallback:', error);
    return res.status(200).json({
      success: true,
      degraded: true,
      source: 'safe_empty_fallback',
      message: error.message || 'Uitwisselingen konden niet worden opgehaald. Lege fallback gebruikt zodat het winkelportaal blijft laden.',
      store: String(req.query.store || '').trim(),
      count: 0,
      itemCount: 0,
      overdueCount: 0,
      oldestOpenDays: 0,
      warning: '',
      summary: [],
      exchanges: []
    });
  }
}
