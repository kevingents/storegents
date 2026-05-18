import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { getAllSegments, createSegment, deleteSegment } from '../../lib/customer-segments-store.js';
import { getAllCustomerNotes } from '../../lib/customer-notes-store.js';
import { getSrsReturnLogs } from '../../lib/srs-return-log-store.js';

/**
 * /api/admin/customer-segments
 *
 * GET                 → lijst alle segmenten + per segment count + sample-customers
 * GET ?segmentId=X    → resolve segment naar lijst klant-keys
 * POST { action: 'create'|'delete', name?, description?, filters?, id? }
 *
 * Filters (configureerbaar per segment):
 *   - tag: string                → klanten met die tag
 *   - hasReturns: boolean        → klanten met >=1 retour
 *   - minReturnCount: number     → klanten met N+ retouren
 *   - withNotes: boolean         → klanten met notities
 *   - newsletterSubscribed: bool → ingeschreven nieuwsbrief
 */

function isAuthorized(req) {
  const adminToken = String(process.env.ADMIN_TOKEN || '').trim();
  if (!adminToken) return true;
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.admin_token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return token === adminToken;
}

function parseBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

function clean(value) { return String(value || '').trim(); }

async function resolveSegment(filters) {
  /* Verzamel alle notes + tags + returns en match per klant-key */
  const notesMap = await getAllCustomerNotes();
  const returnLogs = await getSrsReturnLogs().catch(() => []);

  /* Tel retouren per email (laagste-common-denominator key) */
  const returnsByEmail = new Map();
  (Array.isArray(returnLogs) ? returnLogs : []).forEach((log) => {
    const email = String(log.customerEmail || log.email || '').trim().toLowerCase();
    if (!email) return;
    returnsByEmail.set(email, (returnsByEmail.get(email) || 0) + 1);
  });

  const matches = [];
  /* Loop alle customer-notes keys (= alle klanten met opgeslagen context) */
  for (const [key, data] of Object.entries(notesMap)) {
    const tagLabels = (data.tags || []).map((t) => t.label.toLowerCase());
    const notesCount = (data.notes || []).length;
    const newsletter = data.newsletter?.subscribed;

    let match = true;

    if (filters.tag && !tagLabels.includes(clean(filters.tag).toLowerCase())) match = false;
    if (filters.withNotes && notesCount === 0) match = false;
    if (filters.newsletterSubscribed === true && newsletter !== true) match = false;
    if (filters.newsletterSubscribed === false && newsletter !== false) match = false;

    const retCount = returnsByEmail.get(key.toLowerCase()) || 0;
    if (filters.hasReturns && retCount < 1) match = false;
    if (filters.minReturnCount && retCount < Number(filters.minReturnCount)) match = false;

    if (match) {
      matches.push({
        customerKey: key,
        notesCount,
        tags: data.tags || [],
        retourCount: retCount,
        newsletter: data.newsletter || null
      });
    }
  }

  /* Voeg ook klanten toe die alleen retouren hebben maar geen notes/tags (als hasReturns filter) */
  if (filters.hasReturns || filters.minReturnCount) {
    for (const [email, count] of returnsByEmail) {
      if (filters.minReturnCount && count < Number(filters.minReturnCount)) continue;
      if (matches.find((m) => m.customerKey.toLowerCase() === email)) continue;
      /* Andere filters moeten alsnog voldoen */
      if (filters.tag) continue; /* tag-filter zou al gematcht zijn in notesMap loop */
      if (filters.withNotes) continue;
      matches.push({ customerKey: email, notesCount: 0, tags: [], retourCount: count, newsletter: null });
    }
  }

  return matches;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    if (req.method === 'GET') {
      const segmentId = clean(req.query.segmentId);
      if (segmentId) {
        const all = await getAllSegments();
        const seg = all.find((s) => s.id === segmentId);
        if (!seg) return res.status(404).json({ success: false, message: 'Segment niet gevonden.' });
        const customers = await resolveSegment(seg.filters || {});
        return res.status(200).json({ success: true, segment: seg, count: customers.length, customers });
      }
      const segments = await getAllSegments();
      /* Voor elk segment: snelle count zonder volledige resolve */
      const enriched = await Promise.all(
        segments.map(async (s) => {
          try {
            const c = await resolveSegment(s.filters || {});
            return { ...s, count: c.length };
          } catch { return { ...s, count: null }; }
        })
      );
      return res.status(200).json({ success: true, segments: enriched });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const action = clean(body.action);
      if (action === 'create') {
        const seg = await createSegment({
          name: body.name,
          description: body.description,
          filters: body.filters,
          createdBy: body.createdBy
        });
        return res.status(200).json({ success: true, segment: seg });
      }
      if (action === 'delete') {
        if (!body.id) return res.status(400).json({ success: false, message: 'id ontbreekt.' });
        const ok = await deleteSegment(body.id);
        return res.status(200).json({ success: ok });
      }
      return res.status(400).json({ success: false, message: `Onbekende action: ${action}` });
    }

    return res.status(405).json({ success: false, message: 'Alleen GET en POST.' });
  } catch (error) {
    console.error('[admin/customer-segments]', error);
    return res.status(500).json({ success: false, message: error.message || 'Onbekende fout.' });
  }
}
