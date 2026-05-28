/**
 * POST /api/admin/content-generate-description
 *
 * Genereert een concept product-omschrijving in de GENTS tone-of-voice
 * (brandbook) via de Claude API. Verrijkt de prompt met productvelden uit de
 * Shopify-cache (lookup op productId). Schrijft NIETS weg — alleen concept.
 *
 * Body: { productId?, title?, vendor?, hoofdgroep?, seizoen?, descriptionPlain? }
 * Auth: admin-token vereist.
 */

import { readProductsCache } from '../../lib/shopify-products-cache.js';
import { buildDescriptionSystemPrompt } from '../../lib/brandbook.js';
import { claudeMessage } from '../../lib/claude-client.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

/* Claude-generatie kan 10–20s duren — ruimere functielimiet. */
export const maxDuration = 60;

const clean = (v) => String(v == null ? '' : v).trim();

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    const body = parseBody(req);
    const productId = clean(body.productId);
    let title = clean(body.title);
    let vendor = clean(body.vendor);
    let hoofdgroep = clean(body.hoofdgroep);
    let seizoen = clean(body.seizoen);
    let descriptionPlain = clean(body.descriptionPlain);

    /* Verrijk ontbrekende velden uit de product-cache op productId. */
    if (productId) {
      const cache = await readProductsCache().catch(() => null);
      for (const v of Object.values(cache?.bySku || {})) {
        if (v.productId === productId) {
          title = title || clean(v.title);
          vendor = vendor || clean(v.vendor);
          hoofdgroep = hoofdgroep || clean(v.hoofdgroepOmschrijving) || clean(v.hoofdgroep);
          seizoen = seizoen || clean(v.seizoen);
          descriptionPlain = descriptionPlain || clean(v.descriptionPlain);
          break;
        }
      }
    }

    if (!title) return res.status(400).json({ success: false, message: 'Producttitel ontbreekt.' });

    const system = buildDescriptionSystemPrompt();
    const user = [
      'Schrijf een product-omschrijving voor dit GENTS-artikel:',
      `- Titel: ${title}`,
      vendor ? `- Merk: ${vendor}` : '',
      hoofdgroep ? `- Categorie: ${hoofdgroep}` : '',
      seizoen ? `- Seizoen: ${seizoen}` : '',
      descriptionPlain ? `- Huidige korte omschrijving: ${descriptionPlain}` : ''
    ].filter(Boolean).join('\n');

    const { text, model } = await claudeMessage({ system, user, maxTokens: 500, temperature: 0.7 });

    return res.status(200).json({
      success: true,
      description: text,
      model,
      product: { productId, title, vendor, hoofdgroep, seizoen }
    });
  } catch (e) {
    console.error('[admin/content-generate-description]', e);
    return res.status(500).json({ success: false, message: e.message || 'Generatie mislukt.' });
  }
}
