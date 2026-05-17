import { put, list } from '@vercel/blob';

const FAQ_PATH = 'faq/items.json';

const DEFAULT_FAQ = [
  { id: 'd1', category: 'Algemeen', question: 'Wanneer bel ik SRS?', answer: 'Bij kassavragen, kassastoringen en pinstoringen. Voor overige meldingen gebruik je het Support formulier in het portaal.', relatedModal: '' },
  { id: 'd2', category: 'Retour', question: 'Hoe verwerk ik een retour?', answer: 'Gebruik "Retour & terugbetaling" onder Dagelijkse winkelacties. Zoek op ordernummer + klant e-mail of postcode. Na het zoeken kun je per product kiezen wat teruggestuurd wordt. Shopify en SRS worden automatisch bijgewerkt.', relatedModal: 'refund' },
  { id: 'd3', category: 'Labels', question: 'Hoe maak ik een verzendlabel?', answer: 'Ga naar "Verzendlabel maken". Kies bestemming Klant of Winkel. Het label wordt via Sendcloud/DHL aangemaakt en is direct printbaar. Je ziet het terug onder "Verzendlabels raadplegen".', relatedModal: 'label' },
  { id: 'd4', category: 'Declaraties', question: 'Hoe dien ik een declaratie in?', answer: 'Ga naar "Declaratie indienen". Upload de ondertekende factuur, vul het bedrag in en geef aan of al betaald. Administratie verwerkt de declaratie en je ziet de status terug onder "Mijn declaraties".', relatedModal: 'declaration-submit' },
  { id: 'd5', category: 'Klanten', question: 'Hoe zoek ik een klant op?', answer: 'Gebruik "Klant zoeken". Je kunt zoeken op e-mail, klantnummer, telefoonnummer, naam of postcode + huisnummer. Het portaal combineert SRS-klantprofiel en Shopify-orders in één overzicht.', relatedModal: 'customer-lookup' },
  { id: 'd6', category: 'Pickup', question: 'Afhaalorder staat als opgehaald maar klant is er nog niet geweest', answer: 'Klik in "Ophaalorders" op de order en gebruik de optie om de status terug te zetten. Neem contact op met de winkelmanager als de status niet meer wijzigbaar is.', relatedModal: 'pickup' },
  { id: 'd7', category: 'Algemeen', question: 'Wat is de omnichannel score?', answer: 'De omnichannel score meet hoe goed de winkel scoort op klantregistratie (bon + e-mail), loyalty deelname en weborderprestaties. Hoe hoger, hoe beter. De score is zichtbaar op het dashboard en in de admin rapportages.', relatedModal: '' }
];

async function readBlobText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('FAQ kon niet worden gelezen.');
  return response.text();
}

async function loadAll() {
  try {
    const result = await list({ prefix: FAQ_PATH, limit: 1 });
    const blob = result.blobs.find((item) => item.pathname === FAQ_PATH);
    if (!blob) return null;
    const raw = await readBlobText(blob.url);
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function saveAll(items) {
  await put(FAQ_PATH, JSON.stringify(items, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
}

export async function getFaqItems() {
  const items = await loadAll();
  if (items && items.length) return items;
  return DEFAULT_FAQ;
}

export async function upsertFaqItem(input) {
  const id = String(input.id || '').trim();
  const item = {
    id: id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
    category: String(input.category || 'Algemeen').trim(),
    question: String(input.question || '').trim(),
    answer: String(input.answer || '').trim(),
    relatedModal: String(input.relatedModal || '').trim(),
    updatedAt: new Date().toISOString()
  };

  /* Bij eerste write: clone defaults en zorg dat ze in store komen */
  let existing = await loadAll();
  if (!existing) existing = [...DEFAULT_FAQ];

  const idx = existing.findIndex((it) => it.id === item.id);
  if (idx === -1) {
    existing.push(item);
  } else {
    existing[idx] = { ...existing[idx], ...item };
  }

  await saveAll(existing);
  return item;
}

export async function deleteFaqItem(id) {
  const target = String(id || '').trim();
  if (!target) return false;
  let existing = await loadAll();
  if (!existing) existing = [...DEFAULT_FAQ];
  const next = existing.filter((it) => it.id !== target);
  if (next.length === existing.length) return false;
  await saveAll(next);
  return true;
}
