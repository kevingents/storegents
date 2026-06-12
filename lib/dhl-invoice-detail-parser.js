/**
 * lib/dhl-invoice-detail-parser.js
 *
 * Parseert de PER-ZENDING-detailregels van een DHL-factuur (de 60+ pagina's na de
 * samenvatting) om elke zending op ROUTE te classificeren op basis van de échte
 * van- en naar-postcode:
 *   - magazijn → winkel   (afzender = magazijn 1101AJ, ontvanger = een GENTS-winkel)
 *   - winkel → winkel      (afzender = winkel, ontvanger = winkel)
 *   - naar consument        (ontvanger = geen GENTS-locatie)
 *
 * SendCloud geeft de afzender niet terug; de DHL-factuur wél (van-postcode →
 * naar-postcode per zending). De afzender-postcode is altijd een GENTS-locatie,
 * dus de set van alle van-postcodes ÍS de set GENTS-locaties; het magazijn is
 * 1101AJ (Lemelerbergweg 15, Amsterdam).
 *
 * Kosten per route worden afgeleid van de service-gemiddelden uit de samenvatting
 * (serviceTotaal / serviceAantal), zodat het totaal exact sluit op de factuur —
 * de per-zending-bedragen staan te versnipperd in de PDF-tekst om betrouwbaar
 * exact uit te lezen, de route + service per zending wél.
 */

const MAGAZIJN_POSTCODES = new Set(['1101AJ']);

/* Langste eerst, zodat "For You NL" niet matcht binnen "For You Vandaag NL". */
const KNOWN_SERVICES = [
  'DHL For You Vandaag NL',
  'DHL For You BE',
  'DHL For You NL',
  'DHL Parcel Connect DE',
  'DHL Europlus pakket NL',
];

const ROUTE_KEYS = ['consument', 'magazijn_winkel', 'winkel_winkel'];

function round(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

const isNlPostcode = (pc) => /^\d{4}[A-Z]{2}$/.test(pc);

/** Splits de detailtekst in zending-blokken en haalt service + van/naar-postcode. */
function parseShipments(text) {
  const full = String(text || '').replace(/[ \t]+/g, ' ');
  /* Blok-start: <trackingnr 9-12 cijfers> <klantnr 4-9 cijfers> <dd/mm/jjjj>. */
  const parts = full.split(/(?=\b\d{9,12} \d{4,9} \d{2}\/\d{2}\/\d{4})/);
  const ships = [];
  for (const blk of parts) {
    if (!/^\d{9,12} \d{4,9} \d{2}\/\d{2}\/\d{4}/.test(blk)) continue;
    const service = KNOWN_SERVICES.find((s) => blk.includes(s)) || '';
    /* van = eerste NL-postcode; naar = eerstvolgende postcode-token (NL of buitenland). */
    const pm = blk.match(/(\d{4} ?[A-Z]{2})\b +(\d{4} ?[A-Z]{2}|\d{3,5})\b/);
    const from = pm ? pm[1].replace(/\s/g, '') : '';
    const to = pm ? pm[2].replace(/\s/g, '') : '';
    ships.push({ service, from, to });
  }
  return ships;
}

/**
 * @param {string} detailText   PDF-tekst (per-pagina samengevoegd)
 * @param {Array}  services     summary.services [{service,count,total}, …]
 * @param {number} totalShipments
 * @returns {object} routeBreakdown
 */
export function parseDhlInvoiceRoutes(detailText, services = [], totalShipments = 0) {
  const ships = parseShipments(detailText);

  /* GENTS-locaties = alle afzender-postcodes uit het detail. */
  const gentsPostcodes = new Set(ships.map((s) => s.from).filter(Boolean));
  MAGAZIJN_POSTCODES.forEach((p) => gentsPostcodes.add(p));

  const classify = (from, to) => {
    const internal = isNlPostcode(to) && gentsPostcodes.has(to);
    if (!internal) return 'consument';
    return MAGAZIJN_POSTCODES.has(from) ? 'magazijn_winkel' : 'winkel_winkel';
  };

  /* Tel parsed zendingen per (service, route). */
  const perServiceRoute = {};
  for (const s of ships) {
    if (!s.service) continue;
    const route = classify(s.from, s.to);
    perServiceRoute[s.service] = perServiceRoute[s.service] || {};
    perServiceRoute[s.service][route] = (perServiceRoute[s.service][route] || 0) + 1;
  }

  /* Kosten + aantallen per route, geijkt op de samenvatting (sluit exact). */
  const count = { consument: 0, magazijn_winkel: 0, winkel_winkel: 0 };
  const cost = { consument: 0, magazijn_winkel: 0, winkel_winkel: 0 };

  for (const svc of services) {
    const name = svc.service;
    const svcCount = Number(svc.count || 0);
    const svcTotal = Number(svc.total || 0);
    if (!svcCount) continue;
    const avg = svcTotal / svcCount;

    const parsed = perServiceRoute[name] || {};
    let parsedTotal = 0;
    for (const k of ROUTE_KEYS) parsedTotal += parsed[k] || 0;

    /* Niet per-zending geparste exemplaren (bv. Europlus-subtotaal, Parcel
       Connect) → default-route: Europlus = intern (magazijn→winkel), rest =
       consument. */
    const isInternalService = /europlus/i.test(name);
    const defaultRoute = isInternalService ? 'magazijn_winkel' : 'consument';
    const distribution = { ...parsed };
    const unparsed = Math.max(0, svcCount - parsedTotal);
    if (unparsed) distribution[defaultRoute] = (distribution[defaultRoute] || 0) + unparsed;

    for (const route of ROUTE_KEYS) {
      const c = distribution[route] || 0;
      if (!c) continue;
      count[route] += c;
      cost[route] += c * avg;
    }
  }

  const total = count.consument + count.magazijn_winkel + count.winkel_winkel;
  const pct = (n) => (total ? Math.round((n / total) * 1000) / 10 : 0);

  return {
    method: 'dhl-detail-postcodes',
    parsedShipments: ships.length,
    gentsLocations: gentsPostcodes.size,
    streams: {
      consument: { count: count.consument, cost: round(cost.consument), pct: pct(count.consument) },
      magazijn_winkel: { count: count.magazijn_winkel, cost: round(cost.magazijn_winkel), pct: pct(count.magazijn_winkel) },
      winkel_winkel: { count: count.winkel_winkel, cost: round(cost.winkel_winkel), pct: pct(count.winkel_winkel) },
    },
  };
}
