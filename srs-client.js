/*
  Vul SRS BranchId's bij voorkeur in via Vercel Environment Variable:

  SRS_BRANCH_MAP_JSON={
    "GENTS Amsterdam": "11",
    "GENTS Leiden": "12"
  }

  Als die env var ontbreekt, gebruikt de code onderstaande fallback.
  Zet hier alleen BranchId's als je ze zeker weet.
*/

const FALLBACK_BRANCH_MAP = {
  "GENTS Brandstores": "",
  "GENTS Almere": "",
  "GENTS Amersfoort": "",
  "GENTS Amsterdam": "",
  "GENTS Antwerpen": "",
  "GENTS Arnhem": "",
  "GENTS Breda": "",
  "GENTS Delft": "",
  "GENTS Den Bosch": "",
  "GENTS Enschede": "",
  "GENTS Groningen": "",
  "GENTS Hilversum": "",
  "GENTS Leiden": "",
  "GENTS Maastricht": "",
  "GENTS Nijmegen": "",
  "GENTS Rotterdam": "",
  "GENTS Tilburg": "",
  "GENTS Utrecht": "",
  "GENTS Zoetermeer": "",
  "GENTS Zwolle": ""
};

export function getSrsBranchMap() {
  const raw = process.env.SRS_BRANCH_MAP_JSON || '';

  if (!raw) {
    return FALLBACK_BRANCH_MAP;
  }

  try {
    return {
      ...FALLBACK_BRANCH_MAP,
      ...JSON.parse(raw)
    };
  } catch (error) {
    throw new Error('SRS_BRANCH_MAP_JSON is geen geldige JSON.');
  }
}

export function getSrsBranchId(storeName) {
  const map = getSrsBranchMap();
  const branchId = map[storeName];

  if (!branchId) {
    throw new Error(`SRS BranchId ontbreekt voor ${storeName}. Vul SRS_BRANCH_MAP_JSON in Vercel in.`);
  }

  return String(branchId);
}
