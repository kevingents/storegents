/**
 * lib/bol-orders.js
 *
 * Verzendbevestiging-bewaking voor bol: leest de OPENSTAANDE bol-orders (FBR =
 * Fulfilment by Retailer) en bepaalt per order de verzend-deadline + urgentie,
 * plus of de artikelen direct uit het magazijn leverbaar zijn. Read-only —
 * schrijft NIETS naar bol. Bedoeld om te zien wat er nog verzonden/bevestigd
 * moet worden voordat bol de order annuleert (de fulfilment zelf loopt via
 * Channable; dit is de controle erop).
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';
import { bolGet, getBolConfig } from './bol-client.js';
import { readProductsCache } from './shopify-products-cache.js';
import { readVoorraadRows } from './srs-voorraad-store.js';
import { listBranchesFromConfig } from './business-config.js';

const PATH = 'marketplace/bol-orders.json';
const MAX_AGE_MS = Number(process.env.BOL_ORDERS_MAX_AGE_MS || 60 * 60 * 1000);
const MAX_PAGES = Number(process.env.BOL_ORDERS_MAX_PAGES || 10);

const clean = (v) => String(v == null ? '' : v).trim();
const num = (v) => { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const skuKey = (v) => clean(v).toLowerCase();

/* Magazijnvoorraad per SKU (zelfde bron als de stock-sync). */
function warehouseStockBySku(rows) {
  const branches = listBranchesFromConfig({ includeInternal: true });
  const warehouseIds = new Set(branches.filter((b) => b.kind === 'warehouse').map((b) => String(b.branchId)));
  const bySku = new Map();
  for (const r of (rows || [])) {
    if (!warehouseIds.has(String(r.filiaalNummer))) continue;
    const k = skuKey(r.sku);
    if (!k) continue;
    bySku.set(k, (bySku.get(k) || 0) + Number(r.voorraad || 0));
  }
  return bySku;
}

function parseDate(s) { const d = new Date(clean(s)); return Number.isNaN(d.getTime()) ? null : d; }

export async function runBolOrders() {
  const cfg = getBolConfig();
  if (!cfg.configured) return { configured: false, reason: `Niet gekoppeld — ontbrekend: ${cfg.missing.join(', ')}` };

  const [cache, voorraadRows] = await Promise.all([
    readProductsCache().catch(() => null),
    readVoorraadRows().catch(() => [])
  ]);
  const byBarcode = (cache && cache.byBarcode) || {};
  const stockBySku = warehouseStockBySku(voorraadRows);

  /* Openstaande FBR-orders ophalen (gepagineerd). Stop pas bij een lege pagina —
     niet op "<50" (dat gokt de page-size). afgekapt=true als we de pagina-limiet
     raken terwijl er nog volle pagina's waren; vervolgpagina-fouten markeren we. */
  const raw = [];
  let afgekapt = false, partieleFout = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    let data;
    try { data = await bolGet('/orders', { query: { status: 'OPEN', 'fulfilment-method': 'FBR' }, page }); }
    catch (e) {
      if (page === 1) return { configured: true, error: e.message || 'Orders-API faalde' };
      partieleFout = e.message || 'Orders-API faalde op een vervolgpagina'; break;
    }
    const list = data?.orders || [];
    if (!list.length) break;
    raw.push(...list);
    if (page === MAX_PAGES && list.length) afgekapt = true;
  }

  const now = Date.now();
  const orders = raw.map((o) => {
    const datum = clean(o.orderPlacedDateTime || o.dateTimeOrderPlaced || o.orderPlacedDate);
    const items = (o.orderItems || o.items || []).map((it) => {
      /* Pak alle mogelijke barcode/EAN-varianten — Bol kan 'ean', 'barcode',
         of 'product.ean/barcode' gebruiken afhankelijk van API-versie. */
      const ean = clean(it.ean || it.barcode || it.product?.ean || it.product?.barcode || it.gtin);
      /* Offer.reference is meestal de retailer-eigen SKU — handig voor lookup
         als de EAN niet in Shopify staat. */
      const offerRef = clean(it.offer?.reference || it.offerReference || it.product?.reference);
      const v = ean ? (byBarcode[ean.toLowerCase()] || null) : null;
      const qty = num(it.quantity) || 1;
      const deadlineStr = clean(it.latestDeliveryDate || it.fulfilment?.latestDeliveryDate || it.exactDeliveryDate || it.fulfilment?.exactDeliveryDate || it.fulfilment?.latestHandoverDateTime);
      const mag = v ? Math.max(0, Math.round(Number(stockBySku.get(skuKey(v.sku)) || 0))) : null;
      return {
        ean,
        barcode: ean, /* alias voor downstream lookups */
        offerReference: offerRef,
        titel: v ? clean(v.title) : clean(it.product?.title || it.title),
        maat: v ? clean(v.size) : '', kleur: v ? clean(v.color) : '',
        qty,
        fulfilmentStatus: clean(it.fulfilmentStatus || it.fulfilment?.status),
        deadline: deadlineStr || null,
        magazijnVoorraad: mag,
        magazijnLeverbaar: mag == null ? null : mag >= qty
      };
    });

    const deadlineMs = items.map((i) => parseDate(i.deadline)).filter(Boolean).map((d) => d.getTime());
    const deadline = deadlineMs.length ? Math.min(...deadlineMs) : null;
    const uurTot = deadline != null ? Math.round((deadline - now) / 3.6e6) : null;
    const urgentie = uurTot == null ? 'onbekend' : uurTot < 0 ? 'teLaat' : uurTot <= 24 ? 'vandaag' : uurTot <= 48 ? 'spoedig' : 'opTijd';
    const magazijnLeverbaar = items.length ? items.every((i) => i.magazijnLeverbaar !== false) : null;
    const magazijnOnbekend = items.some((i) => i.magazijnVoorraad == null);

    return {
      orderId: clean(o.orderId || o.id),
      datum,
      aantalItems: items.reduce((n, i) => n + i.qty, 0),
      items,
      deadline: deadline != null ? new Date(deadline).toISOString() : null,
      uurTotDeadline: uurTot,
      urgentie,
      magazijnLeverbaar,
      magazijnOnbekend
    };
  }).sort((a, b) => (a.uurTotDeadline ?? 1e9) - (b.uurTotDeadline ?? 1e9));

  const result = {
    configured: true,
    refreshedAt: new Date().toISOString(),
    afgekapt, /* true = pagina-limiet geraakt, mogelijk meer open orders dan getoond */
    partieleFout, /* niet-null = een vervolgpagina faalde; lijst is incompleet */
    totaalOpen: orders.length,
    teLaat: orders.filter((o) => o.urgentie === 'teLaat').length,
    vandaag: orders.filter((o) => o.urgentie === 'vandaag').length,
    spoedig: orders.filter((o) => o.urgentie === 'spoedig').length,
    nietLeverbaar: orders.filter((o) => o.magazijnLeverbaar === false).length,
    orders: orders.slice(0, 400)
  };
  try { await writeJsonBlob(PATH, result); } catch (_) {}
  return result;
}

export async function readBolOrders() { return readJsonBlob(PATH, null); }
export function isBolOrdersFresh(d) { return d?.refreshedAt && (Date.now() - new Date(d.refreshedAt).getTime()) < MAX_AGE_MS; }
