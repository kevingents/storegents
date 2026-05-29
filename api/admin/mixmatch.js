/**
 * /api/admin/mixmatch
 *
 * Beheer van zelf samengestelde Mix & Match-pakketten (custom bundles).
 *
 *   GET                         → { success, pakketten, summary, updatedAt }
 *   POST { action: 'save', ... } → maak/bewerk pakket (id => bewerken)
 *   POST { action: 'delete', id } → verwijder pakket
 *
 * Auth: admin-token vereist.
 */

import { readPakketten, savePakket, deletePakket, summarize } from '../../lib/mixmatch-store.js';
import { assignTemplate, DEFAULT_TEMPLATE_SUFFIX } from '../../lib/mixmatch-publish.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 30;

function readBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === 'string') { try { return JSON.parse(b); } catch { return {}; } }
  return b;
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const { pakketten, updatedAt } = await readPakketten();
      return res.status(200).json({ success: true, pakketten, summary: summarize(pakketten), updatedAt });
    }

    if (req.method === 'POST') {
      const body = readBody(req);
      const action = String(body.action || 'save').toLowerCase();

      if (action === 'delete') {
        const result = await deletePakket(body.id);
        const { pakketten } = await readPakketten();
        return res.status(200).json({ success: true, ...result, summary: summarize(pakketten) });
      }

      /* save (create of update) */
      const pakket = await savePakket(body, 'admin');

      /* Automatisch: actief pakket → ken de Mix & Match-template toe aan de
         component-producten in Shopify (zodat de "koop als pak"-sectie verschijnt).
         Best-effort: een Shopify-fout mag het opslaan niet ongedaan maken. */
      let templateAssign = null;
      if (pakket?.status === 'actief') {
        const ids = (pakket.components || []).map((c) => c.productId).filter(Boolean);
        if (ids.length) {
          templateAssign = await assignTemplate(ids, DEFAULT_TEMPLATE_SUFFIX).catch((e) => ({ error: e.message || 'template-toewijzing faalde', okCount: 0, count: ids.length }));
        }
      }

      const { pakketten } = await readPakketten();
      return res.status(200).json({ success: true, pakket, templateAssign, summary: summarize(pakketten) });
    }

    return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
  } catch (e) {
    console.error('[admin/mixmatch]', e);
    return res.status(400).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
