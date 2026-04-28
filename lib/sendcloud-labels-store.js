import { put, list } from '@vercel/blob';

const LABELS_PATH = 'sendcloud-labels/labels.json';

async function readBlobText(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error('Labelbestand kon niet worden gelezen.');
  }

  return response.text();
}

export async function getLabels() {
  try {
    const result = await list({
      prefix: LABELS_PATH,
      limit: 1
    });

    const blob = result.blobs.find((item) => item.pathname === LABELS_PATH);

    if (!blob) {
      return [];
    }

    const raw = await readBlobText(blob.url);
    return JSON.parse(raw || '[]');
  } catch (error) {
    console.error('Read Sendcloud labels error:', error);
    return [];
  }
}

export async function saveLabels(labels) {
  await put(
    LABELS_PATH,
    JSON.stringify(labels, null, 2),
    {
      access: 'public',
      allowOverwrite: true,
      contentType: 'application/json',
      cacheControlMaxAge: 60
    }
  );
}

export async function createLabelRecord(input) {
  const labels = await getLabels();

  const record = {
    id: String(Date.now()),
    store: input.store,
    senderStore: input.senderStore || input.store,
    destinationStore: input.destinationStore || '',
    employeeName: input.employeeName || '',
    reference: input.reference || '',
    destinationType: input.destinationType || '',
    recipientName: input.recipientName || '',
    recipientCompany: input.recipientCompany || '',
    recipientCity: input.recipientCity || '',
    recipientPostalCode: input.recipientPostalCode || '',
    parcelId: input.parcelId,
    trackingNumber: input.trackingNumber || '',
    trackingUrl: input.trackingUrl || '',
    labelUrl: input.labelUrl || '',
    shippingMethod: input.shippingMethod || '',
    status: input.status || '',
    directionLabel: input.directionLabel || '',
    createdAt: new Date().toISOString()
  };

  labels.unshift(record);
  await saveLabels(labels);

  return record;
}
