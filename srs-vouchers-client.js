import { put, list } from '@vercel/blob';

const SRS_RETURN_LOG_PATH = 'srs-returns/returns.json';

async function readBlobText(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error('SRS retourlog kon niet worden gelezen.');
  }

  return response.text();
}

export async function getSrsReturnLogs() {
  try {
    const result = await list({
      prefix: SRS_RETURN_LOG_PATH,
      limit: 1
    });

    const blob = result.blobs.find((item) => item.pathname === SRS_RETURN_LOG_PATH);

    if (!blob) {
      return [];
    }

    const raw = await readBlobText(blob.url);
    return JSON.parse(raw || '[]');
  } catch (error) {
    console.error('Read SRS return logs error:', error);
    return [];
  }
}

export async function saveSrsReturnLogs(logs) {
  await put(
    SRS_RETURN_LOG_PATH,
    JSON.stringify(logs, null, 2),
    {
      access: 'public',
      allowOverwrite: true,
      contentType: 'application/json',
      cacheControlMaxAge: 60
    }
  );
}

export async function createSrsReturnLog(input) {
  const logs = await getSrsReturnLogs();

  const log = {
    id: String(Date.now()),
    store: input.store || '',
    employeeName: input.employeeName || '',
    orderNr: input.orderNr || '',
    shopifyOrderId: input.shopifyOrderId || '',
    branchId: input.branchId || '',
    status: input.status || 'unknown',
    success: Boolean(input.success),
    srsTransactionId: input.srsTransactionId || '',
    items: input.items || [],
    message: input.message || '',
    error: input.error || '',
    createdAt: new Date().toISOString()
  };

  logs.unshift(log);
  await saveSrsReturnLogs(logs);

  return log;
}
