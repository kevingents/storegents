import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const MAIL_LOG_PATH = 'logs/gents-mail-log.json';
const MAX_LOGS = Number(process.env.MAIL_LOG_MAX_ITEMS || 1500);

export async function getMailLogs() {
  const logs = await readJsonBlob(MAIL_LOG_PATH, []);
  return Array.isArray(logs) ? logs : [];
}

export async function saveMailLogs(logs) {
  return writeJsonBlob(MAIL_LOG_PATH, (logs || []).slice(0, MAX_LOGS));
}

export async function createMailLog(input) {
  const logs = await getMailLogs();
  const log = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    type: input.type || 'algemeen',
    store: input.store || '',
    to: input.to || '',
    subject: input.subject || '',
    status: input.status || 'sent',
    providerId: input.providerId || '',
    error: input.error || '',
    meta: input.meta || {}
  };
  logs.unshift(log);
  await saveMailLogs(logs);
  return log;
}
