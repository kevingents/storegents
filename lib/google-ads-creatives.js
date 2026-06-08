/**
 * lib/google-ads-creatives.js
 *
 * Haalt de lopende Google Ads-advertentieteksten (Responsive Search Ads) op via
 * GAQL — koppen + beschrijvingen per advertentie. Voor de merk-fit-score van de
 * advertentie-copy. Read-only. Faalt nooit hard: niet gekoppeld → {ok:false}.
 */

import { gaql, readAdsConfig } from './google-ads-client.js';

const clean = (v) => String(v == null ? '' : v).trim();

/**
 * @param {{limit?:number}} opts
 * @returns {Promise<{ok:boolean, ads:Array, error?:string}>}
 */
export async function getGoogleAdsCreatives({ limit = 25 } = {}) {
  const cfg = readAdsConfig();
  if (!cfg.refreshToken || !cfg.developerToken || !cfg.customerId) {
    return { ok: false, ads: [], error: 'Google Ads niet volledig gekoppeld (refresh-token / developer-token / customer-id).' };
  }

  const query = `SELECT campaign.name, ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.final_urls FROM ad_group_ad WHERE ad_group_ad.status = 'ENABLED' AND campaign.status = 'ENABLED' AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'`;

  try {
    const rows = await gaql(query);
    const ads = [];
    for (const r of rows) {
      const ad = (r.adGroupAd && r.adGroupAd.ad) || {};
      const rsa = ad.responsiveSearchAd || {};
      const heads = (rsa.headlines || []).map((h) => clean(h.text)).filter(Boolean);
      const descs = (rsa.descriptions || []).map((d) => clean(d.text)).filter(Boolean);
      if (!heads.length && !descs.length) continue;
      ads.push({
        id: String(ad.id || ''),
        campaign: clean(r.campaign && r.campaign.name),
        adGroup: clean(r.adGroup && r.adGroup.name),
        headlines: heads,
        descriptions: descs,
        finalUrl: clean((ad.finalUrls || [])[0]),
        text: `Koppen: ${heads.join(' | ')}\nBeschrijvingen: ${descs.join(' | ')}`
      });
      if (ads.length >= limit) break;
    }
    return { ok: true, ads, customerId: cfg.customerId };
  } catch (e) {
    return { ok: false, ads: [], error: e.message || 'Advertentieteksten ophalen mislukte.' };
  }
}
