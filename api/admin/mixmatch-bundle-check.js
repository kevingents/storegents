/**
 * /api/admin/mixmatch-bundle-check   (read-only)
 *
 * Controleert of onze Shopify-app native bundle-producten kan aanmaken
 * (productBundleCreate). Checkt:
 *   - toegekende access scopes (write_products vereist),
 *   - of de mutation productBundleCreate in de API-versie bestaat,
 *   - of Product.bundleComponents bestaat (bundles ingeschakeld).
 *
 * Op basis hiervan bepalen we of het fictief-pak-product automatisch
 * aangemaakt kan worden, of dat er eerst een scope/feature geregeld moet worden.
 *
 * Auth: admin-token vereist.
 */

import { shopifyGraphql } from '../../lib/shopify-gift-card-client.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 30;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  const result = { scopes: [], hasWriteProducts: false, hasProductBundleCreate: false, hasBundleComponents: false };

  try {
    /* 1) Access scopes van de app-installatie. */
    try {
      const s = await shopifyGraphql(`{ currentAppInstallation { accessScopes { handle } } }`);
      result.scopes = (s?.currentAppInstallation?.accessScopes || []).map((x) => x.handle).filter(Boolean);
      result.hasWriteProducts = result.scopes.includes('write_products');
    } catch (e) {
      result.scopesError = e.message || 'scope-check faalde';
    }

    /* 2) Introspectie: bestaat de mutation productBundleCreate + Product.bundleComponents? */
    try {
      const i = await shopifyGraphql(`{
        mutation: __type(name: "Mutation") { fields { name } }
        product: __type(name: "Product") { fields { name } }
      }`);
      const mut = (i?.mutation?.fields || []).map((f) => f.name);
      const prod = (i?.product?.fields || []).map((f) => f.name);
      result.hasProductBundleCreate = mut.includes('productBundleCreate');
      result.hasBundleComponents = prod.includes('bundleComponents');
    } catch (e) {
      result.introspectError = e.message || 'introspectie faalde';
    }

    result.canCreateBundles = result.hasWriteProducts && result.hasProductBundleCreate;
    result.advies = result.canCreateBundles
      ? 'OK — de app kan native bundle-producten aanmaken via de API.'
      : (!result.hasWriteProducts
        ? 'Scope write_products ontbreekt — voeg die toe aan de custom app (Shopify admin → Apps → jouw app → API-scopes), herinstalleer, en check opnieuw.'
        : 'productBundleCreate niet beschikbaar — controleer de API-versie / of bundles op de shop zijn ingeschakeld.');

    return res.status(200).json({ success: true, ...result });
  } catch (e) {
    console.error('[admin/mixmatch-bundle-check]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.', ...result });
  }
}
