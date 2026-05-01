import { handleCors, setCorsHeaders } from '../../../lib/cors.js';
import { createPersonnelSession } from '../../../lib/personnel-session.js';
import { findPersonnelForLogin, getAllConfiguredStores } from '../../../lib/srs-personnel-client.js';

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

    return res.status(200).json({
      success: true,
      sessionToken: createPersonnelSession(employee),
      employee
    });
  } catch (error) {
    console.error('SRS personnel login error:', error);

    return res.status(401).json({
      success: false,
      message: error.message || 'Inloggen mislukt.'
    });
  }
}
