import { handleCors, setCorsHeaders, requireAdmin } from '../../../lib/cors.js';
import { getDragerCache, saveDragerCache, normalizeDrager, isOpenDrager } from '../../../lib/srs-dragers-store.js';

function key(row = {}) {
  return String(row.dragerId || row.id || row.nummer || row.dragerNummer || row.barcode || row.code || '').trim();
}

function parseRows(input) {
  if (Array.isArray(input)) return input;
  if (Array.isArray(input?.rows)) return input.rows;
  if (Array.isArray(input?.dragers)) return input.dragers;
  if (typeof input?.text === 'string') {
    const text = input.text.trim();
    try {
      const parsed = JSON.parse(text);
      return parseRows(parsed);
    } catch (_error) {
      return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
        const parts = line.split(/[;,\t]/).map((part) => part.trim());
        return {
          dragerId: parts[0],
          store: parts[1],
          status: parts[2] || 'open',
          createdAt: parts[3] || new Date().toISOString(),
          itemCount: parts[4] || 0
        };
      });
    }
  }
  return [];
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST is toegestaan.' });
  if (requireAdmin(req, res)) return;

  try {
    const incoming = parseRows(req.body || {});
    if (!incoming.length) return res.status(400).json({ success: false, message: 'Geen dragers gevonden. Stuur rows/dragers of text mee.' });

    const existing = await getDragerCache();
    const map = new Map();
    [...existing, ...incoming.map(normalizeDrager)].filter(isOpenDrager).forEach((row) => {
      const id = key(row) || `${row.store}-${row.createdAt}-${row.status}`;
      if (id) map.set(id, row);
    });
    const rows = await saveDragerCache(Array.from(map.values()));
    return res.status(200).json({ success: true, imported: incoming.length, openCount: rows.length, rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Dragers konden niet worden geimporteerd.' });
  }
}
