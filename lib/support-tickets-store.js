import { put, list } from '@vercel/blob';

const SUPPORT_TICKETS_PATH = 'support-tickets/tickets.json';

async function readBlobText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Support ticket log kon niet worden gelezen.');
  return response.text();
}

export async function getSupportTickets({ store, employeeName, limit = 200 } = {}) {
  try {
    const result = await list({ prefix: SUPPORT_TICKETS_PATH, limit: 1 });
    const blob = result.blobs.find((item) => item.pathname === SUPPORT_TICKETS_PATH);
    if (!blob) return [];

    const raw = await readBlobText(blob.url);
    let all = [];
    try { all = JSON.parse(raw || '[]'); } catch { all = []; }

    let filtered = all;
    if (store) {
      const wanted = String(store).toLowerCase().trim();
      filtered = filtered.filter((t) => String(t.store || '').toLowerCase().trim() === wanted);
    }
    if (employeeName) {
      const wanted = String(employeeName).toLowerCase().trim();
      filtered = filtered.filter((t) => String(t.employeeName || '').toLowerCase().trim() === wanted);
    }

    return filtered.slice(0, limit);
  } catch (error) {
    console.error('Read support tickets error:', error);
    return [];
  }
}

async function saveAllTickets(tickets) {
  await put(
    SUPPORT_TICKETS_PATH,
    JSON.stringify(tickets, null, 2),
    {
      access: 'public',
      allowOverwrite: true,
      contentType: 'application/json',
      cacheControlMaxAge: 60
    }
  );
}

export async function createSupportTicket(input) {
  const existing = await loadAll();

  const ticket = {
    id: String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8),
    store: String(input.store || '').trim(),
    employeeName: String(input.employeeName || '').trim(),
    subject: String(input.subject || '').trim(),
    description: String(input.description || '').trim(),
    priority: String(input.priority || 'medium').toLowerCase(),
    attachmentUrl: String(input.attachmentUrl || ''),
    attachmentName: String(input.attachmentName || ''),
    status: 'open',
    statusHistory: [{ status: 'open', at: new Date().toISOString() }],
    createdAt: new Date().toISOString()
  };

  existing.unshift(ticket);
  await saveAllTickets(existing);
  return ticket;
}

async function loadAll() {
  try {
    const result = await list({ prefix: SUPPORT_TICKETS_PATH, limit: 1 });
    const blob = result.blobs.find((item) => item.pathname === SUPPORT_TICKETS_PATH);
    if (!blob) return [];
    const raw = await readBlobText(blob.url);
    return JSON.parse(raw || '[]');
  } catch {
    return [];
  }
}

export async function updateSupportTicketStatus(id, status, note) {
  const all = await loadAll();
  const idx = all.findIndex((t) => t.id === id);
  if (idx === -1) return null;

  all[idx].status = String(status || '').toLowerCase();
  all[idx].statusHistory = all[idx].statusHistory || [];
  all[idx].statusHistory.push({
    status: all[idx].status,
    at: new Date().toISOString(),
    note: String(note || '').trim() || undefined
  });
  all[idx].updatedAt = new Date().toISOString();

  await saveAllTickets(all);
  return all[idx];
}
