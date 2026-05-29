/**
 * lib/mixmatch-bundle.js
 *
 * Maakt fictieve "pak"-producten aan in Shopify via native bundles
 * (productBundleCreate). Per pakket:
 *   - altijd een 2-delig pak (colbert + broek),
 *   - als er een gilet is óók een 3-delig pak (colbert + broek + gilet),
 *   - met één gedeelde maat-optie (colbert=broek[=gilet]), zodat de gilet
 *     binnen de varianten-limiet past,
 *   - gecombineerde foto's, tag 2-delig/3-delig, en een sibling-metafield zodat
 *     de webshop tussen 2- en 3-delig kan switchen.
 *
 * De bundle is een echt product (zichtbaar bij Producten, adverteerbaar) en
 * Shopify boekt de componenten automatisch van voorraad af.
 *
 * Let op: productBundleCreate is async — we pollen de operation tot COMPLETE.
 */

import { shopifyGraphql } from './shopify-gift-card-client.js';

const clean = (v) => String(v == null ? '' : v).trim();
const SHARED_OPTION = 'Maat';
const MAAT_RE = /maat|size/i;

/* Maat-optie (id + waarden) van een product opzoeken. */
async function getMaatOption(productId) {
  const d = await shopifyGraphql(
    `query($id: ID!){ product(id:$id){ id title options { id name optionValues { name } } } }`,
    { id: productId }
  );
  const opts = d?.product?.options || [];
  const maat = opts.find((o) => MAAT_RE.test(o.name)) || opts[0];
  if (!maat) return null;
  return { id: clean(maat.id), name: clean(maat.name), values: (maat.optionValues || []).map((v) => clean(v.name)).filter(Boolean) };
}

function intersect(arrs) {
  if (!arrs.length) return [];
  return arrs.reduce((acc, cur) => acc.filter((v) => cur.includes(v)));
}

