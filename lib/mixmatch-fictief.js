/**
 * lib/mixmatch-fictief.js
 *
 * Maakt per Mix & Match-pakket één FICTIEF pak-product in Shopify aan — een
 * GEWOON product (geen native bundle). Het dient als adverteer-/landingspagina
 * voor "het pak"; de daadwerkelijke verkoop loopt via de Mix & Match-widget op
 * dat product, die de losse echte producten (colbert/broek/gilet) als aparte
 * regels — met een eigen maat per onderdeel — aan de winkelmand toevoegt.
 *
 * Waarom geen native bundle: een Shopify-bundle dwingt één gedeelde maat af en
 * gaf onduidelijke option-fouten. Een gewoon product met de widget erop laat de
 * klant per onderdeel een maat kiezen én houdt winkelvoorraad/ophalen correct.
 *
 * Het product krijgt:
 *   - titel = pakket-naam, template_suffix 'mix-and-match'
 *   - gecombineerde foto's (colbert + broek + gilet)
 *   - tags: type (2-/3-delig) + 'mix-and-match' + 'pak'
 *   - metafields gents.{mixmatch_code, mixmatch_type, materiaal, samenstelling}
 *   - prijs van de default-variant = som van de onderdelen (richtprijs)
 *   - gepubliceerd op het Online Store-kanaal
 */

import { shopifyGraphql } from './shopify-gift-card-client.js';

const clean = (v) => String(v == null ? '' : v).trim();
const DEFAULT_TEMPLATE_SUFFIX = clean(process.env.MIXMATCH_TEMPLATE_SUFFIX) || 'mix-and-match';

function fmtErrors(errs) {
  return (errs || []).map((e) => {
    const f = Array.isArray(e && e.field) ? e.field.join('.') : clean(e && e.field);
    return f ? `${f}: ${clean(e.message)}` : clean(e && e.message);
  }).filter(Boolean).join(', ');
}

async function onlineStorePublicationId() {
  try {
    const d = await shopifyGraphql(`query{ publications(first:20){ edges { node { id name } } } }`);
    const edges = d?.publications?.edges || [];
    const hit = edges.find((e) => /online store/i.test(clean(e?.node?.name)));
    return hit ? clean(hit.node.id) : null;
  } catch { return null; }
}

/**
 * Maak het fictieve pak-product voor één pakket.
 * @returns {Promise<{created: Array<{type,id,handle}>, errors: string[]}>}
 */
export async function publishPakketFictief(pakket) {
  const comps = Array.isArray(pakket?.components) ? pakket.components : [];
  const byRole = {};
  for (const c of comps) if (c.role && !byRole[c.role]) byRole[c.role] = c;
  const colbert = byRole.colbert;
  const broek = byRole.broek;
  const gilet = byRole.gilet;
  if (!colbert || !broek) {
    return { created: [], errors: ['Colbert en broek zijn vereist voor een fictief pak-product.'] };
  }

  const type = clean(pakket.type) || (gilet ? '3-delig' : '2-delig');
  const baseTitle = clean(pakket.naam) || 'Mix & Match pak';
  const imgs = [...new Set([colbert.image, broek.image, gilet?.image].filter(Boolean))].slice(0, 20);
  const stof = comps.map((c) => c.materiaal).find(Boolean) || '';
  const samen = comps.map((c) => c.samenstelling).find(Boolean) || '';
  const sumPrice = comps.reduce((n, c) => n + (parseFloat(String(c.price || '').replace(',', '.')) || 0), 0);

  try {
    /* 1. Product aanmaken (gewoon product, geen bundle) + foto's in één call. */
    const media = imgs.map((url) => ({ originalSource: url, mediaContentType: 'IMAGE' }));
    const createRes = await shopifyGraphql(
      `mutation($input: ProductInput!, $media: [CreateMediaInput!]){
        productCreate(input:$input, media:$media){
          product { id handle variants(first:1){ nodes { id } } }
          userErrors { field message }
        }
      }`,
      {
        input: {
          title: `${baseTitle} (${type})`,
          productType: 'Pak',
          vendor: clean(colbert.vendor) || 'GENTS',
          status: 'ACTIVE',
          templateSuffix: DEFAULT_TEMPLATE_SUFFIX,
          tags: [type, 'mix-and-match', 'pak']
        },
        media
      }
    );
    const cErrs = createRes?.productCreate?.userErrors || [];
    if (cErrs.length) return { created: [], errors: [`Aanmaken mislukt: ${fmtErrors(cErrs)}`] };
    const product = createRes?.productCreate?.product;
    const productId = clean(product?.id);
    const handle = clean(product?.handle);
    if (!productId) return { created: [], errors: ['Geen product-id na aanmaken.'] };

    const errors = [];

    /* 2. Richtprijs op default-variant = som van de onderdelen. */
    const variantId = clean(product?.variants?.nodes?.[0]?.id);
    if (variantId && sumPrice > 0) {
      const pr = await shopifyGraphql(
        `mutation($pid: ID!, $variants: [ProductVariantsBulkInput!]!){
          productVariantsBulkUpdate(productId:$pid, variants:$variants){ userErrors { field message } }
        }`,
        { pid: productId, variants: [{ id: variantId, price: sumPrice.toFixed(2) }] }
      ).catch((e) => ({ __err: e.message }));
      const prErr = pr?.productVariantsBulkUpdate?.userErrors || [];
      if (pr?.__err || prErr.length) errors.push(`Prijs zetten: ${pr?.__err || fmtErrors(prErr)}`);
    }

    /* 3. Metafields (gents-namespace) zodat de storefront-widget + filters werken. */
    const mf = [
      { key: 'mixmatch_code', value: clean(pakket.code) },
      { key: 'mixmatch_type', value: type },
      { key: 'materiaal', value: stof },
      { key: 'samenstelling', value: samen }
    ].filter((m) => m.value);
    if (mf.length) {
      await shopifyGraphql(
        `mutation($m: [MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ userErrors { message } } }`,
        { m: mf.map((m) => ({ ownerId: productId, namespace: 'gents', key: m.key, type: 'single_line_text_field', value: m.value })) }
      ).catch((e) => errors.push(`Metafields: ${e.message}`));
    }

    /* 4. Publiceren op Online Store-kanaal (anders niet zichtbaar op de webshop). */
    const pubId = await onlineStorePublicationId();
    if (pubId) {
      await shopifyGraphql(
        `mutation($id: ID!, $input: [PublicationInput!]!){ publishablePublish(id:$id, input:$input){ userErrors { field message } } }`,
        { id: productId, input: [{ publicationId: pubId }] }
      ).catch((e) => errors.push(`Publiceren: ${e.message}`));
    } else {
      errors.push('Online Store-kanaal niet gevonden — product staat op actief maar publiceer het evt. handmatig.');
    }

    return { created: [{ type, id: productId, handle }], errors };
  } catch (e) {
    return { created: [], errors: [e.message || 'Onbekende fout bij aanmaken pak-product.'] };
  }
}
