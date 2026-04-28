import { updateDeclaration } from '../../../lib/declarations-store.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || '12345';
  return req.headers['x-admin-token'] === adminToken;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['PATCH', 'OPTIONS'])) return;
  setCorsHeaders(res, ['PATCH', 'OPTIONS']);

  if (!isAuthorized(req)) {
    return res.status(401).json({
      success: false,
      message: 'Niet bevoegd.'
    });
  }

  if (req.method !== 'PATCH') {
    return res.status(405).json({
      success: false,
      message: 'Alleen PATCH is toegestaan.'
    });
  }

  try {
    const id = req.query.id;
    const { status, paidAt, adminNote } = req.body || {};

    const allowedStatuses = [
      'Ingediend',
      'In behandeling',
      'Goedgekeurd',
      'Afgekeurd',
      'Betaald'
    ];

    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Declaratie ID ontbreekt.'
      });
    }

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Ongeldige status.'
      });
    }

    if (status === 'Betaald' && !paidAt) {
      return res.status(400).json({
        success: false,
        message: 'Betaaldatum is verplicht wanneer status Betaald is.'
      });
    }

    const updated = updateDeclaration(id, {
      status,
      paidAt: status === 'Betaald' ? paidAt : '',
      adminNote: adminNote || ''
    });

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'Declaratie niet gevonden.'
      });
    }

    return res.status(200).json({
      success: true,
      declaration: updated
    });
  } catch (error) {
    console.error('Update declaration error:', error);

    return res.status(500).json({
      success: false,
      message: 'Declaratie kon niet worden bijgewerkt.'
    });
  }
}
