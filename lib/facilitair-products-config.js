/**
 * Configuratie van facilitaire producten die winkels kunnen bestellen via
 * het bestelformulier. Het advies (aantal) per product wordt berekend op
 * basis van:
 *
 *   - 'transactions': aantal kassa-transacties (winkel-verkopen) afgelopen 30d
 *   - 'weborders':    aantal weborder-fulfillments afgelopen 30d
 *   - 'fixed':        vaste hoeveelheid per maand (kantoor-artikelen)
 *
 * Formule: ceil(bronwaarde * per * safetyMargin)
 *   per           = verbruik per eenheid (zie 'per')
 *   safetyMargin  = 1.2 (20% buffer zodat winkels niet snel zonder zitten)
 *
 * Aanpassen kan via admin function-help editor of direct in deze file.
 */

export const FACILITAIR_SAFETY_MARGIN = 1.2;

/* Categorieën om de UI-groepering te tonen */
export const FACILITAIR_CATEGORIES = {
  kassa:     { label: 'Kassa & klant',       order: 1, icon: '🧾' },
  verkoop:   { label: 'Inpak winkel',         order: 2, icon: '🛍' },
  verzend:   { label: 'Verzendmateriaal',     order: 3, icon: '📦' },
  kantoor:   { label: 'Kantoor & techniek',   order: 4, icon: '🖨' }
};