async function pollOperation(opId, maxTries = 20) {
  for (let i = 0; i < maxTries; i++) {
    const d = await shopifyGraphql(
      `query($id: ID!){ productOperation(id:$id){ ... on ProductBundleOperation { status product { id handle } userErrors { field message } } } }`,
      { id: opId }
    );
    const op = d?.productOperation || {};
    const status = String(op.status || '').toUpperCase();
    const errs = op.userErrors || [];
    if (errs.length) throw new Error(errs.map((e) => e.message).join(', '));
    if (status === 'COMPLETE' || status === 'COMPLETED') {
      return { id: clean(op.product?.id), handle: clean(op.product?.handle) };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('Bundle-operatie niet binnen de tijd afgerond.');
}

/* Maak één bundle-product met gedeelde maat. comps = [{role, productId}]. */
async function createBundle({ title, comps }) {
  /* Maat-opties ophalen + gemeenschappelijke maten bepalen. */
  const withOpt = [];
  for (const c of comps) {
    const opt = await getMaatOption(c.productId);
    if (!opt || !opt.id) throw new Error(`Geen maat-optie gevonden voor ${c.role} (${c.productId}).`);
    withOpt.push({ ...c, optId: opt.id, values: opt.values });
  }
  const common = intersect(withOpt.map((c) => c.values)).filter(Boolean);
  if (!common.length) throw new Error('Geen gemeenschappelijke maten tussen de onderdelen.');

  const components = withOpt.map((c) => ({
    quantity: 1,
    productId: c.productId,
    optionSelections: [{ componentOptionId: c.optId, name: SHARED_OPTION, values: common }]
  }));

  const d = await shopifyGraphql(
    `mutation($input: ProductBundleCreateInput!){ productBundleCreate(input:$input){ productBundleOperation { id status } userErrors { field message } } }`,
    { input: { title, components } }
  );
  const errs = d?.productBundleCreate?.userErrors || [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join(', '));
  const opId = clean(d?.productBundleCreate?.productBundleOperation?.id);
  if (!opId) throw new Error('Geen operation-id van productBundleCreate.');
  return pollOperation(opId);
}

/* Tags + foto's + sibling-metafield op het aangemaakte bundle-product zetten. */
async function decorateBundle(productId, { tags = [], imageUrls = [], metafields = [] } = {}) {
  if (tags.length) {
    await shopifyGraphql(
      `mutation($id: ID!, $tags: [String!]!){ tagsAdd(id:$id, tags:$tags){ userErrors { message } } }`,
      { id: productId, tags }
    ).catch(() => null);
  }
  const media = [...new Set(imageUrls.filter(Boolean))].slice(0, 20).map((url) => ({ originalSource: url, mediaContentType: 'IMAGE' }));
  if (media.length) {
    await shopifyGraphql(
      `mutation($id: ID!, $media: [CreateMediaInput!]!){ productCreateMedia(productId:$id, media:$media){ mediaUserErrors { message } } }`,
      { id: productId, media }
    ).catch(() => null);
  }
  if (metafields.length) {
    await shopifyGraphql(
      `mutation($m: [MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ userErrors { message } } }`,
      { m: metafields.map((mf) => ({ ownerId: productId, namespace: 'gents', key: mf.key, type: 'single_line_text_field', value: mf.value })) }
    ).catch(() => null);
  }
}

/**
 * Publiceer de bundle-producten voor een pakket. Maakt 2-delig (en 3-delig als
 * er een gilet is) aan, decoreert ze en koppelt ze als siblings.
 * @returns {Promise<{created: Array, errors: Array}>}
 */
export async function publishPakketBundles(pakket) {
  const comps = Array.isArray(pakket?.components) ? pakket.components : [];
  const byRole = {};
  for (const c of comps) if (c.role && !byRole[c.role]) byRole[c.role] = c;
  const colbert = byRole.colbert;
  const broek = byRole.broek;
  const gilet = byRole.gilet;
  if (!colbert?.productId || !broek?.productId) {
    return { created: [], errors: ['Colbert en broek met geldig product-id vereist (productcache vers?).'] };
  }

  const baseTitle = clean(pakket.naam) || 'Mix & Match pak';
  const stof = comps.map((c) => c.materiaal).find(Boolean) || '';
  const samen = comps.map((c) => c.samenstelling).find(Boolean) || '';
  const imgs = [colbert.image, broek.image, gilet?.image].filter(Boolean);
  const metafields = [];
  if (stof) metafields.push({ key: 'materiaal', value: stof });
  if (samen) metafields.push({ key: 'samenstelling', value: samen });

  const created = [];
  const errors = [];

  /* 2-delig */
  try {
    const p = await createBundle({ title: `${baseTitle} (2-delig)`, comps: [{ role: 'colbert', productId: colbert.productId }, { role: 'broek', productId: broek.productId }] });
    await decorateBundle(p.id, { tags: ['2-delig', 'mix-and-match'], imageUrls: [colbert.image, broek.image], metafields });
    created.push({ type: '2-delig', ...p });
  } catch (e) {
    errors.push(`2-delig: ${e.message}`);
  }

  /* 3-delig (alleen als gilet) */
  if (gilet?.productId) {
    try {
      const p = await createBundle({ title: `${baseTitle} (3-delig)`, comps: [{ role: 'colbert', productId: colbert.productId }, { role: 'broek', productId: broek.productId }, { role: 'gilet', productId: gilet.productId }] });
      await decorateBundle(p.id, { tags: ['3-delig', 'mix-and-match'], imageUrls: imgs, metafields });
      created.push({ type: '3-delig', ...p });
    } catch (e) {
      errors.push(`3-delig: ${e.message}`);
    }
  }

  /* Siblings koppelen (voor de 2-/3-delig-switch op de webshop). */
  if (created.length === 2) {
    const [a, b] = created;
    await Promise.all([
      shopifyGraphql(`mutation($m: [MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ userErrors { message } } }`,
        { m: [{ ownerId: a.id, namespace: 'gents', key: 'mixmatch_sibling', type: 'single_line_text_field', value: b.handle }] }).catch(() => null),
      shopifyGraphql(`mutation($m: [MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ userErrors { message } } }`,
        { m: [{ ownerId: b.id, namespace: 'gents', key: 'mixmatch_sibling', type: 'single_line_text_field', value: a.handle }] }).catch(() => null)
    ]);
  }

  return { created, errors };
}
