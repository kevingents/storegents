import { put, list } from '@vercel/blob';

const STORE_PATH = 'function-help/items.json';

const DEFAULT_ITEMS = [
  { id: 'fh1', icon: '📦', title: 'Ophaalorders', description: 'Overzicht van klanten die een online bestelling in de winkel komen ophalen. Je kunt reminders sturen, notities toevoegen en de order als opgehaald markeren. Verversen haalt de laatste stand op uit Shopify.', modalId: 'pickup', order: 10 },
  { id: 'fh2', icon: '⏱', title: 'Openstaande orders', description: 'Live overzicht van weborders die jouw winkel moet verwerken via SRS. Orders ouder dan 48 uur worden rood gemarkeerd. Klik op een regel voor artikeldetails en klantinformatie.', modalId: 'store-open-weborders', order: 20 },
  { id: 'fh3', icon: '↩', title: 'Retour & terugbetaling', description: 'Tweestappe flow: zoek eerst op ordernummer + e-mail of postcode. In stap 2 kies je welke producten terugkomen. Shopify wordt terugbetaald en SRS krijgt automatisch de retourmelding.', modalId: 'refund', order: 30 },
  { id: 'fh4', icon: '⌕', title: 'Klant zoeken', description: 'Zoek op e-mail, klantnummer, naam, telefoonnummer of postcode. Toont SRS-klantprofiel, loyaltypunten, aankoophistorie en gekoppelde weborders in één scherm.', modalId: 'customer-lookup', order: 40 },
  { id: 'fh5', icon: '⇆', title: 'Uitwisselingen', description: 'Inkomende artikeluitwisselingen van andere winkels. Klik op een uitwisseling om het ontvangen aantal per regel in te voeren. Het portaal boekt dit terug in SRS.', modalId: 'exchanges', order: 50 },
  { id: 'fh6', icon: '@', title: 'Klantinschrijvingen', description: 'Overzicht van nieuw ingeschreven klanten deze maand. Rood = ontbrekende bon of e-mail. Gebruik dit om de datakwaliteit van de winkel bij te houden.', modalId: 'store-customer-month', order: 60 },
  { id: 'fh7', icon: '⇪', title: 'Declaratie indienen', description: 'Upload een factuur, geef het bedrag en de categorie op en geef aan of de factuur al betaald is. Administratie verwerkt de declaratie. Je ziet de status onder "Mijn declaraties".', modalId: 'declaration-submit', order: 70 },
  { id: 'fh8', icon: '⇄', title: 'Verzendlabel', description: 'Maak een DHL-label via Sendcloud. Kies bestemming Klant (vul adres in) of Winkel (kies uit lijst). Het label is direct te downloaden en wordt opgeslagen onder "Verzendlabels raadplegen".', modalId: 'label', order: 80 }
];

async function readBlobText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Function help kon niet worden gelezen.');
  return response.text();
}

async function loadAll() {
  try {
    const result = await list({ prefix: STORE_PATH, limit: 1 });
    const blob = result.blobs.find((item) => item.pathname === STORE_PATH);
    if (!blob) return null;
    const raw = await readBlobText(blob.url);
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function saveAll(items) {
  await put(STORE_PATH, JSON.stringify(items, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
}

function sortItems(items) {
  return [...items].sort((a, b) => (Number(a.order || 0)) - (Number(b.order || 0)));
}

export async function getFunctionHelpItems() {
  const items = await loadAll();
  if (items && items.length) return sortItems(items);
  return sortItems(DEFAULT_ITEMS);
}

export async function upsertFunctionHelpItem(input) {
  const id = String(input.id || '').trim();
  const item = {
    id: id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
    icon: String(input.icon || '?').trim(),
    title: String(input.title || '').trim(),
    description: String(input.description || '').trim(),
    modalId: String(input.modalId || '').trim(),
    order: Number(input.order || 0) || 0,
    updatedAt: new Date().toISOString()
  };

  let existing = await loadAll();
  if (!existing) existing = [...DEFAULT_ITEMS];

  const idx = existing.findIndex((it) => it.id === item.id);
  if (idx === -1) existing.push(item);
  else existing[idx] = { ...existing[idx], ...item };

  await saveAll(existing);
  return item;
}

export async function deleteFunctionHelpItem(id) {
  const target = String(id || '').trim();
  if (!target) return false;
  let existing = await loadAll();
  if (!existing) existing = [...DEFAULT_ITEMS];
  const next = existing.filter((it) => it.id !== target);
  if (next.length === existing.length) return false;
  await saveAll(next);
  return true;
}
