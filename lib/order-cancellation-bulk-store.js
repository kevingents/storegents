import { getOrderCancellations, saveOrderCancellations, buildIdempotencyKey } from './order-cancellation-store.js';

function clean(value) {
  return String(value || '').trim();
}

function createId() {
  return crypto.randomUUID ? crypto.randomUUID() : `cancel-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function keyFor(input = {}) {
  return input.idempotencyKey || buildIdempotencyKey({
    store: input.store || '',
    orderNr: clean(input.orderNr || input.orderName).replace(/^#/, ''),
    type: input.type === 'full' ? 'full' : 'partial',
    items: Array.isArray(input.items) ? input.items : []
  });
}

export async function addOrderCancellationsBulk(inputs = []) {
  const current = await getOrderCancellations();
  const next = [...current];
  const existingKeys = new Set(current.filter((item) => item.status !== 'failed').map((item) => item.idempotencyKey).filter(Boolean));
  const createdRecords = [];
  const duplicateRecords = [];

  for (const raw of inputs || []) {
    if (!raw || typeof raw !== 'object') continue;
    const idempotencyKey = keyFor(raw);
    const record = {
      ...raw,
      id: raw.id || createId(),
      idempotencyKey
    };

    if (existingKeys.has(idempotencyKey)) {
      const existing = current.find((item) => item.idempotencyKey === idempotencyKey && item.status !== 'failed');
      duplicateRecords.push(existing || record);
      continue;
    }

    existingKeys.add(idempotencyKey);
    createdRecords.push(record);
    next.unshift(record);
  }

  if (createdRecords.length) await saveOrderCancellations(next);

  return {
    success: true,
    created: createdRecords.length,
    duplicates: duplicateRecords.length,
    records: [...createdRecords, ...duplicateRecords],
    createdRecords,
    duplicateRecords
  };
}
