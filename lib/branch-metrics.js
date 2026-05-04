const BRANCHES = [
  ['GENTS Almere', '5'],
  ['GENTS Amersfoort', '6'],
  ['GENTS Amsterdam', '7'],
  ['GENTS Antwerpen', '8'],
  ['GENTS Arnhem', '9'],
  ['GENTS Breda', '10'],
  ['GENTS Delft', '11'],
  ['GENTS Den Bosch', '12'],
  ['GENTS Enschede', '13'],
  ['GENTS Groningen', '14'],
  ['GENTS Hilversum', '15'],
  ['GENTS Leiden', '16'],
  ['GENTS Maastricht', '17'],
  ['GENTS Nijmegen', '18'],
  ['GENTS Rotterdam', '19'],
  ['GENTS Tilburg', '20'],
  ['GENTS Utrecht', '23'],
  ['GENTS Zoetermeer', '24'],
  ['GENTS Zwolle', '25']
];

export function listBranches() {
  return BRANCHES.map(([store, branchId]) => ({ store, branchId }));
}

export function getBranchIdByStore(store) {
  const key = String(store || '').trim().toLowerCase();
  const row = BRANCHES.find(([name]) => String(name).trim().toLowerCase() === key);
  return row ? row[1] : '';
}

export function getStoreNameByBranchId(branchId) {
  const id = String(branchId || '').trim();
  const row = BRANCHES.find(([, value]) => String(value) === id);
  return row ? row[0] : (id ? `Filiaal ${id}` : 'Onbekend');
}

export function getStoreEmail(store) {
  const json = safeJson(process.env.STORE_EMAILS_JSON, {});
  return json[String(store || '').trim()] || '';
}

export function getRegionManagerEmail(store) {
  const json = safeJson(process.env.REGION_MANAGER_EMAILS_JSON, {});
  return json[String(store || '').trim()] || process.env.REGIONAL_MANAGER_EMAIL || '';
}

export function isWarehouseStore(store) {
  const value = String(store || '').toLowerCase();
  return value.includes('magazijn') || value.includes('warehouse') || value.includes('webshop');
}

export function safeJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch (_error) {
    return fallback;
  }
}
