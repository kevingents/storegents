import { put, list } from '@vercel/blob';

const ROUTE_STORE_PATH = 'delivery-routes/weekly-routes.json';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || (process.env.NODE_ENV === 'production' ? '' : '12345');

export const DELIVERY_DAYS = [
  { key: 'maandag', label: 'Maandag', index: 0 },
  { key: 'dinsdag', label: 'Dinsdag', index: 1 },
  { key: 'woensdag', label: 'Woensdag', index: 2 },
  { key: 'donderdag', label: 'Donderdag', index: 3 },
  { key: 'vrijdag', label: 'Vrijdag', index: 4 },
  { key: 'zaterdag', label: 'Zaterdag', index: 5 },
  { key: 'zondag', label: 'Zondag', index: 6 }
];

function clean(value) {
  return String(value ?? '').trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function firstFilled(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && clean(value) !== '') return value;
  }
  return '';
}

export function normalizeStore(value) {
  return lower(value)
    .replace(/^\d+\s*-\s*/i, '')
    .replace(/^gents\s+/i, '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toIsoDate(value) {
  const raw = clean(value);
  if (!raw) return '';
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toISOString().slice(0, 10);
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function pad(number) {
  return String(number).padStart(2, '0');
}

function startOfIsoWeek(date = new Date()) {
  const day = date.getDay() || 7;
  const monday = new Date(date);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - day + 1);
  return monday;
}

export function weekStartFromOffset(offset = 1) {
  const monday = startOfIsoWeek(new Date());
  monday.setDate(monday.getDate() + (7 * toNumber(offset, 1)));
  return monday.toISOString().slice(0, 10);
}

export function nextWeekKey(offset = 1) {
  return weekStartFromOffset(offset);
}

export function dayInfo(value) {
  const raw = lower(value || 'maandag');
  const normalized = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const found = DELIVERY_DAYS.find((day) => day.key === normalized || lower(day.label) === normalized);
  return found || DELIVERY_DAYS[0];
}

export function dateForWeekDay(weekStart, dayValue) {
  const start = new Date(`${toIsoDate(weekStart)}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) return '';
  const info = dayInfo(dayValue);
  start.setUTCDate(start.getUTCDate() + info.index);
  return start.toISOString().slice(0, 10);
}

export function weekLabel(weekStart) {
  const start = new Date(`${toIsoDate(weekStart)}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) return toIsoDate(weekStart);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return `Week van ${pad(start.getUTCDate())}-${pad(start.getUTCMonth() + 1)} t/m ${pad(end.getUTCDate())}-${pad(end.getUTCMonth() + 1)}-${end.getUTCFullYear()}`;
}

async function readBlobText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Routeplanning kon niet worden gelezen.');
  return response.text();
}

export function isAuthorized(req) {
  const token = clean(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.admin_token ||
    ''
  ).replace(/^Bearer\s+/i, '');

  return Boolean(ADMIN_TOKEN) && token === ADMIN_TOKEN;
}

export function setRouteCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-admin-pin, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

export async function getDeliveryRoutes() {
  try {
    const result = await list({ prefix: ROUTE_STORE_PATH, limit: 1 });
    const blob = result.blobs.find((item) => item.pathname === ROUTE_STORE_PATH);
    if (!blob) return [];
    const raw = await readBlobText(blob.url);
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('[delivery-routes] read failed:', error);
    return [];
  }
}

