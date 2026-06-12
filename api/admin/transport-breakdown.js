import { getLabels } from '../../lib/sendcloud-labels-store.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

/**
 * GET /api/admin/transport-breakdown
 *
 * Transport-verdeling op basis van de SendCloud-verzendlabels:
 *   - consument vs winkel-onderling (o.b.v. destinationType "Klant"/"Winkel")
 *   - deelzendingen: zelfde consument (naam+postcode) verzonden vanuit ≥2 filialen
 *   - tarief-verdeling: per shippingMethod (aantal, %, totaal- en gemiddelde kosten)
 *
 * Optioneel: ?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD (op createdAt, dateTo inclusief).
 * Read-only — géén geld-acties.
 */

function clean(v) {
  return String(v || '').trim();
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round(v, dec = 2) {
  const f = 10 ** dec;
  return Math.round(num(v) * f) / f;
}

function isAuthorized(req) {
  const adminToken = clean(process.env.ADMIN_TOKEN);
  if (!adminToken) return false;
  const token = clean(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query?.adminToken ||
    req.query?.admin_token ||
    ''
  ).replace(/^Bearer\s+/i, '');
  return token === adminToken;
}

/** consument (naar klant) of winkel (onderlinge uitwisseling). */
function category(label) {
  const t = clean(label.destinationType).toLowerCase();
  if (t.includes('klant') || t.includes('consument') || t.includes('consumer')) return 'consument';
  if (t.includes('winkel') || t.includes('store')) return 'winkel';
  return clean(label.destinationStore) ? 'winkel' : 'consument';
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    let labels = await getLabels();

    const dateFrom = clean(req.query?.dateFrom);
    const dateTo = clean(req.query?.dateTo);
    const from = dateFrom ? new Date(dateFrom) : null;
    const toExclusive = dateTo ? new Date(new Date(dateTo).getTime() + 86400000) : null;
    if (from && !Number.isNaN(from.getTime())) {
      labels = labels.filter((l) => {
        const d = new Date(l.createdAt);
        return Number.isNaN(d.getTime()) || d >= from;
      });
    }
    if (toExclusive && !Number.isNaN(toExclusive.getTime())) {
      labels = labels.filter((l) => {
        const d = new Date(l.createdAt);
        return Number.isNaN(d.getTime()) || d < toExclusive;
      });
    }

    const total = labels.length;
    const pct = (n) => (total ? round((n / total) * 100, 1) : 0);

    const consumentLabels = labels.filter((l) => category(l) === 'consument');
    const winkelLabels = labels.filter((l) => category(l) === 'winkel');

    // ── Deelzendingen: zelfde consument (naam+postcode) vanuit ≥2 verschillende filialen ──
    const byCustomer = {};
    for (const l of consumentLabels) {
      const name = clean(l.recipientName);
      const pc = clean(l.recipientPostalCode);
      const key = `${name}|${pc}`.toLowerCase();
      if (!name && !pc) continue;
      if (!byCustomer[key]) {
        byCustomer[key] = { customer: name || '?', city: clean(l.recipientCity), postalCode: pc, stores: new Set(), shipments: 0 };
      }
      byCustomer[key].stores.add(clean(l.senderStore) || clean(l.store) || '?');
      byCustomer[key].shipments += 1;
    }
    const deelList = Object.values(byCustomer)
      .filter((c) => c.stores.size >= 2)
      .map((c) => ({ customer: c.customer, city: c.city, postalCode: c.postalCode, stores: [...c.stores], shipments: c.shipments }))
      .sort((a, b) => b.stores.length - a.stores.length || b.shipments - a.shipments);

    // ── Tarief-verdeling per verzendmethode ──
    const tarMap = {};
    for (const l of labels) {
      const m = clean(l.shippingMethod) || '(onbekend)';
      if (!tarMap[m]) tarMap[m] = { method: m, count: 0, totalCost: 0 };
      tarMap[m].count += 1;
      tarMap[m].totalCost += num(l.shippingCost);
    }
    const tarieven = Object.values(tarMap)
      .map((t) => ({
        method: t.method,
        count: t.count,
        pct: pct(t.count),
        totalCost: round(t.totalCost),
        avgCost: t.count ? round(t.totalCost / t.count) : 0,
      }))
      .sort((a, b) => b.count - a.count);

    const kostenTotaal = round(labels.reduce((s, l) => s + num(l.shippingCost), 0));

    return res.status(200).json({
      success: true,
      period: { dateFrom: dateFrom || null, dateTo: dateTo || null },
      total,
      consument: { count: consumentLabels.length, pct: pct(consumentLabels.length) },
      winkel: { count: winkelLabels.length, pct: pct(winkelLabels.length) },
      deelzendingen: { count: deelList.length, list: deelList },
      tarieven,
      kosten: { totaal: kostenTotaal, gemiddeld: total ? round(kostenTotaal / total) : 0 },
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[admin/transport-breakdown]', error);
    return res.status(500).json({ success: false, message: error.message || 'Transport-verdeling mislukt.' });
  }
}
