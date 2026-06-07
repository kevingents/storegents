/**
 * GENTS — Winkel-scope config (welke winkels tellen mee in rapportages & functies)
 * ================================================================================
 * Bron van waarheid voor "welke winkels horen in de cijfers". Default: alle fysieke
 * retail-winkels (kind 'retail' uit business-config). De gebruiker kan dit per winkel
 * overrulen via het Instellingen-menu — bv. Suitconcern (eigen merk/kanaal), webshop
 * of een magazijn uitsluiten, of juist een niet-retail winkel meenemen.
 *
 * Config in de tool (blob), geen Vercel env. Bovenop de vaste branch-list, zodat
 * nieuwe winkels automatisch meekomen met hun default.
 *
 * Blob-shape (config/winkel-scope.json):
 *   { excluded: [branchId|store, ...], included: [branchId|store, ...], updatedAt }
 *   - excluded : retail-winkels die NIET mee mogen (override op default-in)
 *   - included : niet-retail winkels die WEL mee moeten (override op default-uit)
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';
import { listBranchesFromConfig } from './business-config.js';

const STORE_KEY = 'config/winkel-scope.json';

/** Lees de effectieve scope (branch-list × default kind × gebruiker-overrides). */
export async function getWinkelScopeConfig() {
  let stored = {};
  try {
    stored = (await readJsonBlob(STORE_KEY, {})) || {};
  } catch (e) {
    console.error('[winkel-scope-config-store] read:', e.message);
    stored = {};
  }
  const excluded = new Set((stored.excluded || []).map((s) => String(s)));
  const included = new Set((stored.included || []).map((s) => String(s)));
  const branches = listBranchesFromConfig({ includeInternal: true });
  const rows = branches.map((b) => {
    const def = b.kind === 'retail';
    let inScope = def;
    if (excluded.has(String(b.branchId)) || excluded.has(b.store)) inScope = false;
    if (included.has(String(b.branchId)) || included.has(b.store)) inScope = true;
    return { store: b.store, branchId: b.branchId, kind: b.kind, inScope, isDefault: inScope === def };
  });
  return {
    rows,
    inScopeStores: new Set(rows.filter((r) => r.inScope).map((r) => r.store)),
    inScopeBranchIds: new Set(rows.filter((r) => r.inScope).map((r) => String(r.branchId))),
    excluded: [...excluded],
    included: [...included],
    updatedAt: stored.updatedAt || null
  };
}

/** Sla de overrides op (excluded/included als branchId of store-naam). */
export async function saveWinkelScopeConfig({ excluded = [], included = [] } = {}) {
  const next = {
    excluded: [...new Set((excluded || []).map((s) => String(s)).filter(Boolean))],
    included: [...new Set((included || []).map((s) => String(s)).filter(Boolean))],
    updatedAt: new Date().toISOString()
  };
  await writeJsonBlob(STORE_KEY, next);
  return getWinkelScopeConfig();
}

/** Convenience: Set van in-scope store-namen (voor andere libs/endpoints). */
export async function getInScopeStoreNames() {
  return (await getWinkelScopeConfig()).inScopeStores;
}

/** Is deze winkel (op naam) in scope voor rapportages & functies? */
export async function isStoreInScope(storeName) {
  return (await getInScopeStoreNames()).has(String(storeName || '').trim());
}
