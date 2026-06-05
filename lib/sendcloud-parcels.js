/**
 * lib/sendcloud-parcels.js
 *
 * Haalt RECENTE parcels rechtstreeks uit het Sendcloud-account (panel API),
 * inclusief labels die SRS daar heeft aangemaakt (die staan NIET in onze
 * lokale sendcloud-labels blob — die wordt alleen door onze eigen portal-flow
 * gevuld).
 *
 * Wordt gebruikt door bol-shipment-push om bol-orders te matchen op het
 * SRS-gemaakte verzendlabel en de tracking door te zetten naar bol.
 *
 * Match-sleutels (in volgorde van betrouwbaarheid):
 *   1. order_number === SRS-ordernummer (BOL-NNNN)  → exacte match
 *   2. postcode (genormaliseerd) + huisnummer       → adres-match (robuust)
 */

import { sendcloudRequest } from './sendcloud-client.js';

const clean = (v) => String(v == null ? '' : v).trim();

/* Normaliseer postcode: geen spaties, uppercase (NL "1234 AB" → "1234AB"). */
export function normPostal(v) {
  return clean(v).toUpperCase().replace(/\s+/g, '');
}

/* Haal het kale huisnummer uit een string (eerste cijfergroep). */
export function houseNumberOnly(v) {
  const m = clean(v).match(/\d+/);
  return m ? m[0] : '';
}

/* Map Sendcloud-carrier/shipment naar een Bol transporterCode. */
export function sendcloudToBolTransporter(parcel) {
  const carrier = clean(parcel?.carrier?.code || parcel?.carrier).toLowerCase();
  const method = clean(parcel?.shipment?.name || parcel?.shipping_method_checkout_name).toLowerCase();
  const hay = `${carrier} ${method}`;
  if (hay.includes('dhl') && hay.includes('express')) return 'DHL';
  if (hay.includes('dhl') && hay.includes('de')) return 'DHL-DE';
  if (hay.includes('dhl')) return 'DHLFORYOU';
  if (hay.includes('postnl') || hay.includes('post nl')) return 'POSTNL';
  if (hay.includes('dpd')) return 'DPD';
  if (hay.includes('ups')) return 'UPS';
  if (hay.includes('bpost') || hay.includes('belg')) return 'BPOST';
  if (hay.includes('gls')) return 'GLS';
  return 'DHLFORYOU';
}

/* Normaliseer een Sendcloud-parcel naar de velden die we nodig hebben. */
function normalizeParcel(p) {
  return {
    parcelId: clean(p?.id),
    trackingNumber: clean(p?.tracking_number),
    trackingUrl: clean(p?.tracking_url),
    orderNumber: clean(p?.order_number),
    reference: clean(p?.external_reference || p?.reference),
    name: clean(p?.name),
    postalCode: normPostal(p?.postal_code),
    houseNumber: houseNumberOnly(p?.house_number || p?.address_2 || p?.address),
    city: clean(p?.city),
    country: clean(p?.country?.iso_2 || p?.country),
    statusMessage: clean(p?.status?.message),
    carrierCode: clean(p?.carrier?.code),
    shippingMethod: clean(p?.shipment?.name),
    transporterCode: sendcloudToBolTransporter(p),
    createdAt: clean(p?.date_created || p?.created_at)
  };
}

/**
 * Haal recente parcels op (gepagineerd). Standaard de laatste 14 dagen, max
 * `max` parcels. Alleen parcels met een tracking-number zijn bruikbaar.
 *
 * @returns {Promise<Array>} genormaliseerde parcels
 */
export async function fetchRecentParcels({ max = 500 } = {}) {
  const out = [];
  /* Sendcloud /parcels paginate via ?cursor of ?offset. v2 gebruikt
     ?cursor-based pagination (next link). We volgen de 'next' tot leeg of max. */
  let path = '/parcels?ordering=-id';
  let guard = 0;
  while (path && out.length < max && guard < 20) {
    guard += 1;
    let data;
    try {
      data = await sendcloudRequest(path);
    } catch (e) {
      console.warn(`[sendcloud-parcels] fetch faalde (${path}): ${e.message}`);
      break;
    }
    const parcels = Array.isArray(data?.parcels) ? data.parcels : [];
    for (const p of parcels) {
      const n = normalizeParcel(p);
      if (n.trackingNumber) out.push(n);
      if (out.length >= max) break;
    }
    /* Volgende pagina: Sendcloud geeft 'next' als absolute URL of pad. */
    const next = data?.next;
    if (next) {
      /* Strip de base zodat sendcloudRequest het pad accepteert. */
      path = String(next).replace(/^https?:\/\/[^/]+\/api\/v2/, '');
    } else {
      path = null;
    }
  }
  return out;
}

/**
 * Bouw match-indices over een parcels-array:
 *   byOrderNumber: Map<orderNumber, parcel>
 *   byAddress:     Map<`${postcode}::${huisnummer}`, parcel[]>
 * Meest recente parcel wint bij dubbele sleutels.
 */
export function buildParcelMatchIndex(parcels) {
  const byOrderNumber = new Map();
  const byAddress = new Map();
  /* Sorteer oud→nieuw zodat de laatste set() de nieuwste is. */
  const sorted = [...parcels].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  for (const p of sorted) {
    if (p.orderNumber) byOrderNumber.set(p.orderNumber, p);
    if (p.reference) byOrderNumber.set(p.reference, p);
    if (p.postalCode && p.houseNumber) {
      const key = `${p.postalCode}::${p.houseNumber}`;
      const list = byAddress.get(key) || [];
      list.push(p);
      byAddress.set(key, list);
    }
  }
  return { byOrderNumber, byAddress };
}

/**
 * Zoek de beste parcel-match voor een bol-order.
 *
 * @param {Object} index   uit buildParcelMatchIndex
 * @param {Object} order   { srsOrderId, postalCode, houseNumber }
 * @returns {Object|null}  { parcel, matchType }
 */
export function findParcelForOrder(index, { srsOrderId, postalCode, houseNumber } = {}) {
  const srs = clean(srsOrderId);
  /* 1. Exacte order_number / reference match (sterkst). */
  if (srs && index.byOrderNumber.has(srs)) {
    return { parcel: index.byOrderNumber.get(srs), matchType: 'order_number' };
  }
  /* 2. Adres-match (postcode + huisnummer). */
  const pc = normPostal(postalCode);
  const hn = houseNumberOnly(houseNumber);
  if (pc && hn) {
    const list = index.byAddress.get(`${pc}::${hn}`);
    if (list && list.length) {
      /* Meest recente (laatste in lijst na sorteren oud→nieuw). */
      return { parcel: list[list.length - 1], matchType: 'address' };
    }
  }
  return null;
}