export async function saveDeliveryRoutes(routes) {
  await put(ROUTE_STORE_PATH, JSON.stringify(routes, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
}

export function routeKey(route = {}) {
  return [
    route.weekStart || '',
    dayInfo(route.day).key,
    normalizeStore(route.toLocation),
    route.eta || route.departureTime || ''
  ].join('|');
}

export function normalizeRoute(input = {}) {
  const weekStart = toIsoDate(firstFilled(input.weekStart, input.week, weekStartFromOffset(input.weekOffset || 1)));
  const day = dayInfo(firstFilled(input.day, input.weekday, 'maandag'));
  const toLocation = clean(firstFilled(input.toLocation, input.store, input.location, input.destination));
  const eta = clean(firstFilled(input.eta, input.expectedTime, input.arrivalWindow, ''));
  const departureTime = clean(firstFilled(input.departureTime, input.vertrektijd, input.departure, ''));
  const base = {
    ...input,
    weekStart,
    weekLabel: weekLabel(weekStart),
    day: day.label,
    dayKey: day.key,
    dayIndex: day.index,
    deliveryDate: dateForWeekDay(weekStart, day.key),
    driver: clean(firstFilled(input.driver, input.chauffeur, '')),
    fromLocation: clean(firstFilled(input.fromLocation, input.from, input.origin, 'Amsterdam HQ')),
    toLocation,
    storeKey: normalizeStore(toLocation),
    departureTime,
    eta,
    status: clean(firstFilled(input.status, 'planned')).toLowerCase(),
    deliveredHang: toNumber(input.deliveredHang ?? input.afgeleverdHang, 0),
    deliveredColli: toNumber(input.deliveredColli ?? input.afgeleverdColli, 0),
    deliveredOther: clean(firstFilled(input.deliveredOther, input.afgeleverdOverig, '')),
    pickupHang: toNumber(input.pickupHang ?? input.meegenomenHang, 0),
    pickupColli: toNumber(input.pickupColli ?? input.meegenomenColli, 0),
    note: clean(firstFilled(input.note, input.notes, input.opmerking, '')),
    updatedAt: new Date().toISOString()
  };

  return {
    ...base,
    id: clean(input.id) || routeKey(base)
  };
}

export function filterRoutes(routes = [], query = {}) {
  const weekStart = toIsoDate(firstFilled(query.weekStart, query.week, query.week_start, ''));
  const store = normalizeStore(firstFilled(query.store, query.location, query.toLocation, ''));
  const status = lower(query.status || '');
  const includeHidden = clean(query.includeHidden) === '1' || clean(query.includeHidden).toLowerCase() === 'true';

  return routes.filter((route) => {
    if (weekStart && route.weekStart !== weekStart) return false;
    if (store && route.storeKey !== store && normalizeStore(route.toLocation) !== store) return false;
    if (status && route.status !== status) return false;
    if (!includeHidden && route.status === 'hidden') return false;
    return true;
  });
}

export function upsertRoutes(existing = [], incoming = []) {
  const map = new Map();
  existing.forEach((route) => map.set(clean(route.id) || routeKey(route), route));
  incoming.forEach((route) => {
    const normalized = normalizeRoute(route);
    map.set(clean(normalized.id) || routeKey(normalized), {
      ...map.get(clean(normalized.id) || routeKey(normalized)),
      ...normalized,
      createdAt: map.get(clean(normalized.id) || routeKey(normalized))?.createdAt || new Date().toISOString()
    });
  });
  return Array.from(map.values());
}

export function deleteRoute(existing = [], id) {
  const wanted = clean(id);
  return existing.filter((route) => clean(route.id) !== wanted);
}

export function setRouteStatus(existing = [], id, status) {
  const wanted = clean(id);
  const nextStatus = clean(status || 'planned').toLowerCase();
  return existing.map((route) => (
    clean(route.id) === wanted
      ? { ...route, status: nextStatus, updatedAt: new Date().toISOString() }
      : route
  ));
}

export function sortRoutes(routes = []) {
  return [...routes].sort((a, b) =>
    String(a.weekStart).localeCompare(String(b.weekStart)) ||
    Number(a.dayIndex || 0) - Number(b.dayIndex || 0) ||
    String(a.eta || '').localeCompare(String(b.eta || '')) ||
    String(a.toLocation || '').localeCompare(String(b.toLocation || ''), 'nl')
  );
}

export function groupByStore(routes = []) {
  return routes.reduce((acc, route) => {
    const key = route.storeKey || normalizeStore(route.toLocation);
    if (!acc[key]) acc[key] = [];
    acc[key].push(route);
    return acc;
  }, {});
}
