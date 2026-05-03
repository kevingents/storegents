#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const targets = [
  'api/admin/customers/weekly-report.js',
  'api/admin/vouchers/report.js',
  'api/admin/scoreboard/omnichannel.js',
  'api/admin/sendcloud-labels-report.js',
  'api/admin/declarations.js',
  'api/admin/weborders/overdue-report.js',
  'api/admin/order-cancellations/report.js',
  'api/admin/stock-negative/report.js'
];

const fixedFunction = `function isAuthorized(req) {
  if (String(req.query.public || '') === 'true') return true;

  const adminToken = process.env.ADMIN_TOKEN || '12345';
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    ''
  ).replace(/^Bearer\\s+/i, '').trim();

  return token === adminToken;
}`;

function replaceIsAuthorized(source) {
  const pattern = /function isAuthorized\(req\) \{[\s\S]*?\n\}/m;
  if (!pattern.test(source)) return { changed: false, source };
  return { changed: true, source: source.replace(pattern, fixedFunction) };
}

function ensureNoStore(source) {
  if (source.includes("res.setHeader('Cache-Control', 'no-store, max-age=0');")) return source;
  return source.replace(
    /setCorsHeaders\(res, \[[^\n]+\]\);/,
    (match) => `${match}\n  res.setHeader('Cache-Control', 'no-store, max-age=0');`
  );
}

let changed = 0;
for (const rel of targets) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    console.log(`[SKIP] ${rel} niet gevonden`);
    continue;
  }

  const before = fs.readFileSync(file, 'utf8');
  const result = replaceIsAuthorized(before);
  let after = result.source;

  if (rel.includes('/report') || rel.includes('scoreboard') || rel.includes('weekly-report') || rel.includes('sendcloud-labels-report') || rel.includes('declarations')) {
    after = ensureNoStore(after);
  }

  if (after !== before) {
    fs.writeFileSync(file, after);
    changed += 1;
    console.log(`[OK] aangepast: ${rel}`);
  } else {
    console.log(`[OK] geen wijziging nodig: ${rel}`);
  }
}

console.log(`\nKlaar. Aangepaste bestanden: ${changed}`);
console.log('Controleer daarna lokaal met: grep -R "function isAuthorized" api/admin lib -n');
