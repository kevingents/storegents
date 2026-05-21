import { findUserByInviteToken, setUserPassword } from '../../lib/office-users-store.js';
import { appendAuditEntry } from '../../lib/permissions-audit-store.js';

/**
 * GET  /api/auth/set-password?token=XXX  → HTML form
 * POST /api/auth/set-password            → { token, password } → set hash
 *
 * Geen admin-token nodig (publieke pagina) — auth via invite-token.
 *
 * Het token wordt door /api/admin/office-users/invite gegenereerd en
 * gemaild naar de user. Token is geldig voor 2 dagen (INVITE_TTL_MS env).
 *
 * Wanneer de admin opnieuw een invite verstuurt naar dezelfde gebruiker,
 * wordt de oude token vervangen. Een klik op een verouderde link leidt
 * dan naar de "Link is verlopen"-pagina met daarop een formulier om
 * zelf een nieuwe invite aan te vragen via /api/auth/request-invite.
 */

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

function clean(v) { return String(v || '').trim(); }

/* Bepaal de portal-URL waar naartoe geredirect moet worden na succes.
   - Default: /pages/winkel-portaal op de Shopify-storefront (gents-production.myshopify.com)
   - Override met env PORTAL_REDIRECT_URL (absolute URL)
   - Via ?next= query param op de set-password call
   - preview_theme_id wordt automatisch doorgegeven als die op de GET stond */
