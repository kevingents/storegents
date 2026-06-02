/**
 * lib/pushowl-campaigns-store.js
 *
 * Lokaal logboek van vanuit de portal verstuurde PushOwl-marketing-campagnes,
 * zodat we altijd een overzicht in de tool hebben (ook als PushOwl's read-API
 * niets teruggeeft). Opslag: blob marketing/pushowl-campaigns.json.
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const PATH = 'marketing/pushowl-campaigns.json';

export async function listLoggedCampaigns() {
  const l = await readJsonBlob(PATH, []).catch(() => []);
  return Array.isArray(l) ? l : [];
}

export async function logCampaign(entry = {}) {
  const list = await listLoggedCampaigns();
  const row = {
    id: 'pow-' + Math.random().toString(36).slice(2, 9),
    title: String(entry.title || '').slice(0, 120),
    body: String(entry.body || '').slice(0, 300),
    url: String(entry.url || ''),
    image: String(entry.image || ''),
    segmentTag: String(entry.segmentTag || ''),
    subscriberCount: entry.subscriberCount == null ? null : Number(entry.subscriberCount),
    ok: !!entry.ok,
    campaignId: entry.campaignId || '',
    error: entry.error || '',
    sentAt: new Date().toISOString()
  };
  list.unshift(row);
  await writeJsonBlob(PATH, list.slice(0, 100));
  return row;
}
