/**
 * lib/poas-compute.js
 *
 * Winstgevendheid van de WEBSHOP (online) per periode, als basis voor POAS:
 *   netto-omzet (na retouren) − inkoopwaarde (COGS) = brutowinst
 *   POAS = brutowinst ÷ advertentiekosten   (de ad spend wordt door de endpoint
 *          toegevoegd; deze lib levert de financiële kant).
 *
 * COGS-join: Shopify-orderregels hebben `sku` (= SRS sku_code); de product-cost-
 * store is óók op sku_code gekeyd → directe match, geen EAN-omweg.
 *
 * Retouren: netto = bruto − restitutie per order. Omdat geretourneerde goederen
 * terug op voorraad komen, schalen we COGS proportioneel mee met de retour-factor
 * (netto/bruto) i.p.v. de volle COGS af te trekken.
 */

import { readProductCost } from './product-cost-store.js';
import { getVerzendkostenConfig } from './verzendkosten-config-store.js';

const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* Gift cards / store-credit (bv. "Returnista Store Credit Gift Card") zijn geen
   productverkopen: ze hebben geen inkoopprijs (100% nep-marge) en horen niet in de
   omzet/winst-analyse of de top-producten. Herkend aan het Shopify gift_card-veld
   of de titel. */
const GIFTCARD_RE = /returnista|store\s*credit|gift\s*card|giftcard|cadeaukaart|tegoedbon/i;
function isGiftCardLine(li) {
  if (li && (li.gift_card === true || li.gift_card === 'true')) return true;
  return GIFTCARD_RE.test(String((li && (li.title || li.name)) || ''));
}

/* Aantal zendingen (= track&traces) van een order. Eén webshop-order kan vanuit
   meerdere winkels verzonden worden → meerdere fulfilments/T&T's, dus we tellen op
   T&T-niveau (niet per order). Fulfilment zonder T&T telt als 1 zending; een fysieke
   order die nog niet verzonden is telt als 1 (conservatief voor de kostenraming). */
function countShipments(order) {
  const fs = (order.fulfillments || []).filter((f) => f && f.status !== 'cancelled');
  let n = 0;
  for (const f of fs) {
    const tns = Array.isArray(f.tracking_numbers) ? f.tracking_numbers.filter(Boolean) : [];
    if (tns.length) n += tns.length;
    else if (f.tracking_number) n += 1;
    else n += 1;
  }
  if (n === 0) {
    const physical = (order.line_items || []).some((li) => !isGiftCardLine(li));
    if (physical) n = 1;
  }
  return n;
}

/* Online Shopify-orders ophalen (cursor-paginatie via Link-header, gecapt). */
async function fetchOnlineOrders({ from, to, maxPages = 8 }) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || '';
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_API_TOKEN || process.env.SHOPIFY_ADMIN_TOKEN || '';
  const apiVersion = process.env.SHOPIFY_API_VERSION || '2025-01';
  if (!domain || !token) return { orders: [], configured: false, truncated: false };
  const fields = 'id,name,created_at,cancelled_at,total_price,refunds,line_items,source_name,tags,fulfillments';
  let url = `https://${domain}/admin/api/${apiVersion}/orders.json?status=any&created_at_min=${new Date(from).toISOString()}&created_at_max=${new Date(to).toISOString()}&limit=250&fields=${fields}`;
  const orders = [];
  let pages = 0, truncated = false;
  while (url && pages < maxPages) {
    const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': token, Accept: 'application/json' } });
    if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`Shopify API ${r.status} — ${t.slice(0, 100)}`); }
    const d = await r.json();
    orders.push(...(d.orders || []));
    pages += 1;
    const link = r.headers.get('link') || r.headers.get('Link') || '';
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : '';
    if (url && pages >= maxPages) truncated = true; /* meer pagina's dan de cap */
  }
  return { orders, configured: true, truncated };
}

