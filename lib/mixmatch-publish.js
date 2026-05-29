/**
 * lib/mixmatch-publish.js
 *
 * Publiceer-helpers voor Mix & Match: het Shopify product-template (template_
 * suffix) toewijzen aan pak-producten. Gedeeld door de handmatige actie
 * (/api/admin/mixmatch-assign-template) én het automatisch toewijzen bij het
 * activeren van een pakket (/api/admin/mixmatch save).
 */

import { shopifyGraphql } from './shopify-gift-card-client.js';

const clean = (v) => String(v == null ? '' : v).trim();

/* Default template-suffix (template product.<suffix>). Override via env. */
export const DEFAULT_TEMPLATE_SUFFIX = clean(process.env.MIXMATCH_TEMPLATE_SUFFIX) || 'pakken';

/** Zet template_suffix op een set product-gids. Sequentieel = throttle-vriendelijk. */
export async function assignTemplate(productIds = [], suffix = DEFAULT_TEMPLATE_SUFFIX) {
  const ids = [...new Set((productIds || []).map(clean).filter((g) => /^gid:\/\/shopify\/Product\/\d+/.test(g)))];
  const results = [];
  for (const id of ids) {
    try {
      const d = await shopifyGraphql(
        `mutation($input: ProductInput!){ productUpdate(input: $input){ product { id templateSuffix } userErrors { field message } } }`,
        { input: { id, templateSuffix: suffix } }
      );
      const errs = d?.productUpdate?.userErrors || [];
      if (errs.length) results.push({ id, ok: false, error: errs.map((e) => e.message).join(', ') });
      else results.push({ id, ok: true, templateSuffix: d?.productUpdate?.product?.templateSuffix || suffix });
    } catch (e) {
      results.push({ id, ok: false, error: e.message || 'fout' });
    }
  }
  return { suffix, count: ids.length, okCount: results.filter((r) => r.ok).length, results };
}

/**
 * Voorstel voor de pak-titel op basis van de componenten (colbert leidend).
 * Vervangt "colbert/jasje/blazer" door "Kostuum"; voegt anders "— compleet pak"
 * toe. Bv. "Suitable Colbert Lazio Blauw" → "Suitable Kostuum Lazio Blauw".
 */
export function suggestTitle(components = []) {
  const list = Array.isArray(components) ? components : [];
  const colbert = list.find((c) => c.role === 'colbert') || list[0] || {};
  const base = clean(colbert.title);
  if (!base) return '';
  let t = base.replace(/\b(colberts?|jasjes?|jas|blazers?)\b/gi, 'Kostuum').replace(/\s{2,}/g, ' ').trim();
  if (!/\b(kostuum|pak)\b/i.test(t)) t = `${t} — compleet pak`;
  return t;
}
