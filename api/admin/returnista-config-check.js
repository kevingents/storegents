import { handleCors, setCorsHeaders } from '../../lib/cors.js';

/**
 * GET /api/admin/returnista-config-check
 *
 * Quick diagnostic — geen data, alleen status van env vars + 1 test-call.
 * Veilig: token zelf wordt nooit terug gestuurd, alleen booleans en lengtes.
 */

function isAuthorized(req) {
  const adminToken = String(process.env.ADMIN_TOKEN || '').trim();
  if (!adminToken) return true;
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.admin_token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return token === adminToken;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const token = String(process.env.RETURNISTA_API_TOKEN || '').trim();
  const accountId = String(process.env.RETURNISTA_ACCOUNT_ID || '').trim();

  const tokenInfo = {
    set: Boolean(token),
    length: token.length,
    looksLikeJwt: token.split('.').length === 3,
    preview: token ? `${token.slice(0, 12)}...${token.slice(-8)}` : null
  };
  const accountInfo = {
    set: Boolean(accountId),
    value: accountId || null,
    looksLikeUuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountId)
  };

  let apiTest = { attempted: false };
  if (token && accountId) {
    apiTest.attempted = true;
    try {
      const url = `https://core.returnista.com/api/v0/account/${accountId}/return-requests?limit=1`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        },
        signal: controller.signal
      });
      clearTimeout(timer);
      const text = await resp.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text.slice(0, 300) }; }
      apiTest.status = resp.status;
      apiTest.ok = resp.ok;
      apiTest.itemsReceived = Array.isArray(data.data) ? data.data.length : null;
      apiTest.hasMore = data.hasMore || null;
      if (!resp.ok) {
        apiTest.error = (data.errors && data.errors[0]?.message) || data.message || `HTTP ${resp.status}`;
      }
    } catch (error) {
      apiTest.error = error.message || String(error);
    }
  }

  const allGood = tokenInfo.set && accountInfo.set && apiTest.ok;

  return res.status(200).json({
    success: true,
    allGood,
    summary: allGood
      ? 'Returnista API is correct ingesteld en bereikbaar.'
      : !tokenInfo.set
        ? 'RETURNISTA_API_TOKEN ontbreekt in Vercel env vars.'
        : !accountInfo.set
          ? 'RETURNISTA_ACCOUNT_ID ontbreekt in Vercel env vars.'
          : apiTest.error
            ? `Returnista API geeft fout: ${apiTest.error}`
            : 'Onbekende status.',
    token: tokenInfo,
    accountId: accountInfo,
    apiTest
  });
}
