/**
 * /api/admin/inkoop/leveranciers
 *
 * GET    ?source=local|srs|merged (default merged)  → leveranciers-lijst
 *        ?import=1                                   → SRS-historie leveranciers
 *                                                      naar lokale store mergen
 * POST   { id?, name, email, ... }                  → leverancier aanmaken/wijzigen
 * DELETE ?id=...                                     → leverancier verwijderen
 *
 * "merged" combineert de lokale leveranciers-store (met e-mail/contact) met de
 * leveranciers die uit de SRS PurchaseOrders-historie zijn afgeleid, zodat de
 * picker compleet is ook vóórdat je ze lokaal hebt opgeslagen.
 *
 * Auth: admin-token vereist.
 */

import { corsJson, requireAdmin } from '../../../lib/request-guards.js';
import {
  listSuppliers, upsertSupplier, deleteSupplier, mergeSrsSuppliers
} from '../../../lib/inkoop-store.js';
import { getSrsSuppliersFromHistory } from '../../../lib/srs-suppliers.js';

export const maxDuration = 30;

function clean(v) { return String(v == null ? '' : v).trim(); }
function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body;
}
function actorOf(req) {
  return clean(req.headers['x-gents-actor'] || req.query.actor || '') || 'admin';
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'DELETE', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const source = clean(req.query.source || 'merged').toLowerCase();

      /* Eenmalige import: SRS-historie → lokale store. */
      if (clean(req.query.import) === '1') {
        const days = Math.min(Math.max(Number(req.query.days) || 365, 30), 730);
        const srs = await getSrsSuppliersFromHistory({ days }).catch((e) => ({ suppliers: [], error: e.message }));
        const merged = await mergeSrsSuppliers(srs.suppliers || [], actorOf(req));
        const local = await listSuppliers();
        return res.status(200).json({ success: true, imported: merged.added, total: merged.total, suppliers: local });
      }

      if (source === 'srs') {
        const days = Math.min(Math.max(Number(req.query.days) || 365, 30), 730);
        const srs = await getSrsSuppliersFromHistory({ days });
        return res.status(200).json({ success: true, source: 'srs', ...srs });
      }

      const local = await listSuppliers({ activeOnly: clean(req.query.activeOnly) === '1' });
      if (source === 'local') {
        return res.status(200).json({ success: true, source: 'local', count: local.length, suppliers: local });
      }

      /* merged: lokaal + SRS-historie (SRS-only krijgen geen e-mail, maar wel id/naam). */
      let srsSuppliers = [];
      try {
        const srs = await getSrsSuppliersFromHistory({ days: 365 });
        srsSuppliers = srs.suppliers || [];
      } catch (_) { /* SRS-historie optioneel */ }
      const haveSrsId = new Set(local.map((s) => clean(s.srsId)).filter(Boolean));
      const haveName = new Set(local.map((s) => clean(s.name).toLowerCase()));
      const extra = srsSuppliers
        .filter((s) => {
          const id = clean(s.id), name = clean(s.name).toLowerCase();
          return !(id && haveSrsId.has(id)) && !(name && haveName.has(name));
        })
        .map((s) => ({ id: '', srsId: clean(s.id), name: clean(s.name), email: '', active: true, srsOnly: true, orders: s.orders || 0 }));
      const merged = [...local, ...extra].sort((a, b) => String(a.name).localeCompare(String(b.name), 'nl'));
      return res.status(200).json({ success: true, source: 'merged', count: merged.length, localCount: local.length, srsCount: srsSuppliers.length, suppliers: merged });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const saved = await upsertSupplier(body, actorOf(req));
      return res.status(200).json({ success: true, supplier: saved });
    }

    if (req.method === 'DELETE') {
      const id = clean(req.query.id || parseBody(req).id);
      if (!id) return res.status(400).json({ success: false, message: 'id is verplicht.' });
      const removed = await deleteSupplier(id);
      return res.status(200).json({ success: removed, removed });
    }

    return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
  } catch (e) {
    console.error('[admin/inkoop/leveranciers]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
