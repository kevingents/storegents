import { put, list } from '@vercel/blob';

const VOUCHER_LOG_PATH = 'vouchers/voucher-log.json';

async function readBlobText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Voucherlog kon niet worden gelezen.');
  return response.text();
}

export async function getVoucherLogs() {
  try {
    const result = await list({ prefix: VOUCHER_LOG_PATH, limit: 1 });
    const blob = result.blobs.find((item) => item.pathname === VOUCHER_LOG_PATH);
    if (!blob) return [];
    const raw = await readBlobText(blob.url);
    return JSON.parse(raw || '[]');
  } catch (error) {
    console.error('Read voucher logs error:', error);
    return [];
  }
}

export async function saveVoucherLogs(logs) {
  await put(VOUCHER_LOG_PATH, JSON.stringify(logs, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
}

export async function createVoucherLog(input) {
  const logs = await getVoucherLogs();

  const log = {
    id: String(Date.now()),
    store: input.store || '',
    employeeName: input.employeeName || '',
    customerName: input.customerName || '',
    customerEmail: input.customerEmail || '',
    srsCustomerId: input.srsCustomerId || '',
    voucherGroupId: input.voucherGroupId || '',
    voucherCode: input.voucherCode || '',
    amount: input.amount || '',
    currency: input.currency || 'EUR',
    validFrom: input.validFrom || '',
    validTo: input.validTo || '',
    mailed: Boolean(input.mailed),
    shopifyEnabled: Boolean(input.shopifyEnabled),
    shopifyGiftCardId: input.shopifyGiftCardId || '',
    shopifyGiftCardLastCharacters: input.shopifyGiftCardLastCharacters || input.shopifyLastCharacters || '',
    shopifyCustomerId: input.shopifyCustomerId || '',
    shopifyOrderId: input.shopifyOrderId || '',
    shopifyOrderName: input.shopifyOrderName || '',
    srsRedeemedAt: input.srsRedeemedAt || '',
    srsRedeemBranchId: input.srsRedeemBranchId || '',
    srsVoucherLockId: input.srsVoucherLockId || '',
    note: input.note || '',
    status: input.status || '',
    error: input.error || '',
    createdAt: new Date().toISOString()
  };

  logs.unshift(log);
  await saveVoucherLogs(logs);
  return log;
}


export async function updateVoucherLogById(id, updates) {
  const logs = await getVoucherLogs();
  const index = logs.findIndex((log) => String(log.id) === String(id));

  if (index === -1) {
    return null;
  }

  logs[index] = {
    ...logs[index],
    ...updates,
    updatedAt: new Date().toISOString()
  };

  await saveVoucherLogs(logs);
  return logs[index];
}

export function findVoucherLogForShopifyGiftCard(logs, giftCardUsage) {
  const giftCardId = String(giftCardUsage.giftCardId || giftCardUsage.id || '').trim();
  const lastCharacters = String(
    giftCardUsage.lastCharacters ||
    giftCardUsage.last_characters ||
    giftCardUsage.lastFour ||
    giftCardUsage.last4 ||
    ''
  ).trim();

  if (giftCardId) {
    const byId = logs.find((log) => String(log.shopifyGiftCardId || '').trim() === giftCardId);
    if (byId) return byId;
  }

  if (lastCharacters) {
    const byLast = logs.find((log) => {
      const storedLast = String(log.shopifyGiftCardLastCharacters || '').trim();
      const codeLast = String(log.voucherCode || '').slice(-lastCharacters.length);
      return storedLast === lastCharacters || codeLast === lastCharacters;
    });

    if (byLast) return byLast;
  }

  return null;
}

