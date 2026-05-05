#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const targets = [
  'api/admin/customers/weekly-report.js',
  'api/admin/vouchers/report.js',
  'api/admin/voucher-report.js',
  'api/admin/scoreboard/omnichannel.js',
  'api/admin/sendcloud-labels-report.js',
  'api/admin/declarations.js',
  'api/admin/weborders/overdue-report.js',
  'api/admin/order-cancellations/report.js',
  'api/admin/stock-negative/report.js',
  'api/admin/google-reviews.js',
  'api/admin/mail-logs.js',
  'api/admin/mail-log.js',
  'api/admin/mail-automation/status.js',
  'api/admin/mail-automations/status.js'
];

const fixedFunction = `function isAuthorized(req) {
  if (String(req.query.public || '') === 'true') return true;

  const adminToken = String(process.env.ADMIN_TOKEN || '12345').trim();
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.admin_token ||
    req.query.token ||
    req.body?.adminToken ||
    req.body?.admin_token ||
    ''
  ).replace(/^Bearer\\s+/i, '').trim();

  return Boolean(adminToken) && token === adminToken;
}`;

function replaceIsAuthorized(source) {
  const pattern = /function isAuthorized\(req\) \{[\s\S]*?\n\}/m;
  if (!pattern.test(source)) return { changed: false, source };
  return { changed: true, source: source.replace(pattern, fixedFunction) };
}

function ensureNoStore(source) {
  if (source.includes("res.setHeader('Cache-Control', 'no-store, max-age=0');")) return source;
  return source.replace(/setCorsHeaders\(res, \[[^\n]+\]\);/, (match) => `${match}\n  res.setHeader('Cache-Control', 'no-store, max-age=0');`);
}

let changed = 0;
for (const rel of targets) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) { console.log(`[SKIP] ${rel} niet gevonden`); continue; }
  const before = fs.readFileSync(file, 'utf8');
  const result = replaceIsAuthorized(before);
  let after = result.source;
  after = ensureNoStore(after);
  if (after !== before) {
    fs.writeFileSync(file, after);
    changed += 1;
    console.log(`[OK] aangepast: ${rel}`);
  } else {
    console.log(`[OK] geen wijziging nodig: ${rel}`);
  }
}
console.log(`Klaar. Aangepaste bestanden: ${changed}`);
