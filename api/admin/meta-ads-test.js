/**
 * /api/admin/meta-ads-test
 *
 * Verbindingstest voor de Meta-koppeling (Marketing API + Instagram). Gooit
 * nooit: toont welke env-vars aanwezig zijn (zonder waarden te lekken), doet een
 * live ad-spend-test (laatste 7 dagen), en zoekt je Instagram-business-account-id
 * op (de waarde voor INSTAGRAM_BUSINESS_ID) zodat je 'm niet handmatig hoeft te
 * vinden.
 */

import { corsJson, requireAdmin } from '../../lib/request-guards.js';
import { getMetaAdsSpend } from '../../lib/meta-ads-spend.js';
import { getInstagramToken } from '../../lib/gala-instagram.js';

export const maxDuration = 30;
const has = (k) => Boolean(String(process.env[k] || '').trim());

/* Zoek de IG-business-account(s) achter het token via de gekoppelde pagina's.
   Rapporteert óók hoeveel pagina's het token ziet (om "geen pagina toegewezen"
   te onderscheiden van "pagina zonder gekoppeld IG-account"). */
async function discoverInstagram() {
  const token = getInstagramToken();
  if (!token) return { ok: false, error: 'Geen token gevonden.' };
  const ver = (process.env.META_ADS_API_VERSION || '').trim() || 'v21.0';
  try {
    const url = `https://graph.facebook.com/${ver}/me/accounts?fields=name,id,instagram_business_account{id,username},connected_instagram_account{id,username}&limit=100&access_token=${encodeURIComponent(token)}`;
    const r = await fetch(url);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) return { ok: false, error: (j.error && j.error.message) || `HTTP ${r.status}` };
    const pages = (j.data || []).map((p) => {
      const iba = p.instagram_business_account || p.connected_instagram_account || null;
      return {
        page: p.name || null,
        pageId: p.id || null,
        igBusinessId: iba ? iba.id : null,
        username: iba ? (iba.username || null) : null,
        via: p.instagram_business_account ? 'business' : (p.connected_instagram_account ? 'connected' : null)
      };
    });
    return { ok: true, pageCount: pages.length, pages, accounts: pages.filter((p) => p.igBusinessId) };
  } catch (e) { return { ok: false, error: e.message || 'IG-lookup mislukte.' }; }
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  const config = {
    accessToken: has('META_ADS_ACCESS_TOKEN') || has('META_ACCESS_TOKEN') || has('INSTAGRAM_GRAPH_TOKEN'),
    accountId: has('META_ADS_ACCOUNT_ID') || has('META_AD_ACCOUNT_ID'),
    instagramBusinessId: has('INSTAGRAM_BUSINESS_ID') || has('IG_BUSINESS_ID'),
    appSecret: has('META_APP_SECRET'),
    apiVersion: (process.env.META_ADS_API_VERSION || '').trim() || 'v21.0 (default)'
  };

  const to = new Date();
  const from = new Date(to.getTime() - 7 * 86400000);
  const [spend, ig] = await Promise.all([getMetaAdsSpend({ from, to }), discoverInstagram()]);

  const lines = [];
  if (!config.accessToken) lines.push('Geen access token — zet META_ADS_ACCESS_TOKEN (System-User-token) in Vercel.');
  else {
    /* Ads */
    if (!config.accountId) lines.push('Ad spend: zet META_ADS_ACCOUNT_ID (act_…) voor de POAS.');
    else if (!spend.ok) lines.push(`Ad spend: call faalde — ${spend.error}.`);
    else lines.push(`Ad spend werkt: € ${Number(spend.spend || 0).toFixed(2)} (7 dagen).`);
    /* Instagram */
    if (!ig.ok) lines.push(`Instagram-lookup faalde — ${ig.error} (token mist mogelijk instagram_basic / pages_read_engagement).`);
    else if (!ig.pageCount) lines.push('Token ziet 0 Facebook-pagina\'s → wijs je pagina toe aan de System User (Bedrijfsinstellingen → Systeemgebruikers → Activa toewijzen → Pagina\'s).');
    else if (!ig.accounts.length) lines.push(`Token ziet ${ig.pageCount} pagina('s) [${ig.pages.map((p) => p.page).filter(Boolean).join(', ')}] maar géén gekoppeld IG-account → koppel Instagram op die pagina (Pagina-instellingen → Gekoppelde accounts → Instagram) of koppel de júiste pagina.`);
    else lines.push('Gevonden IG-account(s) → gebruik dit id als INSTAGRAM_BUSINESS_ID: ' + ig.accounts.map((a) => `${a.igBusinessId}${a.username ? ' (@' + a.username + ')' : ''}`).join(', ') + '.');
  }

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.status(200).json({
    success: true,
    config,
    adSpend: { ok: spend.ok, spend: spend.spend, error: spend.error || null },
    instagram: ig,
    diagnosis: lines.join(' ')
  });
}
