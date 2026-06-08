/**
 * GET /api/shopify/oauth-callback?code=...&shop=...&state=...&hmac=...
 *
 * Vangt de OAuth-redirect van Shopify op, verifieert (winkel-lock + state-cookie
 * + HMAC met de client secret) en wisselt de code in voor een OFFLINE Admin API
 * access token. Toont het token ÉÉNMALIG in de pagina zodat je het in Vercel als
 * SHOPIFY_ADMIN_ACCESS_TOKEN kunt zetten.
 *
 * Het token wordt NIET gelogd en NIET opgeslagen — secrets horen in Vercel env.
 *
 * Env: SHOPIFY_APP_CLIENT_ID, SHOPIFY_APP_CLIENT_SECRET, SHOPIFY_STORE_DOMAIN.
 */
import crypto from 'crypto';

function shopDomain(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  if (!s) return '';
  return s.includes('.myshopify.com') ? s : `${s}.myshopify.com`;
}

function readCookie(req, name) {
  const raw = String((req.headers && req.headers.cookie) || '');
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return '';
}

/* Verifieer de Shopify-HMAC over alle query-params (excl. hmac + signature). */
function verifyHmac(query, secret) {
  const q = query || {};
  if (!q.hmac) return false;
  const message = Object.keys(q)
    .filter((k) => k !== 'hmac' && k !== 'signature')
    .sort()
    .map((k) => `${k}=${Array.isArray(q[k]) ? q[k].join(',') : q[k]}`)
    .join('&');
  const digest = crypto.createHmac('sha256', secret).update(message).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest, 'utf8'), Buffer.from(String(q.hmac), 'utf8'));
  } catch { return false; }
}

const safe = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

function page(title, bodyHtml) {
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,sans-serif;background:#0b1220;color:#e5e9f0;margin:0;padding:40px;display:flex;justify-content:center}
.card{max-width:680px;width:100%;background:#111a2e;border:1px solid #1f2a44;border-radius:14px;padding:28px}
h1{font-size:19px;margin:0 0 10px}p{color:#9fb0c9;line-height:1.55;font-size:14px}
code{font-family:ui-monospace,Menlo,monospace}
.tok{display:block;background:#0b1220;border:1px solid #1f2a44;border-radius:8px;padding:12px;margin:14px 0;word-break:break-all;color:#7ee0a2;font-size:13px;font-family:ui-monospace,Menlo,monospace;user-select:all}
.ok{color:#7ee0a2}.bad{color:#ff8b8b}.warn{color:#ffd28b}</style></head>
<body><div class="card">${bodyHtml}</div></body></html>`;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const clientId = String(process.env.SHOPIFY_APP_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.SHOPIFY_APP_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) {
    return res.status(503).send(page('Config', '<h1 class="bad">Config ontbreekt</h1><p>Zet <code>SHOPIFY_APP_CLIENT_ID</code> en <code>SHOPIFY_APP_CLIENT_SECRET</code> in Vercel.</p>'));
  }

  const q = req.query || {};
  const ourShop = shopDomain(process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN);
  const reqShop = shopDomain(q.shop);
  const code = String(q.code || '');

  if (!reqShop || reqShop !== ourShop) {
    return res.status(403).send(page('Geweigerd', '<h1 class="bad">Verkeerde winkel</h1><p>Installatie is alleen toegestaan op de eigen GENTS-winkel.</p>'));
  }
  if (!code) {
    return res.status(400).send(page('Fout', '<h1 class="bad">Geen code</h1><p>Geen autorisatie-code ontvangen van Shopify.</p>'));
  }

  /* CSRF: state-cookie moet matchen. */
  const cookieState = readCookie(req, 'shopify_oauth_state');
  if (!cookieState || String(q.state || '') !== cookieState) {
    return res.status(403).send(page('Geweigerd', '<h1 class="bad">State klopt niet</h1><p>De beveiligings-state komt niet overeen. Start de installatie opnieuw via <code>/api/shopify/oauth-start</code>.</p>'));
  }

  /* Echtheid: HMAC van Shopify met de client secret. */
  if (!verifyHmac(q, clientSecret)) {
    return res.status(401).send(page('Geweigerd', '<h1 class="bad">HMAC ongeldig</h1><p>Het verzoek kon niet als afkomstig van Shopify worden geverifieerd.</p>'));
  }

  /* Code → offline access token. */
  try {
    const resp = await fetch(`https://${ourShop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.access_token) {
      return res.status(502).send(page('Fout', `<h1 class="bad">Token-uitwisseling mislukte</h1><p>HTTP ${resp.status}. ${safe(data.error_description || data.error || '')}</p>`));
    }

    /* state-cookie wissen; token NIET loggen. */
    res.setHeader('Set-Cookie', 'shopify_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    return res.status(200).send(page('Gelukt', `
      <h1 class="ok">Installatie gelukt</h1>
      <p>Kopieer dit Admin API access token en zet het in Vercel als <code>SHOPIFY_ADMIN_ACCESS_TOKEN</code> (vervang de oude) en redeploy:</p>
      <span class="tok">${safe(data.access_token)}</span>
      <p>Verleende scopes:<br><code>${safe(data.scope || '')}</code></p>
      <p class="warn" style="margin-top:18px">Let op: dit token is een geheim. Sluit deze pagina na het kopiëren — het wordt nergens opgeslagen of gelogd.</p>`));
  } catch (e) {
    return res.status(500).send(page('Fout', `<h1 class="bad">Onverwachte fout</h1><p>${safe(e && e.message)}</p>`));
  }
}
