function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen POST is toegestaan.' });
  }

  try {
    const mod = await import('../exchanges.js');
    return mod.default(req, res);
  } catch (error) {
    console.error('SRS exchanges/process error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Uitwisseling kon niet worden verwerkt.',
      details: null
    });
  }
}
