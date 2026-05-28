const BRANCHES = [
  ['GENTS Almere', '1'],
  ['GENTS Amersfoort', '2'],
  ['GENTS Amsterdam', '15'],
  ['GENTS Antwerpen', '50'],
  ['GENTS Arnhem', '3'],
  ['GENTS Breda', '4'],
  ['GENTS Delft', '5'],
  ['GENTS Den Bosch', '23'],
  ['GENTS Enschede', '8'],
  ['GENTS Groningen', '10'],
  ['GENTS Hilversum', '12'],
  ['GENTS Leiden', '13'],
  ['GENTS Maastricht', '14'],
  ['GENTS Magazijn', '99'],
  ['GENTS Magazijn (Uitlevertafel)', '97'],
  ['GENTS Nijmegen', '16'],
  ['GENTS Rotterdam', '20'],
  ['GENTS Showroom', '700'],
  ['GENTS Tilburg', '17'],
  ['GENTS Utrecht', '18'],
  ['GENTS Zoetermeer', '19'],
  ['GENTS Zwolle', '22'],
  ['Suitconcern', '702'],
  ['Suitconcern magazijn', '704']
];

/* Interne / logistieke filialen — uitsluitend voor naam-labeling van
 * voorraad-data (getStoreNameByBranchId). Bewust NIET in BRANCHES zodat
 * listBranches() (de winkel-lijst) schoon blijft. Spiegelt de
 * webshop/showroom/'admin'-entries in lib/business-config.js. */
const INTERNAL_BRANCHES = new Map([
  ['90',  'GENTS Webshop'],
  ['900', 'GENTS Brandstores'],
  ['100', 'Transfiliaal'],
  ['701', 'Fotoshoot / Uitleen'],
  ['703', 'B2B / Studenten'],
  ['705', 'Extern magazijn'],
  ['706', 'Lost & Found'],
  ['707', 'Klachten / Schade / Herstel'],
  ['708', 'Afkeur / Derving'],
  ['709', 'Sample / Sale'],
  ['98',  'Webretouren magazijn'],
  ['777', 'Reserveringen Showroom'],
  ['502', 'Tijdelijke retouren']
]);

const STORE_ALIASES = new Map([
  ['gents den bosch', 'GENTS Den Bosch'],
  ['gents \'s-hertogenbosch', 'GENTS Den Bosch'],
  ['gents s-hertogenbosch', 'GENTS Den Bosch'],
  ['gents magazijn', 'GENTS Magazijn'],
  ['gents warehouse', 'GENTS Magazijn'],
  ['magazijn', 'GENTS Magazijn'],
  ['uitlevertafel', 'GENTS Magazijn'],
  ['uitlever tafel', 'GENTS Magazijn'],
  ['filiaal 97', 'GENTS Magazijn'],
  ['97', 'GENTS Magazijn'],
  ['99', 'GENTS Magazijn'],
  ['700', 'GENTS Showroom'],
  ['gents showroom', 'GENTS Showroom'],
  ['showroom', 'GENTS Showroom']
]);

function normalizeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeStoreName(store) {
  const key = normalizeKey(store);
  if (!key) return '';

  if (STORE_ALIASES.has(key)) return STORE_ALIASES.get(key);

  const exact = BRANCHES.find(([name]) => normalizeKey(name) === key);
  return exact ? exact[0] : String(store || '').trim();
}

export function listBranches(options = {}) {
  const includeInternal = Boolean(options.includeInternal);

  return BRANCHES
    .filter(([store]) => {
      if (includeInternal) return true;
      return !isWarehouseStore(store) && !normalizeKey(store).includes('showroom');
    })
    .map(([store, branchId]) => ({ store, branchId }));
}

export function listAllBranches() {
  return BRANCHES.map(([store, branchId]) => ({ store, branchId }));
}

export function getBranchIdByStore(store) {
  const normalizedStore = normalizeStoreName(store);
  const key = normalizeKey(normalizedStore);

  const row = BRANCHES.find(([name]) => normalizeKey(name) === key);
  return row ? row[1] : '';
}

export function getStoreNameByBranchId(branchId) {
  const id = String(branchId || '').trim();
  if (id === '99') return 'GENTS Magazijn';
  if (id === '97') return 'GENTS Magazijn-2';   /* uitlevertafel — eigen naam zodat het niet als "GENTS Magazijn" dubbel toont */
  if (id === '700') return 'GENTS Showroom';
  if (INTERNAL_BRANCHES.has(id)) return INTERNAL_BRANCHES.get(id);
  const row = BRANCHES.find(([, value]) => String(value) === id);

  return row ? row[0] : (id ? `Filiaal ${id}` : 'Onbekend');
}

