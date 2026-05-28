/**
 * POST /api/admin/content-save-description
 *
 * Schrijft een (door de mens goedgekeurde) omschrijving weg naar Shopify als
 * custom.long_description via metafieldsSet. Detecteert het metafield-type uit
 * de definitie; bij rich_text_field wordt platte tekst naar rich-text-JSON
 * omgezet.
 *
 * Body: { productId (gid), description, type? }
 * Auth: admin-token vereist.
 */

import { shopifyGraphql } from '../../lib/shopify-gift-card-client.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

const clean = (v) => String(v == null ? '' : v).trim();

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

async function resolveType() {
  try {
    const d = await shopifyGraphql(
      `query { metafieldDefinitions(first: 1, ownerType: PRODUCT, namespace: "custom", key: "long_description") { nodes { type { name } } } }`
    );
    return d?.metafieldDefinitions?.nodes?.[0]?.type?.name || '';
  } catch { return ''; }
}

/* Platte tekst → Shopify rich_text_field JSON (paragrafen op dubbele newline). */
function toRichText(text) {
  const paras = String(text).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return JSON.stringify({
    type: 'root',
    children: (paras.length ? paras : ['']).map((p) => ({
      type: 'paragraph',
      children: [{ type: 'text', value: p }]
    }))
  });
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    const body = parseBody(req);
    const productId = clean(body.productId);
    const description = clean(body.description);

    if (!/^gid:\/\/shopify\/Product\/\d+/.test(productId)) {
      return res.status(400).json({ success: false, message: 'Ongeldige productId (gid://shopify/Product/… verwacht).' });
    }
    if (!description) {
      return res.status(400).json({ success: false, message: 'Lege omschrijving.' });
    }

    const type = clean(body.type) || (await resolveType()) || 'multi_line_text_field';
    const value = type === 'rich_text_field' ? toRichText(description) : description;

    const data = await shopifyGraphql(
      `mutation Set($m: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $m) {
          metafields { id namespace key type }
          userErrors { field message }
        }
      }`,
      { m: [{ ownerId: productId, namespace: 'custom', key: 'long_description', type, value }] }
    );

    const errs = data?.metafieldsSet?.userErrors || [];
    if (errs.length) throw new Error(errs.map((e) => e.message).join(', '));

    return res.status(200).json({ success: true, type, metafield: data.metafieldsSet.metafields?.[0] || null });
  } catch (e) {
    console.error('[admin/content-save-description]', e);
    return res.status(500).json({ success: false, message: e.message || 'Opslaan mislukt.' });
  }
}
