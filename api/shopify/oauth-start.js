/**
 * GET /api/shopify/oauth-start[?shop=<shop>.myshopify.com]
 *
 * Start de OAuth-install voor de EIGEN Shopify-winkel (Dev-Dashboard-app
 * "portal 2.0"). Bouwt de Shopify authorize-URL met de gevraagde scopes en
 * redirect erheen. De winkel-admin keurt de scopes goed; daarna komt Shopify
 * terug op /api/shopify/oauth-callback met een code die we inwisselen voor een
 * OFFLINE Admin API access token.
 *
 * Vergrendeld op SHOPIFY_STORE_DOMAIN: alleen onze eigen winkel mag dit doen,
 * zodat niemand de endpoints kan gebruiken om op een vreemde winkel te
 * installeren.
 *
 * Env:
 *   SHOPIFY_APP_CLIENT_ID   — Client ID van de app (Dev Dashboard)   [vereist]
 *   SHOPIFY_STORE_DOMAIN    — onze winkel (bv. "gents" of "gents.myshopify.com")
 *   SHOPIFY_APP_SCOPES      — optioneel; anders de DEFAULT_SCOPES hieronder
 *   SHOPIFY_APP_BASE_URL    — optioneel; anders https://storegents.vercel.app
 */
import crypto from 'crypto';

const DEFAULT_SCOPES = [
  'read_products', 'write_products',
  'read_orders', 'write_orders',
  'read_customers',
  'read_inventory', 'read_locations', 'read_fulfillments',
  'read_gift_cards', 'write_gift_cards',
  'read_shopify_payments_disputes'
].join(',');

function shopDomain(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  if (!s) return '';
  return s.includes('.myshopify.com') ? s : `${s}.myshopify.com`;
}

export default async function handler(req, res) {
  const clientId = String(process.env.SHOPIFY_APP_CLIENT_ID || '').trim();
  if (!clientId) return res.status(503).send('SHOPIFY_APP_CLIENT_ID ontbreekt in Vercel.');

  const ourShop = shopDomain(process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN);
  if (!ourShop) return res.status(503).send('SHOPIFY_STORE_DOMAIN ontbreekt in Vercel.');

  const reqShop = shopDomain(req.query && req.query.shop) || ourShop;
  if (reqShop !== ourShop) return res.status(403).send('Alleen installatie op de eigen GENTS-winkel is toegestaan.');

  const scopes = String(process.env.SHOPIFY_APP_SCOPES || DEFAULT_SCOPES).trim();
  const base = String(process.env.SHOPIFY_APP_BASE_URL || 'https://storegents.vercel.app').replace(/\/$/, '');
  const redirectUri = `${base}/api/shopify/oauth-callback`;
  const state = crypto.randomBytes(16).toString('hex');

  /* state in httpOnly cookie zodat de callback 'm kan verifiëren (CSRF-bescherming). */
  res.setHeader('Set-Cookie', `shopify_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);

  const url = `https://${ourShop}/admin/oauth/authorize`
    + `?client_id=${encodeURIComponent(clientId)}`
    + `&scope=${encodeURIComponent(scopes)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&state=${encodeURIComponent(state)}`;

  res.statusCode = 302;
  res.setHeader('Location', url);
  res.end();
}
