import { put, list } from '@vercel/blob';

const ROUTE_STORE_PATH = 'delivery-routes/weekly-routes.json';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || (process.env.NODE_ENV === 'production' ? '' : '12345');

function clean(value) {
  return String(value ?? '').trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function normalizeStore(value) {
  return lower(value).replace(/^\d+\s*-\s*/i, '').replace(/\s+/g, ' ');
}

function firstFilled(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && clean(value) !== '') return value;
  }
  return '';
}

function toIsoDate(value) {
  const raw = clean(value);
  if (!raw) return '';
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toISOString().slice(0, 10);
}

function readWeekOffset(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 1;
}

function startOfIsoWeek(date = new Date()) {
  const day = date.getDay() || 7;
  const monday = new Date(date);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - day + 1);
  return monday;
}

export function nextWeekKey(offset = 1) {
  const start = startOfIsoWeek(new Date());
  start.setDate(start.getDate() + (7 * readWeekOffset(offset)));
  return start.toISOString().slice(0, 10);
}

async function readBlobText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Routeplanning kon niet worden gelezen.');
  return response.text();
}

export function isAuthorized(req) {
  const token = clean(req.headers['x-admin-token'] || req.headers['x-admin-pin'] || req.headers.authorization || req.query.adminToken || req.query.admin_token || '').replace(/^Bearer\s+/i, '');
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

export function normalizeRoute(input = {}) {
  const id = clean(input.id) || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const weekStart = toIsoDate(firstFilled(input.weekStart, input.week, nextWeekKey(1)));
  const deliveryDate = toIsoDate(firstFilled(input.deliveryDate, input.date, weekStart));
  const fromLocation = clean(firstFilled(input.fromLocation, input.from, input.origin, 'Amsterdam HQ'));
  const toLocation = clean(firstFilled(input.toLocation, input.store, input.location, input.destination));
  const driver = clean(firstFilled(input.driver, input.chauffeur, ''));
  const day = clean(firstFilled(input.day, input.weekday, ''));
  const departureTime = clean(firstFilled(input.departureTime, input.vertrektijd, input.departure, ''));
  const eta = clean(firstFilled(input.eta, input.expectedTime, input.arrivalWindow, ''));
  const note = clean(firstFilled(input.note, input.notes, input.opmerking, ''));
  const status = clean(firstFilled(input.status, 'planned')).toLowerCase();

  return {
    id,
    weekStart,
    deliveryDate,
    day,
    driver,
    fromLocation,
    toLocation,
    storeKey: normalizeStore(toLocation),
    departureTime,
    eta,
    status,
    deliveredHang: Number(input.deliveredHang || input.afgeleverdHang || 0),
    deliveredColli: Number(input.deliveredColli || input.afgeleverdColli || 0),
    deliveredOther: clean(firstFilled(input.deliveredOther, input.afgeleverdOverig, '')),
    pickupHang: Number(input.pickupHang || input.meegenomenHang || 0),
    pickupColli: Number(input.pickupColli || input.meegenomenColli || 0),
    note,
    updatedAt: new Date().toISOString()
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

export function groupByStore(routes = []) {
  return routes.reduce((acc, route) => {
    const key = route.storeKey || normalizeStore(route.toLocation);
    if (!acc[key]) acc[key] = [];
    acc[key].push(route);
    return acc;
  }, {});
}
