/**
 * GET /api/admin/mixmatch-color-groups
 *
 * Preview van kleur-groepen: producten met dezelfde naam (model) maar een
 * andere kleur, gegroepeerd. Zo kan de beheerder controleren of de juiste
 * pakken als kleur-variant aan elkaar gekoppeld worden vóórdat het op de
 * webshop verschijnt.
 *
 * Auth: x-admin-token / adminToken.
 */

import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { buildColorGroups, summarizeColorGroups } from '../../lib/mixmatch-color-groups.js';

function isAuthorized(req) {
  const adminToken = String(process.env.ADMIN_TOKEN || '12345').trim();
  const token = String(
    req.headers['x-admin-token'] || req.headers['x-admin-pin'] ||
    req.query?.adminToken || req.query?.admin_token || ''
  ).replace(/^Bearer\s+/i, '').trim();
  return Boolean(adminToken && token && token === adminToken);
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  try {
    const groups = await buildColorGroups();
    return res.status(200).json({
      success: true,
      summary: summarizeColorGroups(groups),
      groups: groups.slice(0, 200)
    });
  } catch (error) {
    console.error('[admin/mixmatch-color-groups]', error);
    return res.status(500).json({ success: false, message: error.message || 'Onverwachte fout.' });
  }
}
