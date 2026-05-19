/**
 * POST /api/admin/customer/sync-preferences-to-shopify
 * Body: { customerEmail | customerId, dryRun?: boolean }
 *
 * Berekent top maten/kleuren uit SRS-transacties en zet die als Shopify
 * customer tags zodat marketing kan segmenteren ("Klanten met voorkeur
 * maat M", "Klanten die navy kopen", etc.).
 *
 * Tag-conventie:
 *   pref_size_M, pref_size_L, pref_size_42, pref_size_32x34
 *   pref_color_navy, pref_color_zwart
 *   pref_brand_vanguard, pref_brand_cast_iron
 *
 * Ook gem. bonbedrag als segment:
 *   value_segment_low (<€50), value_segment_mid (€50-150), value_segment_high (>€150)
 *
 * Werkwijze:
 *   1. SRS-klant via email of customerId
 *   2. Transacties laatste 2 jaar
 *   3. Top maten/kleuren/merken berekenen
 *   4. Shopify customer GET via email → krijg ID + huidige tags
 *   5. Strip oude pref_* tags, voeg nieuwe toe, PUT
 */

import { handleCors, setCorsHeaders } from '../../../lib/cors.js';
import { getCustomers, getTransactions } from '../../../lib/srs-customers-client.js';

const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';

function isAuthorized(req) {
  const expected = String(process.env.ADMIN_TOKEN || '').trim();
  if (!expected) return true;
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return token === expected;
}

