import { put, list } from '@vercel/blob';

async function readBlobText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Blob kon niet worden gelezen.');
  return response.text();
}

export async function readJsonBlob(path, fallback = []) {
  try {
    const result = await list({ prefix: path, limit: 1 });
    const blob = (result.blobs || []).find((item) => item.pathname === path);
    if (!blob) return fallback;
    const raw = await readBlobText(blob.url);
    const parsed = JSON.parse(raw || JSON.stringify(fallback));
    return parsed;
  } catch (error) {
    console.error('readJsonBlob error:', path, error);
    return fallback;
  }
}

export async function writeJsonBlob(path, value) {
  await put(path, JSON.stringify(value, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 30
  });
  return value;
}
