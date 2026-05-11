import { put, list } from '@vercel/blob';

const POINTS_SYNC_LOG_PATH = 'points/points-sync-log.json';
const MAX_LOGS = Number(process.env.POINTS_SYNC_LOG_LIMIT || 1000) || 1000;

async function readBlobText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Spaarpunten sync log kon niet worden gelezen.');
  return response.text();
}

function safeParse(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('Spaarpunten sync log JSON parse error:', error);
    return [];
  }
}

export async function getPointsSyncLogs() {
  try {
    const result = await list({ prefix: POINTS_SYNC_LOG_PATH, limit: 1 });
    const blob = result.blobs.find((item) => item.pathname === POINTS_SYNC_LOG_PATH);
    if (!blob) return [];
    const raw = await readBlobText(blob.url);
    return safeParse(raw);
  } catch (error) {
    console.error('Read points sync logs error:', error);
    return [];
  }
}

export async function savePointsSyncLogs(logs) {
  await put(POINTS_SYNC_LOG_PATH, JSON.stringify(logs.slice(0, MAX_LOGS), null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
}

export async function appendPointsSyncLog(input) {
  const logs = await getPointsSyncLogs();
  const log = {
    id: String(Date.now()) + '-' + Math.random().toString(16).slice(2),
    type: input.type || 'info',
    status: input.status || '',
    message: input.message || '',
    srsCustomerId: input.srsCustomerId || '',
    originalSrsCustomerId: input.originalSrsCustomerId || '',
    pointsBalance: input.pointsBalance ?? '',
    branchId: input.branchId || '',
    branchName: input.branchName || '',
    shopifyCustomerId: input.shopifyCustomerId || '',
    shopifyCustomerEmail: input.shopifyCustomerEmail || '',
    details: input.details || null,
    createdAt: new Date().toISOString()
  };

  logs.unshift(log);
  await savePointsSyncLogs(logs);
  return log;
}
