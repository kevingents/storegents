import { syncSrsCancellationsForBranch } from '../../../lib/srs-cancellation-sync-service.js';
import { listBranches } from '../../../lib/branch-metrics.js';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function isAdmin(req) {
  if (!ADMIN_TOKEN) return true;
  const token = String(req.headers['x-admin-token'] || req.query.adminToken || '').trim();
  return token === ADMIN_TOKEN;
}

function bool(value) {
  return ['1', 'true', 'yes', 'ja'].includes(String(value || '').toLowerCase());
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ success: false, message: 'Alleen GET/POST is toegestaan.' });
  if (!isAdmin(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const body = req.body || {};
  const month = String(req.query.month || body.month || '').trim();
  const dryRun = bool(req.query.dryRun || body.dryRun);
  const maxRuntimeMs = Number(req.query.maxRuntimeMs || body.maxRuntimeMs || 50000);
  const maxRecords = Number(req.query.maxRecords || body.maxRecords || 50);
  const startedAt = Date.now();
  const branches = listBranches().filter((branch) => branch.store && branch.branchId);
  const results = [];
  const errors = [];

  for (const branch of branches) {
    if (Date.now() - startedAt > maxRuntimeMs) {
      errors.push({ store: branch.store, branchId: branch.branchId, message: 'Max runtime bereikt; sync gedeeltelijk uitgevoerd.' });
      break;
    }

    try {
      const result = await syncSrsCancellationsForBranch({
        store: branch.store,
        month: month || undefined,
        dryRun,
        maxRuntimeMs: Math.min(12000, Math.max(4000, maxRuntimeMs - (Date.now() - startedAt))),
        maxRecords
      });
      results.push(result);
    } catch (error) {
      errors.push({ store: branch.store, branchId: branch.branchId, message: error.message || 'SRS sync mislukt.' });
    }
  }

  return res.status(200).json({
    success: errors.length === 0,
    dryRun,
    month: month || '',
    branchesTotal: branches.length,
    branchesScanned: results.length,
    found: results.reduce((sum, item) => sum + Number(item.found || 0), 0),
    created: results.reduce((sum, item) => sum + Number(item.created || 0), 0),
    duplicates: results.reduce((sum, item) => sum + Number(item.duplicates || 0), 0),
    partial: errors.length > 0,
    runtimeMs: Date.now() - startedAt,
    results,
    errors,
    message: dryRun
      ? `Dry-run alle winkels klaar. ${results.length} winkels gescand.`
      : `Alle winkels sync klaar. ${results.length} winkels gescand.`
  });
}