function clean(value) { return String(value || '').trim(); }
function slug(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

function cleanShop(url) {
  return String(url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
}

async function shopifyRequest(path, options = {}) {
  const shop = cleanShop(process.env.SHOPIFY_STORE_URL);
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!shop || !token) throw new Error('Shopify configuratie ontbreekt.');

  const response = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}${path}`, {
    method: options.method || 'GET',
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_e) { data = { raw: text }; }
  if (!response.ok) {
    const err = new Error(data.message || data.error || `Shopify HTTP ${response.status}`);
    err.status = response.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function findShopifyCustomerByEmail(email) {
  if (!email) return null;
  const data = await shopifyRequest(`/customers/search.json?query=email:${encodeURIComponent(email)}`);
  return data.customers?.[0] || null;
}

/**
 * Bereken klant-voorkeuren uit SRS-transacties.
 */
function calculatePreferences(transactions) {
  const sizeMap = new Map();
  const colorMap = new Map();
  const brandMap = new Map();
  let totalAmount = 0;
  let bonCount = 0;

  for (const tx of transactions) {
    const amount = Number(tx.total ?? tx.amount ?? 0);
    if (amount > 0) {
      totalAmount += amount;
      bonCount += 1;
    }
    for (const item of (tx.items || [])) {
      const size = clean(item.size || item.maat || '').toUpperCase();
      const color = clean(item.color || item.kleur || '').toLowerCase();
      const brand = clean(item.brand || item.merk || item.supplierName || '').toLowerCase();
      if (size) sizeMap.set(size, (sizeMap.get(size) || 0) + 1);
      if (color) colorMap.set(color, (colorMap.get(color) || 0) + 1);
      if (brand) brandMap.set(brand, (brandMap.get(brand) || 0) + 1);
    }
  }

  function topN(map, n = 3) {
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([key]) => key);
  }

  const avg = bonCount > 0 ? totalAmount / bonCount : 0;
  let valueSegment = '';
  if (avg > 0) {
    if (avg < 50) valueSegment = 'value_segment_low';
    else if (avg <= 150) valueSegment = 'value_segment_mid';
    else valueSegment = 'value_segment_high';
  }

  return {
    topSizes: topN(sizeMap, 3),
    topColors: topN(colorMap, 3),
    topBrands: topN(brandMap, 3),
    avgAmount: avg,
    bonCount,
    valueSegment
  };
}

function buildTagsForPreferences(prefs) {
  const tags = new Set();
  for (const s of prefs.topSizes || []) {
    const t = slug(s);
    if (t) tags.add(`pref_size_${t}`);
  }
  for (const c of prefs.topColors || []) {
    const t = slug(c);
    if (t) tags.add(`pref_color_${t}`);
  }
  for (const b of prefs.topBrands || []) {
    const t = slug(b);
    if (t) tags.add(`pref_brand_${t}`);
  }
  if (prefs.valueSegment) tags.add(prefs.valueSegment);
  return Array.from(tags);
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const body = parseBody(req);
  const email = clean(body.customerEmail || body.email);
  const customerIdParam = clean(body.customerId);
  const dryRun = Boolean(body.dryRun);

  if (!email && !customerIdParam) {
    return res.status(400).json({ success: false, message: 'customerEmail of customerId verplicht.' });
  }

  try {
    /* 1. SRS klant ophalen */
    let customerId = customerIdParam;
    let srsCustomer = null;
    if (!customerId && email) {
      const r = await getCustomers({ email });
      srsCustomer = r?.customers?.[0] || null;
      customerId = srsCustomer?.customerId || '';
    } else if (customerId) {
      const r = await getCustomers({ customerId });
      srsCustomer = r?.customers?.[0] || null;
    }
    if (!customerId) {
      return res.status(404).json({ success: false, message: 'Klant niet gevonden in SRS.' });
    }

    const resolvedEmail = email || srsCustomer?.email || '';

    /* 2. Transacties laatste 2 jaar */
    const now = new Date();
    const fromDate = new Date(now);
    fromDate.setFullYear(fromDate.getFullYear() - 2);
    const from = `${fromDate.toISOString().slice(0, 10)}T00:00:00`;
    const until = `${now.toISOString().slice(0, 10)}T23:59:59`;
    const txResult = await getTransactions({ customerId, from, until });
    const transactions = txResult?.transactions || [];

    /* Minimum 3 transacties om iets statistisch betekenisvols te taggen */
    if (transactions.length < 3) {
      return res.status(200).json({
        success: true,
        skipped: true,
        reason: `Klant heeft slechts ${transactions.length} transactie(s) — minimum 3 vereist.`,
        customerId,
        transactionCount: transactions.length
      });
    }

    /* 3. Bereken voorkeuren + tags */
    const prefs = calculatePreferences(transactions);
    const newTags = buildTagsForPreferences(prefs);

    if (!newTags.length) {
      return res.status(200).json({
        success: true,
        skipped: true,
        reason: 'Geen voldoende voorkeuren-data om tags te bepalen.',
        customerId,
        preferences: prefs
      });
    }

    /* 4. Shopify klant ophalen */
    if (!resolvedEmail) {
      return res.status(200).json({
        success: true,
        skipped: true,
        reason: 'Geen email beschikbaar — kan niet matchen met Shopify klant.',
        customerId,
        preferences: prefs,
        wouldTag: newTags
      });
    }

    const shopifyCustomer = await findShopifyCustomerByEmail(resolvedEmail);
    if (!shopifyCustomer) {
      return res.status(200).json({
        success: true,
        skipped: true,
        reason: 'Geen Shopify-klant gevonden voor deze email.',
        customerId,
        email: resolvedEmail,
        preferences: prefs,
        wouldTag: newTags
      });
    }

    /* 5. Merge tags: strip oude pref_* en value_segment_*, voeg nieuwe toe */
    const existing = String(shopifyCustomer.tags || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const keepers = existing.filter((t) => !/^pref_(size|color|brand)_/.test(t) && !/^value_segment_/.test(t));
    const finalTags = Array.from(new Set([...keepers, ...newTags])).sort();
    const tagsChanged = JSON.stringify(existing.slice().sort()) !== JSON.stringify(finalTags);

    if (dryRun) {
      return res.status(200).json({
        success: true,
        dryRun: true,
        customerId,
        shopifyCustomerId: shopifyCustomer.id,
        email: resolvedEmail,
        preferences: prefs,
        previousTags: existing,
        nextTags: finalTags,
        added: newTags,
        removed: existing.filter((t) => /^pref_(size|color|brand)_/.test(t) || /^value_segment_/.test(t)),
        changed: tagsChanged
      });
    }

    if (!tagsChanged) {
      return res.status(200).json({
        success: true,
        unchanged: true,
        reason: 'Tags zijn al up-to-date.',
        customerId,
        shopifyCustomerId: shopifyCustomer.id,
        tags: finalTags
      });
    }

    /* 6. PUT tags */
    await shopifyRequest(`/customers/${shopifyCustomer.id}.json`, {
      method: 'PUT',
      body: {
        customer: {
          id: shopifyCustomer.id,
          tags: finalTags.join(', ')
        }
      }
    });

    return res.status(200).json({
      success: true,
      customerId,
      shopifyCustomerId: shopifyCustomer.id,
      email: resolvedEmail,
      preferences: prefs,
      tagsApplied: newTags,
      tagsTotal: finalTags
    });
  } catch (error) {
    console.error('[sync-preferences-to-shopify]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Sync mislukt.'
    });
  }
}
