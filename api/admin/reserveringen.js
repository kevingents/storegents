/**
 * GET /api/admin/reserveringen
 *
 * Admin-overzicht van alle reserveringen, gegroepeerd per winkel + aging-
 * statistieken. Optionele filters:
 *   ?store=GENTS+Tilburg       — alleen één winkel
 *   ?status=open|opgehaald|... — filter status (default: 'open')
 *   ?all=1                      — neem ook history mee (oud + afgehandeld)
 *
 * Response:
 *   {
 *     success: true,
 *     totals: { open, opgehaald, verlopen, opgeheven, totalValue },
 *     byStore: [{ store, resBranchId, counts, oldestDays, avgDays, items }],
 *     items: [...]   // flat (gefilterd op store/status)
 *   }
 */

import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { getReserveringen } from '../../lib/reserveringen-store.js';
import { listReserveringBranches, getReserveringBranch } from '../../lib/reserveringen-branch-mapping.js';

function isAuthorized(req) {
  const expected = String(process.env.ADMIN_TOKEN || (globalThis.crypto?.randomUUID?.() || String(Math.random()))).trim();
  const given = String(
    req.headers['x-admin-token'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return Boolean(expected && given && expected === given);
}

function clean(value) { return String(value || '').trim(); }

function daysBetween(iso) {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

function daysUntil(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86400000);
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    const storeFilter = clean(req.query.store);
    const statusFilter = clean(req.query.status);
    const includeAll = String(req.query.all || '') === '1';

    /* Aggregaat-set: standaard-window (open + laatste 30d non-open), ZONDER status-
       of winkel-filter. Cruciaal: het statusfilter mag NIET op het aggregaat —
       anders zou bv. status=opgehaald de 'Open'-kolom én de open-totalen op 0
       zetten, terwijl de KPI-kaarten ("Open totaal", "Waarde open") open tonen. */
    const all = await getReserveringen({ includeAll, limit: 5000 });

    /* Items-lijst voor de tabel: wél op winkel + status gefilterd (een status-
       filter toont álle van die status, zonder 30d-cutoff — vandaar aparte fetch). */
    const items = await getReserveringen({ store: storeFilter, status: statusFilter, includeAll, limit: 5000 });

    /* Aggregaat per winkel (alle winkels uit branch-mapping zodat lege winkels
       ook in de tabel zichtbaar zijn met 0 reserveringen). */
    const byStoreMap = new Map();
    for (const branch of listReserveringBranches()) {
      byStoreMap.set(branch.store, {
        store: branch.store,
        resBranchId: branch.branchId,
        resBranchName: branch.resName,
        counts: { open: 0, opgehaald: 0, verlopen: 0, opgeheven: 0, total: 0 },
        openAgeDays: [],
        totalValueOpen: 0,
        oldestOpen: null,
        verlooptBinnen2Dagen: 0,
        items: []
      });
    }

    for (const r of all) {
      const branch = byStoreMap.get(r.store);
      if (!branch) continue; /* skip onbekende store */
      branch.counts.total += 1;
      const st = String(r.status || '').toLowerCase();
      if (branch.counts[st] !== undefined) branch.counts[st] += 1;
      if (st === 'open') {
        const age = daysBetween(r.createdAt);
        branch.openAgeDays.push(age);
        const itemValue = Number(r.item?.price || 0) * Number(r.item?.quantity || 1);
        branch.totalValueOpen += itemValue;
        if (!branch.oldestOpen || age > daysBetween(branch.oldestOpen.createdAt)) {
          branch.oldestOpen = r;
        }
        const until = daysUntil(r.geldigTot);
        if (until !== null && until <= 2) branch.verlooptBinnen2Dagen += 1;
      }
      branch.items.push(r);
    }

    /* Compute derived stats per branch */
    const byStore = Array.from(byStoreMap.values()).map((b) => ({
      store: b.store,
      resBranchId: b.resBranchId,
      resBranchName: b.resBranchName,
      counts: b.counts,
      openAvgDays: b.openAgeDays.length ? Math.round((b.openAgeDays.reduce((s, x) => s + x, 0) / b.openAgeDays.length) * 10) / 10 : 0,
      openMaxDays: b.openAgeDays.length ? Math.max(...b.openAgeDays) : 0,
      totalValueOpen: Math.round(b.totalValueOpen * 100) / 100,
      verlooptBinnen2Dagen: b.verlooptBinnen2Dagen,
      oldestOpenSku: b.oldestOpen?.item?.sku || '',
      oldestOpenTitle: b.oldestOpen?.item?.title || ''
    })).sort((a, b) => {
      /* Sort: meeste open eerst, daarna alfabetisch */
      if (b.counts.open !== a.counts.open) return b.counts.open - a.counts.open;
      return a.store.localeCompare(b.store, 'nl');
    });

    /* Globale totals */
    const totals = byStore.reduce((acc, s) => {
      acc.open += s.counts.open;
      acc.opgehaald += s.counts.opgehaald;
      acc.verlopen += s.counts.verlopen;
      acc.opgeheven += s.counts.opgeheven;
      acc.totalValueOpen += s.totalValueOpen;
      acc.verlooptBinnen2Dagen += s.verlooptBinnen2Dagen;
      return acc;
    }, { open: 0, opgehaald: 0, verlopen: 0, opgeheven: 0, totalValueOpen: 0, verlooptBinnen2Dagen: 0 });
    totals.totalValueOpen = Math.round(totals.totalValueOpen * 100) / 100;

    /* Verrijk items[] met aging-stats voor frontend display */
    const enrichedItems = items.map((r) => ({
      ...r,
      _ageDays: daysBetween(r.createdAt),
      _daysUntilExpire: daysUntil(r.geldigTot),
      _value: Math.round(Number(r.item?.price || 0) * Number(r.item?.quantity || 1) * 100) / 100
    }));

    return res.status(200).json({
      success: true,
      filters: { store: storeFilter, status: statusFilter, includeAll },
      totals,
      byStore,
      items: enrichedItems,
      count: enrichedItems.length
    });
  } catch (error) {
    console.error('[admin/reserveringen]', error);
    return res.status(500).json({ success: false, message: error.message || 'Reserveringen kunnen niet worden opgebouwd.' });
  }
}