/**
 * Bereken de webshop-winstgevendheid voor [from,to] (zonder ad spend).
 * @returns {Promise<object>} { configured, nettoOmzetIncl, nettoOmzetEx, cogs,
 *   brutowinst, margePct, retourBedrag, retourPct, cogsDekkingPct, breakEvenRoas,
 *   orderCount, topWinst, truncated }
 */
export async function computePoasForRange({ from, to }) {
  const [{ orders, configured, truncated }, costDoc, vkCfg] = await Promise.all([
    fetchOnlineOrders({ from, to }),
    readProductCost(),
    getVerzendkostenConfig()
  ]);
  if (!configured) return { configured: false };
  const cost = costDoc.bySku || {};

  let grossInclActive = 0, refundedActive = 0, cancelledCount = 0, orderCount = 0;
  let omzetExGross = 0, cogsGross = 0, lineRevTotal = 0, lineRevMatched = 0;
  let shipmentsTotal = 0, verzendOpbrengstInclActive = 0;
  const winstBySku = new Map();

  for (const o of orders) {
    const tags = String(o.tags || '').split(',').map((t) => t.trim());
    if (tags.includes('gents-offline')) continue; /* offline-bonnen lopen via SRS, niet webshop */
    const refunded = (o.refunds || []).reduce((s, rf) => s + (rf.transactions || []).reduce((ss, tx) => ss + Number(tx.amount || 0), 0), 0);
    if (o.cancelled_at) { cancelledCount += 1; continue; }
    /* Gift cards / store-credit uit de order-omzet halen (geen productverkoop). */
    let giftIncl = 0;
    for (const li of (o.line_items || [])) {
      if (isGiftCardLine(li)) giftIncl += Number(li.price || 0) * Number(li.quantity || 0);
    }
    const total = Math.max(0, Number(o.total_price || 0) - giftIncl);
    grossInclActive += total; refundedActive += refunded; orderCount += 1;

    /* Verzending: aantal zendingen (T&T) × kost; klant-bijdrage onder de drempel. */
    const shp = countShipments(o);
    shipmentsTotal += shp;
    if (shp > 0 && Number(o.total_price || 0) < vkCfg.gratisVanafOrderbedrag) {
      verzendOpbrengstInclActive += vkCfg.klantVerzendtariefIncl;
    }

    for (const li of (o.line_items || [])) {
      if (isGiftCardLine(li)) continue; /* gift card / store-credit — geen product */
      const sku = String(li.sku || '').trim();
      const qty = Number(li.quantity || 0);
      const revIncl = Number(li.price || 0) * qty;
      const c = sku ? cost[sku] : null;
      const btw = (c && Number(c.btw)) || 21;
      const revEx = revIncl / (1 + btw / 100);
      const lineCost = qty * (Number(c?.kostprijs) || 0);
      omzetExGross += revEx; cogsGross += lineCost; lineRevTotal += revIncl;
      if (c && c.kostprijs != null) lineRevMatched += revIncl;
      const w = winstBySku.get(sku || li.title) || { sku, titel: li.title, qty: 0, omzetEx: 0, cogs: 0 };
      w.qty += qty; w.omzetEx += revEx; w.cogs += lineCost; winstBySku.set(sku || li.title, w);
    }
  }

  const netIncl = grossInclActive - refundedActive;
  const returnFactor = grossInclActive > 0 ? netIncl / grossInclActive : 1;
  const nettoOmzetIncl = r2(netIncl);
  const nettoOmzetEx = r2(omzetExGross * returnFactor);
  const cogs = r2(cogsGross * returnFactor);
  const brutowinst = r2(nettoOmzetEx - cogs);
  const margePct = nettoOmzetEx > 0 ? r1((brutowinst / nettoOmzetEx) * 100) : null;
  const retourBedrag = r2(refundedActive);
  const retourPct = grossInclActive > 0 ? r1((refundedActive / grossInclActive) * 100) : null;
  const cogsDekkingPct = lineRevTotal > 0 ? r1((lineRevMatched / lineRevTotal) * 100) : null;
  /* Break-even ROAS: omzet/spend nodig om quitte te spelen = omzet ÷ brutowinst.
     (POAS break-even = 1,0 per definitie: winst = spend.) */
  const breakEvenRoas = brutowinst > 0 ? r2(nettoOmzetEx / brutowinst) : null;

  /* ── Verborgen kosten: verzending (DHL), picking (handling) en transactie (PSP).
     Maakt van brutowinst (productmarge) de echte nettowinst → eerlijke (netto-)POAS.
     Verzendkost = aantal zendingen × kost/zending (aanname, of werkelijk via DHL-API);
     de klant-bijdrage (€ onder de gratis-drempel) gaat eraf. Alles ex BTW; retour-
     factor toegepast op de opbrengst (geretourneerde orders dragen niet meer bij). */
  const verzendkostBrutoEx = r2(shipmentsTotal * vkCfg.verzendkostPerZendingEx);
  const verzendOpbrengstEx = r2((verzendOpbrengstInclActive / (1 + vkCfg.btwPct / 100)) * returnFactor);
  const verzendkostNettoEx = r2(verzendkostBrutoEx - verzendOpbrengstEx);
  const pickingKostEx = r2(orderCount * vkCfg.pickingKostPerOrderEx);
  const transactieKostEx = r2(grossInclActive * (vkCfg.transactieKostPct / 100) + orderCount * vkCfg.transactieKostVastEx);
  const overigeKostenEx = r2(verzendkostNettoEx + pickingKostEx + transactieKostEx);
  const nettowinst = r2(brutowinst - overigeKostenEx);
  const nettoMargePct = nettoOmzetEx > 0 ? r1((nettowinst / nettoOmzetEx) * 100) : null;
  const nettoBreakEvenRoas = nettowinst > 0 ? r2(nettoOmzetEx / nettowinst) : null;
  const verzendkostPerZendingGem = shipmentsTotal > 0 ? r2(verzendkostBrutoEx / shipmentsTotal) : null;

  const topWinst = [...winstBySku.values()]
    .map((w) => ({ sku: w.sku, titel: w.titel, qty: w.qty, winst: r2((w.omzetEx - w.cogs) * returnFactor), margePct: w.omzetEx > 0 ? r1(((w.omzetEx - w.cogs) / w.omzetEx) * 100) : null }))
    .sort((a, b) => b.winst - a.winst).slice(0, 15);

  return {
    configured: true, truncated,
    orderCount, cancelledCount,
    brutoOmzetIncl: r2(grossInclActive),
    nettoOmzetIncl, nettoOmzetEx, cogs, brutowinst, margePct,
    retourBedrag, retourPct, cogsDekkingPct, breakEvenRoas, topWinst,
    /* Verborgen kosten + echte nettowinst (verzending/picking/transactie). */
    shipments: shipmentsTotal,
    verzendkostEx: verzendkostBrutoEx,
    verzendOpbrengstEx,
    verzendkostNettoEx,
    pickingKostEx,
    transactieKostEx,
    overigeKostenEx,
    nettowinst,
    nettoMargePct,
    nettoBreakEvenRoas,
    verzendkostPerZendingGem,
    verzendkostenBron: vkCfg.bron,
    verzendkostenConfig: {
      verzendkostPerZendingEx: vkCfg.verzendkostPerZendingEx,
      pickingKostPerOrderEx: vkCfg.pickingKostPerOrderEx,
      klantVerzendtariefIncl: vkCfg.klantVerzendtariefIncl,
      gratisVanafOrderbedrag: vkCfg.gratisVanafOrderbedrag,
      transactieKostPct: vkCfg.transactieKostPct,
      transactieKostVastEx: vkCfg.transactieKostVastEx
    }
  };
}
