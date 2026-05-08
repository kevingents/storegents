export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-admin-pin, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });

  return res.status(200).json({
    success: true,
    source: 'cors_test_endpoint',
    message: 'CORS werkt. De volledige Shopify weekrapportage kan nu op deze route worden geplaatst.',
    totals: {
      orderCount: 0,
      lateCount: 0,
      lineItemCount: 0,
      estimatedPickPackMinutes: 0,
      storeCount: 0
    },
    rows: []
  });
}
