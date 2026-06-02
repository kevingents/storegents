/**
 * /api/admin/meta-ads-test
 *
 * Verbindingstest voor de Meta (Marketing API) ad-spend-koppeling. Gooit nooit:
 * vertelt welke env-vars aanwezig zijn (zonder de waarden te lekken) + doet een
 * live test-call (ad spend laatste 7 dagen) met een menselijke diagnose.
 */

import { corsJson, requireAdmin } from '../../lib/request-guards.js';
import { getMetaAdsSpend } from '../../lib/meta-ads-spend.js';

export const maxDuration = 30;
const has = (k) => Boolean(String(process.env[k] || '').trim());

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  const config = {
    accessToken: has('META_ADS_ACCESS_TOKEN') || has('META_ACCESS_TOKEN'),
    accountId: has('META_ADS_ACCOUNT_ID') || has('META_AD_ACCOUNT_ID'),
    appSecret: has('META_APP_SECRET'),
    apiVersion: (process.env.META_ADS_API_VERSION || '').trim() || 'v21.0 (default)'
  };

  const to = new Date();
  const from = new Date(to.getTime() - 7 * 86400000);
  const test = await getMetaAdsSpend({ from, to });

  let diagnosis;
  if (!config.accessToken) diagnosis = 'Geen access token — zet META_ADS_ACCESS_TOKEN (System-User-token met ads_read) in Vercel.';
  else if (!config.accountId) diagnosis = 'Geen advertentieaccount — zet META_ADS_ACCOUNT_ID (act_… of de cijfers) in Vercel.';
  else if (!test.ok) diagnosis = `Token + account aanwezig, maar de call faalde: ${test.error} — controleer dat de System User leesrecht op het advertentieaccount heeft en dat het token de ads_read-permissie bevat.`;
  else diagnosis = `Verbinding werkt. Ad spend laatste 7 dagen: € ${Number(test.spend || 0).toFixed(2)} (account ${test.account}).`;

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.status(200).json({
    success: true,
    config,
    test: { ok: test.ok, spend: test.spend, days: test.byDay ? test.byDay.length : 0, error: test.error || null },
    diagnosis
  });
}
