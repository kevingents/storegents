/**
 * POST /api/admin/migrate-departments
 *
 * Body:
 *   { dryRun: true|false, personnelIds?: [...], actor?: { name, id } }
 *
 * Eerst altijd met dryRun=true draaien om te zien wat gaat veranderen.
 * Daarna met dryRun=false om de wijzigingen door te voeren.
 *
 * Response:
 *   { success, dryRun, summary: {...}, users: [...] | applied: [...] }
 *
 * Authentication: x-admin-token of adminToken-querystring/body, gelijk aan
 * andere admin-endpoints.
 */

import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import {
  computeMigrationDiff,
  migrateAll
} from '../../lib/user-permissions-migrate.js';
import { listDepartmentMappings } from '../../lib/department-permissions-mapping.js';
import { appendAuditEntry } from '../../lib/permissions-audit-store.js';

function isAuthorized(req) {
  const adminToken = String(process.env.ADMIN_TOKEN || '12345').trim();
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.query?.adminToken ||
    req.query?.admin_token ||
    req.body?.adminToken ||
    req.body?.admin_token ||
    ''
  ).trim();
  return token && token === adminToken;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!isAuthorized(req)) {
    return res.status(401).json({
      success: false,
      message: 'Niet geautoriseerd — admin-token vereist.'
    });
  }

  try {
    if (req.method === 'GET') {
      /* GET returnt mapping-tabel + dry-run preview voor ALLE users */
      const preview = await computeMigrationDiff({});
      return res.status(200).json({
        success: true,
        mode: 'preview',
        mappings: listDepartmentMappings(),
        ...preview
      });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const dryRun = body.dryRun !== false; /* default true voor veiligheid */
      const personnelIds = Array.isArray(body.personnelIds) ? body.personnelIds : null;
      const actor = body.actor || { name: 'admin' };

      const result = await migrateAll({
        dryRun,
        personnelIds,
        updatedBy: actor
      });

      /* Audit-log alleen bij echte uitvoering */
      if (!dryRun) {
        try {
          await appendAuditEntry({
            type: 'departments-migration',
            actor,
            timestamp: new Date().toISOString(),
            usersAffected: result.applied?.length || 0,
            totalAdded: result.summary?.totalAdded || 0
          });
        } catch (e) {
          console.warn('[migrate-departments] audit write failed:', e.message);
        }
      }

      return res.status(200).json({
        success: true,
        ...result
      });
    }

    return res.status(405).json({ success: false, message: 'Method not allowed.' });
  } catch (error) {
    console.error('[migrate-departments]', error);
    return res.status(500).json({
      success: false,
      message: error?.message || 'Migratie faalde.'
    });
  }
}
