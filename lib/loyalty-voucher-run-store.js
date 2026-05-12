import { put, list } from '@vercel/blob';

const RUNS_PATH = 'vouchers/loyalty-voucher-runs.json';

async function readBlobText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Loyalty voucher runs konden niet worden gelezen.');
  return response.text();
}

export async function getLoyaltyVoucherRuns() {
  try {
    const result = await list({ prefix: RUNS_PATH, limit: 1 });
    const blob = result.blobs.find((item) => item.pathname === RUNS_PATH);
    if (!blob) return [];

    const raw = await readBlobText(blob.url);
    return JSON.parse(raw || '[]');
  } catch (error) {
    console.error('Read loyalty voucher runs error:', error);
    return [];
  }
}

export async function saveLoyaltyVoucherRuns(runs) {
  await put(RUNS_PATH, JSON.stringify(runs, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
}

export async function createLoyaltyVoucherRun(input) {
  const runs = await getLoyaltyVoucherRuns();

  const run = {
    id: String(Date.now()),
    transactionId: input.transactionId || '',
    reference: input.reference || '',
    status: input.status || '',
    request: input.request || {},
    voucherCount: Number(input.voucherCount || 0),
    vouchers: input.vouchers || [],
    mailStatus: input.mailStatus || {},
    error: input.error || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  runs.unshift(run);
  await saveLoyaltyVoucherRuns(runs);
  return run;
}

export async function updateLoyaltyVoucherRun(transactionId, updates) {
  const runs = await getLoyaltyVoucherRuns();
  const index = runs.findIndex((run) => String(run.transactionId) === String(transactionId));

  if (index === -1) return null;

  runs[index] = {
    ...runs[index],
    ...updates,
    updatedAt: new Date().toISOString()
  };

  await saveLoyaltyVoucherRuns(runs);
  return runs[index];
}

export async function updateLoyaltyVoucherRunById(id, updates) {
  const runs = await getLoyaltyVoucherRuns();
  const index = runs.findIndex((run) => String(run.id) === String(id));

  if (index === -1) return null;

  runs[index] = {
    ...runs[index],
    ...updates,
    updatedAt: new Date().toISOString()
  };

  await saveLoyaltyVoucherRuns(runs);
  return runs[index];
}

export function hasRunForReference(runs, reference) {
  const wanted = String(reference || '').trim();
  if (!wanted) return false;

  // SRS CreateFromLoyaltyPoints is not a harmless preview: once it runs,
  // points can already be converted. Therefore every known run for the same
  // reference is treated as a duplicate guard, including failed GetStatus/logging
  // attempts. Use allowDuplicateReference only for a deliberate manual retry.
  return runs.some((run) => String(run.reference || '').trim() === wanted);
}