function getPortalUrl(req) {
  const previewId = clean(req.query?.preview_theme_id);
  const fromQuery = clean(req.query?.next);
  if (fromQuery && /^https?:\/\//.test(fromQuery)) {
    return previewId && !fromQuery.includes('preview_theme_id')
      ? `${fromQuery}${fromQuery.includes('?') ? '&' : '?'}preview_theme_id=${encodeURIComponent(previewId)}`
      : fromQuery;
  }
  const fromEnv = clean(process.env.PORTAL_REDIRECT_URL || process.env.PORTAL_BASE_URL);
  let baseUrl;
  if (fromEnv) {
    baseUrl = fromEnv.endsWith('/pages/winkel-portaal')
      ? fromEnv
      : `${fromEnv.replace(/\/$/, '')}/pages/winkel-portaal`;
  } else {
    /* Default: Shopify-storefront op gents-production.myshopify.com.
       (Set-password endpoint draait op Vercel — die hostname willen we NIET
       als redirect-target. De portal staat op het Shopify-domain.) */
    const shopifyDomain = clean(process.env.SHOPIFY_STORE_URL || 'gents-production.myshopify.com').replace(/^https?:\/\//, '').replace(/\/$/, '');
    baseUrl = `https://${shopifyDomain}/pages/winkel-portaal`;
  }
  if (previewId) {
    baseUrl += `${baseUrl.includes('?') ? '&' : '?'}preview_theme_id=${encodeURIComponent(previewId)}`;
  }
  return baseUrl;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderHtmlPage({ title, body, status = 200 }) {
  return `<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)} — GENTS Portaal</title>
  <style>
    * { box-sizing: border-box }
    body { margin:0; padding:32px 16px; min-height:100vh; background:linear-gradient(135deg,#f5f5f2 0%,#e1e6eb 100%); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; color:#0a1f33; display:flex; align-items:flex-start; justify-content:center }
    .card { background:#fff; border:1px solid #e1e6eb; border-radius:18px; padding:32px; max-width:440px; width:100%; box-shadow:0 10px 30px rgba(0,0,0,0.06) }
    .brand { font-size:11px; letter-spacing:.18em; font-weight:700; color:#3a4a5a; text-transform:uppercase; margin-bottom:6px }
    h1 { margin:0 0 8px; font-size:24px; line-height:1.2; font-weight:600 }
    p { margin:0 0 18px; font-size:14px; line-height:1.55; color:#3a4a5a }
    label { display:block; font-size:12px; font-weight:600; letter-spacing:.04em; color:#3a4a5a; margin-bottom:6px; text-transform:uppercase }
    input[type=password], input[type=text], input[type=email] { width:100%; padding:12px 14px; border:1px solid #cbd5e1; border-radius:10px; font-size:15px; font-family:inherit; margin-bottom:16px; outline:none }
    input[type=password]:focus, input[type=text]:focus { border-color:#0a1f33; box-shadow:0 0 0 3px rgba(10,31,51,0.1) }
    button { width:100%; padding:14px; background:#0a1f33; color:#fff; border:0; border-radius:10px; font-size:15px; font-weight:600; cursor:pointer; font-family:inherit }
    button:hover { background:#1a3050 }
    button:disabled { opacity:.5; cursor:not-allowed }
    .err { padding:10px 14px; background:#fef2f2; border:1px solid #fecaca; color:#991b1b; border-radius:8px; font-size:13px; margin-bottom:14px }
    .ok { padding:10px 14px; background:#ecfdf5; border:1px solid #a7f3d0; color:#065f46; border-radius:8px; font-size:13px; margin-bottom:14px }
    .meta { font-size:12px; color:#3a4a5a; padding-top:18px; margin-top:18px; border-top:1px solid #e1e6eb }
    .pwd-hint { font-size:11px; color:#64748b; margin-top:-12px; margin-bottom:14px }
  </style>
</head>
<body>
  <div class="card">
    <div class="brand">GENTS Portaal</div>
    ${body}
  </div>
</body>
</html>`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'GET') {
    const token = clean(req.query.token);
    const user = await findUserByInviteToken(token);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (!user) {
      return res.status(400).end(renderHtmlPage({
        title: 'Ongeldige link',
        body: `<h1>Link is verlopen of ongeldig</h1>
          <p>De uitnodigings-link werkt niet meer. Mogelijke oorzaken:</p>
          <ul style="margin:0 0 18px 18px;padding:0;font-size:13.5px;color:#3a4a5a;line-height:1.6">
            <li>De link is ouder dan 2 dagen.</li>
            <li>De beheerder heeft een nieuwere invite gestuurd — gebruik dan de laatste mail.</li>
            <li>Het wachtwoord is al eerder ingesteld (je kunt gewoon inloggen op het portaal).</li>
          </ul>
          <div style="padding:14px;background:#f5f5f2;border-radius:10px;margin-bottom:16px;border:1px solid #e1e6eb">
            <strong style="display:block;font-size:13px;margin-bottom:6px;color:#0a1f33">Zelf nieuwe invite aanvragen</strong>
            <p style="margin:0 0 12px;font-size:12.5px;color:#3a4a5a;line-height:1.5">Vul je werkmail in en je ontvangt direct een verse link. (Mits het adres bij ons bekend is en je nog geen wachtwoord hebt.)</p>
            <form id="req-form" onsubmit="event.preventDefault(); reqInvite();" style="display:flex;flex-direction:column;gap:8px">
              <input type="email" id="req-email" placeholder="naam@gents.nl" autocomplete="email" required style="padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px">
              <button type="submit" id="req-btn" style="padding:10px;background:#0a1f33;color:#fff;border:0;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">Verstuur nieuwe invite</button>
              <div id="req-msg" style="font-size:12.5px"></div>
            </form>
          </div>
          <p style="font-size:12.5px;color:#3a4a5a">Werkt het nog steeds niet? Vraag de beheerder een nieuwe uitnodiging via <strong>Gebruikers → Reset wachtwoord</strong>.</p>
          <script>
            async function reqInvite() {
              const email = document.getElementById('req-email').value.trim();
              const btn = document.getElementById('req-btn');
              const msg = document.getElementById('req-msg');
              if (!email) return;
              btn.disabled = true; btn.textContent = 'Verzenden…';
              msg.innerHTML = '';
              try {
                const r = await fetch('/api/auth/request-invite', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ email })
                });
                const d = await r.json();
                msg.innerHTML = '<div style="padding:10px 12px;background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46;border-radius:8px;margin-top:8px">' + (d.message || 'Verstuurd — check je inbox.') + '</div>';
              } catch (err) {
                msg.innerHTML = '<div style="padding:10px 12px;background:#fef2f2;border:1px solid #fecaca;color:#991b1b;border-radius:8px;margin-top:8px">Netwerk-fout. Probeer opnieuw.</div>';
              } finally {
                btn.disabled = false; btn.textContent = 'Verstuur nieuwe invite';
              }
            }
          </script>`
      }));
    }
    const portalUrl = getPortalUrl(req);
    return res.status(200).end(renderHtmlPage({
      title: 'Wachtwoord instellen',
      body: `<h1>Welkom, ${escapeHtml(user.name || user.email)}!</h1>
        <p>Stel hieronder je eigen wachtwoord in voor het GENTS Portaal. Minimaal 8 tekens.</p>
        <form id="setpwd-form" method="POST" action="/api/auth/set-password">
          <input type="hidden" name="token" value="${escapeHtml(token)}">
          <input type="hidden" name="next" value="${escapeHtml(portalUrl)}">
          <label for="pwd">Wachtwoord</label>
          <input type="password" id="pwd" name="password" required minlength="8" autocomplete="new-password" autofocus>
          <div class="pwd-hint">Minimaal 8 tekens. Tip: gebruik een zin van 3+ woorden.</div>
          <label for="pwd2">Herhaal wachtwoord</label>
          <input type="password" id="pwd2" name="password2" required minlength="8" autocomplete="new-password">
          <div id="msg"></div>
          <button type="submit" id="btn">Wachtwoord opslaan</button>
        </form>
        <div class="meta">E-mail: <strong>${escapeHtml(user.email)}</strong></div>
        <script>
          const form = document.getElementById('setpwd-form');
          const msg = document.getElementById('msg');
          const btn = document.getElementById('btn');
          const PORTAL_URL = ${JSON.stringify(portalUrl)};
          form.addEventListener('submit', async (e) => {
            e.preventDefault();
            msg.innerHTML = '';
            const pwd = form.password.value;
            const pwd2 = form.password2.value;
            if (pwd !== pwd2) { msg.innerHTML = '<div class="err">Wachtwoorden komen niet overeen.</div>'; return; }
            if (pwd.length < 8) { msg.innerHTML = '<div class="err">Minimaal 8 tekens.</div>'; return; }
            btn.disabled = true; btn.textContent = 'Opslaan…';
            try {
              const r = await fetch('/api/auth/set-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: form.token.value, password: pwd, next: PORTAL_URL })
              });
              const d = await r.json();
              if (d.success) {
                const target = d.redirect || PORTAL_URL;
                msg.innerHTML = '<div class="ok">✓ Wachtwoord opgeslagen — je wordt doorgestuurd naar het portaal…<br><small>Werkt 'm niet? <a href="' + target + '">Klik hier</a></small></div>';
                form.querySelectorAll('input,button').forEach(el => el.disabled = true);
                btn.textContent = 'Doorsturen…';
                setTimeout(() => { window.location.href = target; }, 1500);
              } else {
                msg.innerHTML = '<div class="err">' + (d.message || 'Opslaan mislukt') + '</div>';
                btn.disabled = false; btn.textContent = 'Wachtwoord opslaan';
              }
            } catch (err) {
              msg.innerHTML = '<div class="err">Netwerk-fout: ' + err.message + '</div>';
              btn.disabled = false; btn.textContent = 'Wachtwoord opslaan';
            }
          });
        </script>`
    }));
  }

  if (req.method === 'POST') {
    const body = parseBody(req);
    const token = clean(body.token);
    const password = String(body.password || '');

    if (!token) return res.status(400).json({ success: false, message: 'Token ontbreekt.' });
    if (!password || password.length < 8) return res.status(400).json({ success: false, message: 'Wachtwoord moet minimaal 8 tekens zijn.' });

    try {
      const user = await findUserByInviteToken(token);
      if (!user) return res.status(400).json({ success: false, message: 'Token ongeldig of verlopen. Vraag opnieuw een uitnodiging.' });
      await setUserPassword(user.userId, password);
      await appendAuditEntry({
        actor: user.userId,
        action: 'set-password',
        targetUserId: user.userId,
        targetName: user.name,
        note: 'Wachtwoord ingesteld via invite-token'
      }).catch(() => {});
      /* Redirect-URL bepalen: uit body (next) of fallback naar getPortalUrl(req).
         Veiligheid: alleen redirect naar onze eigen domains / relatieve paths. */
      let redirectUrl = clean(body.next) || getPortalUrl(req);
      if (redirectUrl && /^https?:\/\//.test(redirectUrl)) {
        const allowedHosts = [
          clean(req.headers['x-forwarded-host'] || req.headers.host),
          'gents-production.myshopify.com',
          'gents.nl',
          'www.gents.nl'
        ].filter(Boolean);
        try {
          const u = new URL(redirectUrl);
          if (!allowedHosts.some((h) => u.host === h || u.host.endsWith('.' + h))) {
            redirectUrl = getPortalUrl(req);
          }
        } catch {
          redirectUrl = getPortalUrl(req);
        }
      }
      return res.status(200).json({
        success: true,
        message: 'Wachtwoord opgeslagen. Je kan nu inloggen.',
        userId: user.userId,
        email: user.email,
        redirect: redirectUrl
      });
    } catch (error) {
      console.error('[auth/set-password] error:', error);
      return res.status(500).json({ success: false, message: error.message || 'Opslaan mislukt.' });
    }
  }

  return res.status(405).json({ success: false, message: 'Alleen GET of POST.' });
}
