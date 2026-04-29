function getBranchMap() {
  const raw = process.env.SRS_BRANCH_MAP_JSON || '';

  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    return {};
  }
}

export function getStoreNameByBranchId(branchId) {
  const id = String(branchId || '').trim();

  if (!id) {
    return 'Onbekend';
  }

  const webshopBranchId = String(process.env.SRS_WEBSHOP_BRANCH_ID || '').trim();

  if (webshopBranchId && id === webshopBranchId) {
    return 'Webshop';
  }

  const branchMap = getBranchMap();
  const found = Object.entries(branchMap).find(([, value]) => String(value) === id);

  return found ? found[0] : `Filiaal ${id}`;
}
