import { put, list } from '@vercel/blob';

/**
 * User-profile store: persoonlijke instellingen per gebruiker.
 *
 * Schema per profile:
 *   {
 *     userId: 'admin' | '<store>|<employeeName>'  // unieke key
 *     name: 'Jan Jansen'                          // weergavenaam
 *     birthday: '1990-06-15'                      // ISO date voor verjaardags-cron
 *     theme: 'light' | 'dark' | 'system'          // thema-voorkeur
 *     store: 'GENTS Tilburg'                      // optioneel, voor winkel-users
 *     employeeName: 'Jan'                         // optioneel
 *     role: 'admin' | 'employee'
 *     email: 'jan@gents.nl'                       // voor verjaardags-mail (optioneel)
 *     updatedAt, createdAt
 *   }
 */

const PROFILES_PATH = 'user-profiles/profiles.json';
const ALLOWED_THEMES = new Set(['light', 'dark', 'system']);

function clean(value) { return String(value ?? '').trim(); }

function buildUserId({ role, store, employeeName }) {
  if (role === 'admin') return 'admin';
  const s = clean(store).toLowerCase();
  const e = clean(employeeName).toLowerCase();
  if (!s || !e) return '';
  return `${s}|${e}`;
}

async function readBlobText(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('Profielen kunnen niet worden gelezen.');
  return response.text();
}

async function loadAll() {
  try {
    const result = await list({ prefix: PROFILES_PATH, limit: 1 });
    const blob = (result.blobs || []).find((item) => item.pathname === PROFILES_PATH);
    if (!blob) return {};
    const raw = await readBlobText(blob.url);
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    console.error('[user-profile-store] read error:', error);
    return {};
  }
}

async function saveAll(map) {
  await put(PROFILES_PATH, JSON.stringify(map, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 30
  });
}

function normalize(input = {}) {
  const role = input.role === 'admin' ? 'admin' : 'employee';
  const store = clean(input.store);
  const employeeName = clean(input.employeeName);
  const userId = buildUserId({ role, store, employeeName });
  const theme = ALLOWED_THEMES.has(clean(input.theme).toLowerCase()) ? clean(input.theme).toLowerCase() : 'system';
  /* Birthday: YYYY-MM-DD format check */
  const birthdayRaw = clean(input.birthday);
  const birthday = /^\d{4}-\d{2}-\d{2}$/.test(birthdayRaw) ? birthdayRaw : '';
  return {
    userId,
    role,
    store,
    employeeName,
    name: clean(input.name) || employeeName || (role === 'admin' ? 'Admin' : 'Medewerker'),
    birthday,
    theme,
    email: clean(input.email),
    updatedAt: new Date().toISOString(),
    createdAt: clean(input.createdAt) || new Date().toISOString()
  };
}

export async function getUserProfile({ role, store, employeeName }) {
  const userId = buildUserId({ role, store, employeeName });
  if (!userId) return null;
  const all = await loadAll();
  return all[userId] || null;
}

export async function saveUserProfile(input = {}) {
  const profile = normalize(input);
  if (!profile.userId) throw new Error('Onvoldoende info om profiel-id te bouwen (role + store + employeeName).');
  const all = await loadAll();
  if (all[profile.userId]) profile.createdAt = all[profile.userId].createdAt || profile.createdAt;
  all[profile.userId] = profile;
  await saveAll(all);
  return profile;
}

/**
 * Geeft alle profielen met een geboortedatum die vandaag matched (alleen
 * dag + maand check; jaar wordt genegeerd). Gebruikt door verjaardags-cron.
 */
export async function getBirthdayProfilesFor(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const all = await loadAll();
  return Object.values(all).filter((p) => {
    if (!p.birthday) return false;
    const mm = p.birthday.slice(5, 7);
    const dd = p.birthday.slice(8, 10);
    return mm === month && dd === day;
  });
}

export async function getAllUserProfiles() {
  const all = await loadAll();
  return Object.values(all);
}