export const FACILITAIR_PRODUCTS = [
  /* ─── KASSA & KLANT (op basis van winkel-transacties) ─── */
  {
    id: 'klantformulier',
    name: 'Klantformulier',
    category: 'kassa',
    unit: 'stuks',
    packSize: 100,
    advisory: { source: 'transactions', per: 0.5 },
    note: 'Schatting: helft van klanten vult formulier in.'
  },
  {
    id: 'pompboekjes',
    name: 'Pompboekjes',
    category: 'kassa',
    unit: 'stuks',
    packSize: 50,
    advisory: { source: 'transactions', per: 0.1 },
    note: '1 boekje per 10 klanten gemiddeld.'
  },
  {
    id: 'kassarollen',
    name: 'Kassa rollen',
    category: 'kassa',
    unit: 'rollen',
    packSize: 5,
    advisory: { source: 'transactions', per: 1 / 150 },
    note: '1 rol gaat door ± 150 bonnen.'
  },
  {
    id: 'pinrollen',
    name: 'Pinrollen',
    category: 'kassa',
    unit: 'rollen',
    packSize: 5,
    advisory: { source: 'transactions', per: 1 / 200 },
    note: '1 rol gaat door ± 200 pintransacties.'
  },

  /* ─── INPAK WINKEL (op basis van winkel-transacties) ─── */
  {
    id: 'gents-tasjes',
    name: 'Plastic GENTS tasjes',
    category: 'verkoop',
    unit: 'stuks',
    packSize: 250,
    advisory: { source: 'transactions', per: 0.7 },
    note: '± 70% van klanten krijgt een tasje mee.'
  },
  {
    id: 'shoppers',
    name: 'Shoppers',
    category: 'verkoop',
    unit: 'stuks',
    packSize: 100,
    advisory: { source: 'transactions', per: 0.2 },
    note: '± 20% van klanten krijgt een shopper (grote aankoop).'
  },
  {
    id: 'hoezen-groot',
    name: 'Hoezen groot (pak / jas)',
    category: 'verkoop',
    unit: 'stuks',
    packSize: 100,
    advisory: { source: 'transactions', per: 0.15 },
    note: '± 15% van klanten neemt jas/pak mee in hoes.'
  },
  {
    id: 'hoezen-klein',
    name: 'Hoezen klein (overhemd / broek)',
    category: 'verkoop',
    unit: 'stuks',
    packSize: 100,
    advisory: { source: 'transactions', per: 0.25 },
    note: '± 25% van klanten neemt overhemd/broek mee in hoes.'
  },

  /* ─── VERZENDMATERIAAL (op basis van weborders) ─── */
  {
    id: 'verzendzakken',
    name: 'Plastic verzendzakken (325 × 425 × 50 mm)',
    category: 'verzend',
    unit: 'stuks',
    packSize: 100,
    advisory: { source: 'weborders', per: 0.6 },
    note: '± 60% van weborders past in een zak (kleine kleding).'
  },
  {
    id: 'brievenbusdoosjes',
    name: 'Brievenbusdoosjes (365 × 255 × 28 mm)',
    category: 'verzend',
    unit: 'stuks',
    packSize: 50,
    advisory: { source: 'weborders', per: 0.15 },
    note: '± 15% van weborders zijn brievenbus-formaat (riem, sjaal).'
  },
  {
    id: 'witte-dozen-klein',
    name: 'Kleine witte dozen (380 × 265 × 150 mm)',
    category: 'verzend',
    unit: 'stuks',
    packSize: 25,
    advisory: { source: 'weborders', per: 0.2 },
    note: '± 20% van weborders past in een kleine doos.'
  },
  {
    id: 'witte-dozen-groot',
    name: 'Grote witte dozen (600 × 500 × 130 mm)',
    category: 'verzend',
    unit: 'stuks',
    packSize: 25,
    advisory: { source: 'weborders', per: 0.08 },
    note: '± 8% van weborders zijn groot formaat (jas, pak).'
  },
  {
    id: 'plakband-doos',
    name: 'Groot plakband voor dozen',
    category: 'verzend',
    unit: 'rollen',
    packSize: 6,
    advisory: { source: 'weborders', per: 1 / 40 },
    note: '1 rol per ± 40 dozen (28% van weborders).'
  },
  {
    id: 'verzendetiketten',
    name: 'Verzendetiketten voor stickerprinter',
    category: 'verzend',
    unit: 'rollen',
    packSize: 4,
    advisory: { source: 'weborders', per: 1 / 100 },
    note: '1 rol per ± 100 weborders.'
  },

  /* ─── KANTOOR & TECHNIEK (vast verbruik per maand) ─── */
  {
    id: 'print-papier',
    name: 'Print papier (A4 pak 500 vel)',
    category: 'kantoor',
    unit: 'pakken',
    packSize: 1,
    advisory: { source: 'fixed', per: 1 },
    note: '1 pak per maand standaard.'
  },
  {
    id: 'toner',
    name: 'Toner / Cartridge',
    category: 'kantoor',
    unit: 'stuks',
    packSize: 1,
    advisory: { source: 'fixed', per: 0.2 },
    note: '1 toner per ± 5 maanden — alleen bestellen bij waarschuwing op printer.'
  }
];

/**
 * Bereken advies-aantal voor een product gegeven bron-volumes.
 *
 * @param {object} product Item uit FACILITAIR_PRODUCTS
 * @param {object} volumes { transactions: number, weborders: number }
 * @returns {{ advisedQuantity: number, sourceCount: number, source: string }}
 */
export function calculateAdvisedQuantity(product, volumes = {}) {
  const source = product.advisory?.source || 'fixed';
  const per = Number(product.advisory?.per || 0);
  const transactions = Number(volumes.transactions || 0);
  const weborders = Number(volumes.weborders || 0);

  let sourceCount = 0;
  if (source === 'transactions') sourceCount = transactions;
  else if (source === 'weborders') sourceCount = weborders;
  else if (source === 'fixed') sourceCount = 1;

  const raw = sourceCount * per * FACILITAIR_SAFETY_MARGIN;
  const advisedQuantity = Math.max(0, Math.ceil(raw));

  return { advisedQuantity, sourceCount, source };
}

/**
 * Zoek product op id (handig in submit-validatie).
 */
export function findProductById(id) {
  const target = String(id || '').trim().toLowerCase();
  return FACILITAIR_PRODUCTS.find((p) => p.id.toLowerCase() === target) || null;
}
