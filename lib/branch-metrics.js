function parseBranchMap() {
  const raw = process.env.SRS_BRANCH_MAP_JSON || '';

  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error('SRS_BRANCH_MAP_JSON ongeldig:', error);
    return {};
  }
}

export function getBranchMap() {
  return parseBranchMap();
}

export function getBranchIdByStore(storeName) {
  const map = parseBranchMap();
  return map[storeName] || '';
}

export function getStoreNameByBranchId(branchId) {
  const id = String(branchId || '').trim();
  const map = parseBranchMap();

  const found = Object.entries(map).find(([, value]) => String(value) === id);

  if (found) return found[0];

  const webshopId = String(process.env.SRS_WEBSHOP_BRANCH_ID || '').trim();
  if (webshopId && id === webshopId) return 'Webshop';

  return id ? `Filiaal ${id}` : 'Onbekend';
}

export function listBranches() {
  const map = parseBranchMap();

  return Object.entries(map)
    .map(([store, branchId]) => ({ store, branchId: String(branchId) }))
    .sort((a, b) => a.store.localeCompare(b.store));
}

export function scoreAgainstTarget(value, target) {
  const safeTarget = Number(target || 0);
  if (!safeTarget) return 0;

  return Math.max(0, Math.min(100, Math.round((Number(value || 0) / safeTarget) * 100)));
}

export function calculateOmnichannelScore({
  customerRegistrations = 0,
  loyaltyOptIn = 0,
  voucherIssued = 0,
  voucherUsed = 0,
  labelCreated = 0,
  targets = {}
}) {
  const customerTarget = Number(targets.customerRegistrations || process.env.SCORE_TARGET_CUSTOMER_REGISTRATIONS || 10);
  const loyaltyTarget = Number(targets.loyaltyOptInRate || process.env.SCORE_TARGET_LOYALTY_OPTIN_RATE || 70);
  const voucherTarget = Number(targets.voucherUsageRate || process.env.SCORE_TARGET_VOUCHER_USAGE_RATE || 60);
  const labelTarget = Number(targets.labelCreated || process.env.SCORE_TARGET_LABEL_CREATED || 5);

  const loyaltyRate = customerRegistrations ? Math.round((loyaltyOptIn / customerRegistrations) * 100) : 0;
  const voucherUsageRate = voucherIssued ? Math.round((voucherUsed / voucherIssued) * 100) : 0;

  const customerScore = scoreAgainstTarget(customerRegistrations, customerTarget);
  const loyaltyScore = scoreAgainstTarget(loyaltyRate, loyaltyTarget);
  const voucherScore = voucherIssued ? scoreAgainstTarget(voucherUsageRate, voucherTarget) : 0;
  const labelScore = scoreAgainstTarget(labelCreated, labelTarget);

  const finalScore = Math.round(
    customerScore * 0.35 +
    loyaltyScore * 0.25 +
    voucherScore * 0.25 +
    labelScore * 0.15
  );

  return {
    score: finalScore,
    components: {
      customerScore,
      loyaltyScore,
      voucherScore,
      labelScore,
      customerRegistrations,
      loyaltyOptIn,
      loyaltyRate,
      voucherIssued,
      voucherUsed,
      voucherUsageRate,
      labelCreated
    },
    targets: {
      customerRegistrations: customerTarget,
      loyaltyOptInRate: loyaltyTarget,
      voucherUsageRate: voucherTarget,
      labelCreated: labelTarget
    }
  };
}