export function getStoreEmail(store) {
  const json = safeJson(process.env.STORE_EMAILS_JSON, {});
  const normalizedStore = normalizeStoreName(store);

  return (
    json[normalizedStore] ||
    json[String(store || '').trim()] ||
    ''
  );
}

export function getRegionManagerEmail(store) {
  const json = safeJson(process.env.REGION_MANAGER_EMAILS_JSON, {});
  const normalizedStore = normalizeStoreName(store);

  return (
    json[normalizedStore] ||
    json[String(store || '').trim()] ||
    process.env.REGIONAL_MANAGER_EMAIL ||
    ''
  );
}

export function isWarehouseStore(store) {
  const value = normalizeKey(store);

  return (
    value.includes('magazijn') ||
    value.includes('warehouse') ||
    value.includes('webshop')
  );
}

export function safeJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch (_error) {
    return fallback;
  }
}

export function clampScore(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

export function calculateOmnichannelScore({
  customerRegistrations = 0,
  loyaltyOptIn = 0,
  voucherIssued = 0,
  voucherUsed = 0,
  voucherFailed = 0,
  labelCreated = 0,
  labelWithTracking = 0,
  unavailableLines = 0,
  cancelledLines = 0,
  failedLines = 0,
  negativeStockLines = 0,
  negativeStockPieces = 0,
  overdueExchangeCount = 0,
  targets = {}
} = {}) {
  const customerTarget = Number(targets.customerTarget || 10);
  const loyaltyTarget = Number(targets.loyaltyTarget || 8);
  const voucherTarget = Number(targets.voucherTarget || 60);
  const labelTarget = Number(targets.labelTarget || 5);

  const customerScore = clampScore(customerTarget ? (Number(customerRegistrations || 0) / customerTarget) * 100 : 0);
  const loyaltyScore = clampScore(loyaltyTarget ? (Number(loyaltyOptIn || 0) / loyaltyTarget) * 100 : 0);

  const base = clampScore((customerScore * 0.6) + (loyaltyScore * 0.4));

  const voucherUsageRate = Number(voucherIssued || 0)
    ? (Number(voucherUsed || 0) / Number(voucherIssued || 0)) * 100
    : 0;

  const voucherScore = clampScore(voucherTarget ? (voucherUsageRate / voucherTarget) * 100 : 0);
  const voucherQualityScore = clampScore(voucherScore - (Number(voucherFailed || 0) * 10));

  const stockQualityScore = clampScore(
    100 -
    (Number(unavailableLines || 0) * 15) -
    (Number(cancelledLines || 0) * 10) -
    (Number(failedLines || 0) * 12) -
    (Number(negativeStockLines || 0) * 4) -
    (Number(negativeStockPieces || 0) * 2)
  );

  const srsOperationalQuality = clampScore(
    100 - (Number(overdueExchangeCount || 0) * 10)
  );

  const labelScore = clampScore(labelTarget ? (Number(labelCreated || 0) / labelTarget) * 100 : 0);
  const trackingScore = Number(labelCreated || 0)
    ? clampScore((Number(labelWithTracking || 0) / Number(labelCreated || 0)) * 100)
    : labelScore;

  const serviceActivity = clampScore((labelScore * 0.7) + (trackingScore * 0.3));

  const score = clampScore(
    (base * 0.35) +
    (stockQualityScore * 0.30) +
    (voucherQualityScore * 0.10) +
    (srsOperationalQuality * 0.10) +
    (serviceActivity * 0.15)
  );

  return {
    score,
    legacyScore: base,
    customerScore,
    loyaltyScore,
    voucherScore,
    labelScore,
    operationalScore: srsOperationalQuality,
    stockQualityScore,
    voucherQualityScore,
    serviceActivity,
    voucherUsageRate: clampScore(voucherUsageRate),
    scoreExplanation: `Basis ${base} · Voorraad ${stockQualityScore} · Vouchers ${voucherQualityScore} · SRS ${srsOperationalQuality} · Service ${serviceActivity}`,
    scoreBreakdown: {
      base,
      stockQuality: stockQualityScore,
      voucherQuality: voucherQualityScore,
      srsOperationalQuality,
      serviceActivity,
      weights: {
        customerLoyaltyBase: '35%',
        stockQuality: '30%',
        voucherQuality: '10%',
        srsOperationalQuality: '10%',
        sendcloudServiceActivity: '15%'
      },
      note: 'Weborders te laat tellen niet mee in voorraadkwaliteit.'
    }
  };
}
