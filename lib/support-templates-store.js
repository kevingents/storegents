import { put, list } from '@vercel/blob';

const TEMPLATES_PATH = 'support/templates.json';

const DEFAULT_TEMPLATES = [
  {
    id: 'tmpl-acknowledge',
    name: 'Ontvangst bevestigen',
    content: 'Beste {{employeeName}},\n\nWe hebben je melding ontvangen en kijken er naar. Je hoort zo snel mogelijk meer van ons.\n\nMet vriendelijke groet,\nGENTS Hoofdkantoor'
  },
  {
    id: 'tmpl-resolved',
    name: 'Opgelost',
    content: 'Beste {{employeeName}},\n\nWe hebben je melding kunnen oplossen. Mocht het probleem opnieuw voorkomen, laat het ons dan weten.\n\nMet vriendelijke groet,\nGENTS Hoofdkantoor'
  },
  {
    id: 'tmpl-need-info',
    name: 'Meer informatie nodig',
    content: 'Beste {{employeeName}},\n\nOm je melding goed te kunnen behandelen hebben we nog wat extra info nodig:\n\n- \n- \n\nKun je dat aanvullen? Bedankt!\n\nMet vriendelijke groet,\nGENTS Hoofdkantoor'
  },
  {
    id: 'tmpl-onderhoud',
    name: 'Onderhoud gepland',
    content: 'Beste {{employeeName}},\n\nWe hebben onderhoud ingepland voor:\n\nDatum: \nTijd: \nWie komt: \n\nMet vriendelijke groet,\nGENTS Hoofdkantoor'
  }
];

async function readBlobText(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('Support templates konden niet worden gelezen.');
  return response.text();
}

function normalize(template = {}, index = 0) {
  return {
    id: String(template.id || `tmpl-${Date.now()}-${index}`).trim(),
    name: String(template.name || `Template ${index + 1}`).trim(),
    content: String(template.content || '').trim()
  };
}

export async function getSupportTemplates() {
  try {
    const result = await list({ prefix: TEMPLATES_PATH, limit: 1 });
    const blob = result.blobs.find((item) => item.pathname === TEMPLATES_PATH);
    if (!blob) return DEFAULT_TEMPLATES.map(normalize);
    const raw = await readBlobText(blob.url);
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) && parsed.length ? parsed.map(normalize) : DEFAULT_TEMPLATES.map(normalize);
  } catch (error) {
    console.error('[support-templates-store] read error:', error);
    return DEFAULT_TEMPLATES.map(normalize);
  }
}

async function saveAll(templates) {
  const normalized = templates.map(normalize);
  await put(
    TEMPLATES_PATH,
    JSON.stringify(normalized, null, 2),
    {
      access: 'public',
      allowOverwrite: true,
      contentType: 'application/json',
      cacheControlMaxAge: 60
    }
  );
  return normalized;
}

export async function saveSupportTemplates(templates) {
  if (!Array.isArray(templates)) throw new Error('Templates moet een array zijn.');
  return saveAll(templates);
}

export async function upsertSupportTemplate(template) {
  const existing = await getSupportTemplates();
  const t = normalize(template, existing.length);
  const idx = existing.findIndex((x) => x.id === t.id);
  if (idx >= 0) existing[idx] = t;
  else existing.push(t);
  return saveAll(existing);
}

export async function deleteSupportTemplate(id) {
  const existing = await getSupportTemplates();
  const filtered = existing.filter((x) => x.id !== id);
  return saveAll(filtered);
}
