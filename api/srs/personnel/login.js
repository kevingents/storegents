import { handleCors, setCorsHeaders } from '../../../lib/cors.js';
import { createPersonnelSession } from '../../../lib/personnel-session.js';
import { findPersonnelForLogin, getAllConfiguredStores } from '../../../lib/srs-personnel-client.js';

/* Stores die NOOIT in de winkel-keuze-dropdown van een SRS-personnel-login
   mogen verschijnen. Admin/virtuele afdelingen geven anders shell-zichtbaarheid
   voor alle admin-pages — terwijl SRS-personnel alleen toegang hebben tot de
   fysieke winkels waar ze daadwerkelijk werken.
   Admin-toegang gaat UITSLUITEND via de master-pin (ADMIN_MASTER_PIN env). */
const STORES_BLOCKED_FOR_SRS = new Set([
  'gents administratie',
  'administratie',
  'admin',
  'gents admin',
  'supplychain',
  'finance',
  'marketing',
  'hr'
]);

function isAdminLikeStore(store) {
  return STORES_BLOCKED_FOR_SRS.has(String(store || '').toLowerCase().trim());
}

function parseBody(req) {
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  return req.body || {};
}

function masterAdminPin() {
  return process.env.ADMIN_MASTER_PIN || process.env.GENTS_ADMIN_MASTER_PIN || '';
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
  }

  try {
    const body = parseBody(req);
    const personnelId = String(body.personnelId || '').trim();
    const posLoginCode = String(body.posLoginCode || body.pin || '').trim();
    const adminPin = String(body.adminPin || body.masterPin || '').trim();
    const configuredMasterPin = masterAdminPin();

    if (configuredMasterPin && adminPin && adminPin === configuredMasterPin) {
      const employee = {
        personnelId: 'ADMIN',
        name: 'Admin beheerder',
        internalName: 'Admin beheerder',
        externalName: 'Admin',
        personnelGroupId: 'admin',
        branches: ['*'],
        stores: getAllConfiguredStores(),
        isMasterAdmin: true
      };

      return res.status(200).json({
        success: true,
        sessionToken: createPersonnelSession(employee, { isMasterAdmin: true }),
        employee
      });
    }

    const employee = await findPersonnelForLogin({ personnelId, posLoginCode });

    /* SECURITY: filter alle admin/virtuele afdelingen uit de stores-lijst.
       SRS kan een medewerker met branch-toegang tot bv. magazijn-administratie
       koppelen — dat mag NIET resulteren in admin-shell zichtbaarheid in de
       portal. Admin-toegang vereist altijd master-pin. */
    const filteredStores = (employee.stores || []).filter((s) => !isAdminLikeStore(s));
    const removedCount = (employee.stores || []).length - filteredStores.length;
    if (removedCount > 0) {
      console.warn(`[srs/personnel/login] Stripped ${removedCount} admin-like store(s) from personnel ${employee.personnelId} response.`);
    }
    const safeEmployee = { ...employee, stores: filteredStores };
    if (!filteredStores.length) {
      return res.status(403).json({
        success: false,
        message: 'Deze medewerker heeft geen toegang tot een fysieke winkel. Admin-toegang vereist master-pin.'
      });
    }

    return res.status(200).json({
      success: true,
      sessionToken: createPersonnelSession(safeEmployee),
      employee: safeEmployee
    });
  } catch (error) {
    console.error('SRS personnel login error:', error);

    return res.status(401).json({
      success: false,
      message: error.message || 'Inloggen mislukt.'
    });
  }
}
