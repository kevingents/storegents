/**
 * GET  /api/admin/migrate-afdelingen-to-groups   — dry-run preview
 * POST /api/admin/migrate-afdelingen-to-groups   — voer migratie uit
 *
 * Zet de uitgefaseerde virtuele winkels (afdelingen) om naar groepen:
 * per afdeling een groep met de bijbehorende page-rechten, en koppel de
 * huidige afdeling-gebruikers eraan (zodat ze hun toegang houden via
 * rollen/groepen i.p.v. de oude afdeling-filter).
 *
 * Body (POST):
 *   { dryRun?: boolean=false, applyPermissions?: boolean=true, actor?: {name,id} }
 *
 * Authenticatie: x-admin-token / adminToken (gelijk aan andere admin-endpoints).
 */

import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import {
  computeAfdelingGroupDiff,
  migrateAfdelingenToGroups
} from '../../lib/afdeling-group-migrate.js';
import { appendAuditEntry } from '../../lib/permissions-audit-store.js';

function isAuthorized(req) {
  const adminToken = String(process.env.ADMIN_TOKEN || (globalThis.crypto?.randomUUID?.() || String(Math.random()))).trim();
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.query?.adminToken ||
    req.query?.admin_token ||
    req.body?.adminToken ||
    req.body?.admin_token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return Boolean(adminToken && token && token === adminToken);
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet geautoriseerd — admin-token vereist.' });
  }

  try {
    if (req.method === 'GET') {
      const preview = await computeAfdelingGroupDiff();
      return res.status(200).json({ success: true, mode: 'preview', ...preview });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const dryRun = body.dryRun === true; /* default: echt uitvoeren bij POST */
      const applyPermissions = body.applyPermissions !== false; /* default true */
      const actor = body.actor || { name: 'admin' };

      const result = await migrateAfdelingenToGroups({ dryRun, applyPermissions, updatedBy: actor });

      if (!dryRun) {
        try {
          await appendAuditEntry({
            type: 'afdelingen-to-groups-migration',
            actor,
            timestamp: new Date().toISOString(),
            groupsUpserted: result.groupsUpserted?.length || 0,
            usersUpdated: result.usersUpdated?.length || 0,
            applyPermissions
          });
        } catch (e) {
          console.warn('[migrate-afdelingen-to-groups] audit write failed:', e.message);
        }
      }

      return res.status(200).json({ success: true, ...result });
    }

    return res.status(405).json({ success: false, message: 'Method not allowed.' });
  } catch (error) {
    console.error('[migrate-afdelingen-to-groups]', error);
    return res.status(500).json({ success: false, message: error?.message || 'Migratie faalde.' });
  }
}
