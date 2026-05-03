import syncHandler from '../admin/stock-negative/sync.js';

export default async function handler(req, res) {
  const secret = process.env.STOCK_NEGATIVE_SYNC_SECRET || '';
  const incoming = String(req.headers.authorization || req.query.secret || '').replace(/^Bearer\s+/i, '').trim();

  if (secret && incoming !== secret) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  req.query = {
    ...(req.query || {}),
    mode: req.query.mode || 'delta'
  };

  return syncHandler(req, res);
}
