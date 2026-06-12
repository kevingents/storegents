/**
 * lib/dhl-invoice-parser.js
 *
 * Parser voor DHL eCommerce (Netherlands)-facturen op basis van de PDF-tekst.
 * Haalt de samenvatting eruit voor reconciliatie tegen SendCloud:
 *   - factuurnummer, klantnummer, facturatieperiode (van/tot, ISO)
 *   - totaal aantal zendingen + kosten (excl/incl btw)
 *   - per-service uitsplitsing (aantal + kosten)
 *   - toeslagen (brandstof, tol, etc.)
 *
 * DHL gebruikt punt-decimalen (4830.04). Robuust tegen kleine layout-/encoding-
 * verschillen; geeft altijd een object terug (lege velden bij geen match).
 */

function toNum(value) {
  const n = Number(String(value == null ? '' : value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function iso(dd, mm, yyyy) {
  return `${yyyy}-${mm}-${dd}`;
}

export function parseDhlInvoiceText(text) {
  const t = String(text || '');

  // Facturatieperiode: DD/MM/YYYY - DD/MM/YYYY
  const per = t.match(/(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2})\/(\d{2})\/(\d{4})/);
  const periodFrom = per ? iso(per[1], per[2], per[3]) : '';
  const periodTo = per ? iso(per[4], per[5], per[6]) : '';

  // Factuur- en klantnummer staan als waarden ná het support-e-mailadres.
  let invoiceNumber = '';
  let customerNumber = '';
  const idm = t.match(/@dhl\.com\s*\n\s*(\d{5,10})\s*\n\s*(\d{5,10})/i);
  if (idm) {
    invoiceNumber = idm[1];
    customerNumber = idm[2];
  } else {
    const fm = t.match(/Factuurnummer:\s*\n?\s*(\d{5,10})/i);
    if (fm) invoiceNumber = fm[1];
  }

  // "Service Totaal <aantal> <gewicht> <transport> <toeslagen> <totaal>"
  const tot = t.match(/Service\s+Totaal\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i);
  const totalShipments = tot ? parseInt(tot[1], 10) : 0;
  const totalWeight = tot ? toNum(tot[2]) : 0;
  const totalTransport = tot ? toNum(tot[3]) : 0;
  const totalSurcharges = tot ? toNum(tot[4]) : 0;
  const totalExclVat = tot ? toNum(tot[5]) : 0;

  // Per-service regels (tussen de kop "Service Aantal Gewicht…" en "Service Totaal").
  const services = [];
  const block = t.match(/Service\s+Aantal\s+Gewicht[^\n]*\n([\s\S]*?)Service\s+Totaal/i);
  if (block) {
    for (const raw of block[1].split('\n')) {
      const m = raw.trim().match(/^(.+?)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)$/);
      if (m) {
        services.push({
          service: m[1].trim(),
          count: parseInt(m[2], 10),
          weight: toNum(m[3]),
          transport: toNum(m[4]),
          surcharges: toNum(m[5]),
          total: toNum(m[6]),
        });
      }
    }
  }

  // Toeslagen: het blok ná de "Service Totaal"-regel (de kop "… Opties & Toeslagen
  // Totaal" in de servicetabel niet meenemen). Namen zijn cijferloos (Brandstof,
  // Tol België, …) — zo vallen de servicerijen (die cijfers in de naam hebben) weg.
  const surcharges = [];
  const sb = t.match(
    /Service\s+Totaal\s+\d[\d.\s]*\n\s*Opties\s*&\s*Toeslagen\s+Totaal\s*\n([\s\S]*?)Totaal\s+Opties\s*&\s*Toeslagen/i
  );
  if (sb) {
    for (const raw of sb[1].split('\n')) {
      const m = raw.trim().match(/^([^\d]+?)\s+([\d.]+)$/);
      if (m && m[1].replace(/[^a-z]/gi, '').length > 1) {
        surcharges.push({ name: m[1].trim(), amount: toNum(m[2]) });
      }
    }
  }

  // BTW (eerste "BTW Totaal <bedrag>"); incl = excl + btw.
  const btw = t.match(/BTW\s+Totaal\s+([\d.]+)/i);
  const vatAmount = btw ? toNum(btw[1]) : 0;
  const totalInclVat = Math.round((totalExclVat + vatAmount) * 100) / 100;

  return {
    carrier: 'DHL',
    invoiceNumber,
    customerNumber,
    periodFrom,
    periodTo,
    totalShipments,
    totalWeight,
    totalTransport,
    totalSurcharges,
    totalExclVat,
    vatAmount,
    totalInclVat,
    services,
    surcharges,
    parsedAt: new Date().toISOString(),
  };
}
