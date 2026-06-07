/**
 * lib/google-oauth-token.js
 *
 * Eén Google OAuth refresh-token voor ALLE Google-diensten (Ads, Analytics,
 * Business Profile). Bron van waarheid: GOOGLE_REFRESH_TOKEN. De oude per-dienst
 * env-vars blijven als fallback werken zodat bestaande koppelingen niet breken.
 *
 * Het token moet geautoriseerd zijn met de scopes die je gebruikt, bv:
 *   https://www.googleapis.com/auth/adwords
 *   https://www.googleapis.com/auth/analytics.readonly
 *   https://www.googleapis.com/auth/business.manage
 */

const clean = (v) => String(v == null ? '' : v).trim();

/** Het gedeelde Google refresh-token (unified veld + fallbacks). */
export function googleRefreshToken() {
  return clean(process.env.GOOGLE_REFRESH_TOKEN)
    || clean(process.env.GOOGLE_ADS_REFRESH_TOKEN)
    || clean(process.env.GOOGLE_BUSINESS_REFRESH_TOKEN)
    || clean(process.env.GOOGLE_ANALYTICS_REFRESH_TOKEN);
}

/** Welke env-var het token leverde — handig voor diagnose. */
export function googleRefreshTokenSource() {
  if (clean(process.env.GOOGLE_REFRESH_TOKEN)) return 'GOOGLE_REFRESH_TOKEN';
  if (clean(process.env.GOOGLE_ADS_REFRESH_TOKEN)) return 'GOOGLE_ADS_REFRESH_TOKEN';
  if (clean(process.env.GOOGLE_BUSINESS_REFRESH_TOKEN)) return 'GOOGLE_BUSINESS_REFRESH_TOKEN';
  if (clean(process.env.GOOGLE_ANALYTICS_REFRESH_TOKEN)) return 'GOOGLE_ANALYTICS_REFRESH_TOKEN';
  return '';
}

/** Gedeelde OAuth-client (Client ID/Secret) met dezelfde fallback-keten. */
export function googleOAuthClient() {
  return {
    clientId: clean(process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_ADS_CLIENT_ID || process.env.GOOGLE_BUSINESS_CLIENT_ID),
    clientSecret: clean(process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_ADS_CLIENT_SECRET || process.env.GOOGLE_BUSINESS_CLIENT_SECRET)
  };
}
