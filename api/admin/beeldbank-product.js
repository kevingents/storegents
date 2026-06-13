import { handleCors, setCorsHeaders } from '../../lib/cors.js';

/**
 * GET /api/admin/beeldbank-product?productId=gid://shopify/Product/123  (of ?handle=...)
 *
 * Volledige product-detail voor de beeldbank: ÁLLE afbeeldingen, ÁLLE metavelden,
 * video's, varianten (kleur/maat/sku) en omschrijving — live uit Shopify (de
 * cache bewaart maar een selectie metavelden). Voor het detail-overzicht +
 * ZIP-download/mailen.
 */

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || '';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_API_TOKEN || '';
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';

export const config = { maxDuration: 30 };

function clean(v) { return String(v == null ? '' : v).trim(); }

function isAuthorized(req) {
  const adminToken = clean(process.env.ADMIN_TOKEN);
  if (!adminToken) return false;
  const token = clean(
    req.headers['x-admin-token'] || req.headers['x-admin-pin'] || req.headers.authorization ||
    req.query?.adminToken || req.query?.admin_token || ''
  ).replace(/^Bearer\s+/i, '');
  return token === adminToken;
}

function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

async function shopifyGraphql(query, variables) {
  const shop = SHOPIFY_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const resp = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Shopify GraphQL ${resp.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  if (json.errors) throw new Error(`Shopify GraphQL: ${JSON.stringify(json.errors).slice(0, 200)}`);
  return json.data;
}

const PRODUCT_FIELDS = `
  id
  title
  handle
  vendor
  productType
  status
  tags
  descriptionHtml
  onlineStoreUrl
  createdAt
  updatedAt
  featuredImage { url }
  images(first: 50) { edges { node { url altText width height } } }
  media(first: 25) { edges { node { mediaContentType ... on Video { sources { url } preview { image { url } } } } } }
  options { name values }
  metafields(first: 100) { edges { node { namespace key value type } } }
  variants(first: 100) { edges { node { title sku barcode price selectedOptions { name value } image { url } } } }
`;

function normalizeProduct(p, shop) {
  if (!p) return null;
  const images = (p.images?.edges || []).map((e) => e?.node).filter((n) => n?.url)
    .map((n) => ({ url: n.url, alt: clean(n.altText), width: n.width || null, height: n.height || null }));
  const videos = (p.media?.edges || []).map((e) => e?.node)
    .filter((n) => n && n.mediaContentType === 'VIDEO' && Array.isArray(n.sources) && n.sources.length)
    .map((n) => ({ url: clean(n.sources[0]?.url), preview: clean(n.preview?.image?.url) }))
    .filter((v) => v.url);
  const metafields = (p.metafields?.edges || []).map((e) => e?.node).filter((n) => n && clean(n.value))
    .map((n) => ({ namespace: clean(n.namespace), key: clean(n.key), value: clean(n.value), type: clean(n.type) }))
    .sort((a, b) => (a.namespace + a.key).localeCompare(b.namespace + b.key, 'nl'));
  const variants = (p.variants?.edges || []).map((e) => e?.node).filter(Boolean).map((v) => ({
    title: clean(v.title), sku: clean(v.sku), barcode: clean(v.barcode), price: clean(v.price),
    options: (v.selectedOptions || []).map((o) => ({ name: clean(o.name), value: clean(o.value) })),
    image: clean(v.image?.url),
  }));
  const optionValues = (name) => (p.options || []).find((o) => new RegExp(name, 'i').test(o.name))?.values || [];
  return {
    id: clean(p.id),
    title: clean(p.title),
    handle: clean(p.handle),
    vendor: clean(p.vendor),
    productType: clean(p.productType),
    status: clean(p.status),
    tags: Array.isArray(p.tags) ? p.tags : clean(p.tags).split(',').map(clean).filter(Boolean),
    descriptionHtml: String(p.descriptionHtml || ''),
    description: stripHtml(p.descriptionHtml),
    url: p.onlineStoreUrl || (p.handle ? `https://${shop}/products/${p.handle}` : ''),
    createdAt: clean(p.createdAt),
    updatedAt: clean(p.updatedAt),
    images,
    imagesCount: images.length,
    videos,
    metafields,
    metafieldsCount: metafields.length,
    options: (p.options || []).map((o) => ({ name: clean(o.name), values: o.values || [] })),
    colors: optionValues('kleur|color'),
    sizes: optionValues('maat|size'),
    variants,
  };
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  if (!SHOPIFY_DOMAIN || !SHOPIFY_TOKEN) {
    return res.status(200).json({ success: false, configured: false, message: 'SHOPIFY_STORE_DOMAIN/TOKEN ontbreekt in Vercel.' });
  }

  const productId = clean(req.query.productId || req.query.id);
  const handle = clean(req.query.handle);
  const shop = SHOPIFY_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');

  try {
    let product = null;
    if (productId) {
      const gid = /^gid:\/\//.test(productId) ? productId : `gid://shopify/Product/${productId.replace(/\D/g, '')}`;
      const data = await shopifyGraphql(`query($id: ID!){ product(id: $id){ ${PRODUCT_FIELDS} } }`, { id: gid });
      product = data?.product || null;
    } else if (handle) {
      const data = await shopifyGraphql(`query($h: String!){ productByHandle(handle: $h){ ${PRODUCT_FIELDS} } }`, { h: handle });
      product = data?.productByHandle || null;
    } else {
      return res.status(400).json({ success: false, message: 'productId of handle is verplicht.' });
    }

    if (!product) return res.status(404).json({ success: false, message: 'Product niet gevonden in Shopify.' });
    return res.status(200).json({ success: true, product: normalizeProduct(product, shop) });
  } catch (error) {
    console.error('[admin/beeldbank-product]', error);
    return res.status(200).json({ success: false, configured: true, message: error.message || 'Product-detail kon niet worden opgehaald.' });
  }
}
