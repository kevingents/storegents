/**
 * GET /api/admin/customer-notes/export?format=csv
 *
 * Exporteert alle klant-notities + tags voor admin om te grasduinen.
 * Levert een CSV-bestand met: klant-key, naam (best-effort), notitie-tekst,
 * auteur, datum.
 *
 * Privacy: alleen admin-token. Privacy-statement noemt internal-only.
 */

import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { getAllCustomerNotes } from '../../lib/customer-notes-store.js';

function isAuthorized(req) {
  const expected = String(process.env.ADMIN_TOKEN || '').trim();
  if (!expected) return false; /* Veiligheidsfirst: bij geen token configured, geen export */
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return token === expected;
}

function csvEscape(value) {
  const v = String(value ?? '');
  if (/[",\n\r;]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const format = String(req.query.format || 'csv').toLowerCase();

  try {
    const all = await getAllCustomerNotes();
    const customers = Object.entries(all || {});

    if (format === 'json') {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      return res.status(200).json({
        success: true,
        exportedAt: new Date().toISOString(),
        customerCount: customers.length,
        totalNotes: customers.reduce((sum, [, val]) => sum + (val.notes?.length || 0), 0),
        data: customers.map(([key, val]) => ({
          customerKey: key,
          notes: val.notes || [],
          tags: val.tags || [],
          newsletter: val.newsletter || null,
          updatedAt: val.updatedAt
        }))
      });
    }

    /* CSV-export: 1 rij per notitie */
    const lines = [];
    lines.push(['customer_key', 'tags', 'note_id', 'note_text', 'author', 'created_at', 'updated_at'].join(','));

    for (const [key, val] of customers) {
      const tags = (val.tags || []).map((t) => t.label).join('; ');
      const notes = val.notes || [];
      if (notes.length === 0) {
        /* Klant zonder notities maar met tags meegeven */
        if (tags) {
          lines.push([csvEscape(key), csvEscape(tags), '', '', '', '', csvEscape(val.updatedAt || '')].join(','));
        }
        continue;
      }
      for (const note of notes) {
        lines.push([
          csvEscape(key),
          csvEscape(tags),
          csvEscape(note.id || ''),
          csvEscape(note.text || ''),
          csvEscape(note.author || ''),
          csvEscape(note.createdAt || ''),
          csvEscape(note.updatedAt || '')
        ].join(','));
      }
    }

    /* BOM voor Excel UTF-8 compat */
    const csv = '﻿' + lines.join('\n');
    const filename = `gents-klantnotities-${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).send(csv);
  } catch (error) {
    console.error('[admin/customer-notes/export]', error);
    return res.status(500).json({ success: false, message: error.message || 'Export mislukt.' });
  }
}
