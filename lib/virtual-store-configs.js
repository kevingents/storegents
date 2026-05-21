/**
 * Virtuele winkel-configs.
 *
 * Een virtuele winkel = een entry in de store-switcher die GEEN echte SRS-filiaal
 * is maar een werkomgeving voor specifieke teams (Finance, Students, Suitconcer).
 *
 * Elke config bepaalt:
 *   - Welke pagina's zichtbaar zijn in de admin-shell sidebar
 *   - Welke modals openbaar zijn (data-modal-open knoppen)
 *   - Welke default-page direct opent bij selectie
 *
 * Blob: admin/virtual-store-configs.json
 *
 * Defaults worden onderhouden in code (DEFAULT_CONFIGS) — admin kan ze
 * overschrijven via /api/admin/virtual-store-configs (CRUD).
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const STORE_PATH = 'admin/virtual-store-configs.json';

/* Hardcoded defaults — fall-back als geen Blob-override is ingesteld */
export const DEFAULT_CONFIGS = {
  Finance: {
    key: 'Finance',
    label: 'Finance (declaraties)',
    description: 'Voor finance-team — alleen declaraties + financieel overzicht',
    defaultPage: 'declaraties',
    allowedPages: ['declaraties', 'finance'],
    allowedModals: [
      'declaration-submit',
      'declarations-overview',
      'declarations-admin',
      'admin-mail-log',
      'admin-customer-weekly-report'
    ],
    active: true
  },
  Students: {
    key: 'Students',
    label: 'Students (vereniging-omzet)',
    description: 'Voor het studentenverenigingen-team',
    defaultPage: 'students',
    allowedPages: [
      'students',
      'vereniging-deals',
      'klanten',
      'reserveringen',
      'rapportages'
    ],
    allowedModals: [
      'stock-lookup',
      'reservering-maken',
      'reserveringen-list',
      'label',
      'created-labels',
      'customer-lookup',
      'customer-create'
    ],
    active: true
  },
  Suitconcer: {
    key: 'Suitconcer',
    label: 'Suitconcer (B2B)',
    description: 'B2B-tak — eigen voorraad + orders',
    defaultPage: null, /* gebruikt dashboard met retail-toggle */
    allowedPages: ['dashboard'],
    allowedModals: [
      'sc-voorraad',
      'sc-artikelen',
      'sc-orders',
      'sc-uniek-aanbod',
      'label',
      'created-labels',
      'customer-lookup',
      'admin-mail-log'
    ],
    active: true
  }
};

function clean(v) { return String(v || '').trim(); }

export async function readAllConfigs() {
  const data = await readJsonBlob(STORE_PATH, { configs: {} });
  const stored = data.configs || {};
  /* Merge: gebruik stored override per key, anders default */
  const merged = {};
  for (const [key, def] of Object.entries(DEFAULT_CONFIGS)) {
    merged[key] = { ...def, ...(stored[key] || {}), key };
  }
  /* Plus custom configs die admin heeft toegevoegd buiten DEFAULT_CONFIGS */
  for (const [key, override] of Object.entries(stored)) {
    if (!DEFAULT_CONFIGS[key]) merged[key] = { ...override, key };
  }
  return merged;
}

export async function getConfig(key) {
  if (!key) return null;
  const all = await readAllConfigs();
  return all[clean(key)] || null;
}

export async function upsertConfig(input = {}) {
  const key = clean(input.key);
  if (!key) throw new Error('key is verplicht');
  const data = await readJsonBlob(STORE_PATH, { configs: {} });
  const stored = data.configs || {};
  const existing = stored[key] || {};
  stored[key] = {
    ...existing,
    ...input,
    key,
    allowedPages: Array.isArray(input.allowedPages) ? input.allowedPages.map(clean).filter(Boolean) : (existing.allowedPages || []),
    allowedModals: Array.isArray(input.allowedModals) ? input.allowedModals.map(clean).filter(Boolean) : (existing.allowedModals || []),
    updatedAt: new Date().toISOString()
  };
  await writeJsonBlob(STORE_PATH, { configs: stored, updatedAt: new Date().toISOString() });
  /* Return de gemergde versie (incl. default-fields) */
  const all = await readAllConfigs();
  return all[key];
}

export async function deleteConfigOverride(key) {
  if (!key) return false;
  const k = clean(key);
  const data = await readJsonBlob(STORE_PATH, { configs: {} });
  const stored = data.configs || {};
  if (!(k in stored)) return false;
  delete stored[k];
  await writeJsonBlob(STORE_PATH, { configs: stored, updatedAt: new Date().toISOString() });
  return true;
}

/**
 * Returns list van alle virtuele winkels (met merged config). Voor de admin-UI.
 */
export async function listVirtualStores() {
  const all = await readAllConfigs();
  return Object.values(all).filter((c) => c.active !== false);
}
