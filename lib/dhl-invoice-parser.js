/**
 * lib/dhl-invoice-parser.js
 *
 * Parser voor DHL eCommerce (Netherlands)-facturen op basis van de PDF-tekst.
 * WHITESPACE-AGNOSTISCH: normaliseert eerst alle witruimte naar enkele spaties,
 * zodat het werkt ongeacht of de PDF-extractor newlines behoudt (pypdf/pdf-parse)
 * of alles op één regel zet (unpdf — de serverless-vriendelijke extractor die we
 * in de backend gebruiken).
 *
 * Haalt eruit: factuurnummer, klantnummer, facturatieperiode (ISO), totaal aantal
 * zendingen + kosten (excl/btw/incl), per-service uitsplitsing en toeslagen.
 * DHL gebruikt punt-decimalen (4830.04). Geeft altijd een object terug.
 */

function toNum(value) {
  const n = Number(String(value == null ? '' : value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function iso(dd, mm, yyyy) {
  return `${yyyy}-${mm}-${dd}`;
}

export function parseDhlInvoiceText(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();

  // Facturatieperiode: DD/MM/YYYY - DD/MM/YYYY
  const per = t.match(/(\d{2})\/(\d{2})\/(\d{4}) ?- ?(\d{2})\/(\d{2})\/(\d{4})/);
  const periodFrom = per ? iso(per[1], per[2], per[3]) : '';
  const periodTo = per ? iso(per[4], per[5], per[6]) : '';

  // Factuur- en klantnummer (waarden ná het support-e-mailadres).
  let invoiceNumber = '';
  let customerNumber = '';
  const idm = t.match(/@dhl\.com (\d{5,10}) (\d{5,10})/i);
  if (idm) {
    invoiceNumber = idm[1];
    customerNumber = idm[2];
  }

  // "Service Totaal <aantal> <gewicht> <transport> <toeslagen> <totaal>"
  const tot = t.match(/Service Totaal (\d+) ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)/i);
  const totalShipments = tot ? parseInt(tot[1], 10) : 0;
  const totalWeight = tot ? toNum(tot[2]) : 0;
  const totalTransport = tot ? toNum(tot[3]) : 0;
  const totalSurcharges = tot ? toNum(tot[4]) : 0;
  const totalExclVat = tot ? toNum(tot[5]) : 0;

  // Per-service regels: het blok tussen de kolomkop en "Service Totaal".
  const services = [];
  const sblock = t.match(/Gewicht Transporttarief Opties[\s\S]*?Totaal (.+?) Service Totaal/i);
  if (sblock) {
    const re = /([A-Za-z][A-Za-z .]*?) (\d+) (\d+(?:\.\d+)?) (\d+\.\d+) (\d+\.\d+) (\d+\.\d+)/g;
    let m;
    while ((m = re.exec(sblock[1])) !== null) {
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

  // Toeslagen: het blok ná de "Service Totaal"-regel. Namen zijn cijferloos.
  const surcharges = [];
  const tblock = t.match(/Service Totaal [\d. ]+Opties & Toeslagen Totaal (.+?) Totaal Opties & Toeslagen/i);
  if (tblock) {
    const re = /([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ /-]*?) (\d+\.\d+)/g;
    let m;
    while ((m = re.exec(tblock[1])) !== null) {
      const name = m[1].trim();
      if (name.replace(/[^a-zà-ÿ]/gi, '').length > 1) {
        surcharges.push({ name, amount: toNum(m[2]) });
      }
    }
  }

  // BTW (eerste "BTW Totaal <bedrag>"); incl = excl + btw.
  const btw = t.match(/BTW Totaal (\d+\.\d+)/i);
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
