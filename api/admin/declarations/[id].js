import { updateDeclaration } from '../../../lib/declarations-store.js';

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN;

  if (!adminToken) {
    return true;
  }

  return req.headers['x-admin-token'] === adminToken;
}

export default async function handler(req, res) {
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

  const id = req.query.id;
  const { status, paidAt, adminNote } = req.body || {};

  const allowedStatuses = [
    'Ingediend',
    'In behandeling',
    'Goedgekeurd',
    'Afgekeurd',
    'Betaald'
  ];

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
}
