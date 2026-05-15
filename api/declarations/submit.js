import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { createDeclaration } from '../../lib/declarations-store.js';
import { put } from '@vercel/blob';

function parseBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

async function uploadFile(req) {
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.includes('multipart/form-data')) return { fileName: '', fileUrl: '' };

  const { IncomingForm } = await import('formidable').catch(() => null) || {};
  if (!IncomingForm) return { fileName: '', fileUrl: '' };

  return new Promise((resolve) => {
    const form = new IncomingForm({ maxFileSize: 10 * 1024 * 1024 });
    form.parse(req, async (err, fields, files) => {
      if (err) return resolve({ fileName: '', fileUrl: '', fields: {} });
      const file = files?.file?.[0] || files?.file || null;
      if (!file) return resolve({ fileName: '', fileUrl: '', fields });

      try {
        const fs = await import('fs');
        const buffer = fs.readFileSync(file.filepath || file.path);
        const name = file.originalFilename || file.name || 'factuur';
        const mime = file.mimetype || file.type || 'application/octet-stream';
        const blobPath = `declarations/files/${Date.now()}-${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const blob = await put(blobPath, buffer, { access: 'public', allowOverwrite: false, contentType: mime });
        resolve({ fileName: name, fileUrl: blob.url, fields });
      } catch (uploadErr) {
        console.error('File upload fout:', uploadErr);
        resolve({ fileName: '', fileUrl: '', fields });
      }
    });
  });
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen POST is toegestaan.' });
  }

  try {
    let body = parseBody(req);
    let fileName = '';
    let fileUrl = '';

    const contentType = String(req.headers['content-type'] || '');
    if (contentType.includes('multipart/form-data')) {
      const result = await uploadFile(req);
      fileName = result.fileName || '';
      fileUrl = result.fileUrl || '';
      body = result.fields || body;
    }

    const store = String(body.store || body['contact[Winkel]'] || '').trim();
    const employeeName = String(body.employeeName || body['contact[Medewerker]'] || '').trim();
    const responsible = String(body.responsible || body['contact[Verantwoordelijke]'] || '').trim();
    const purpose = String(body.purpose || body['contact[Categorie]'] || '').trim();
    const amount = body.amount != null ? Number(body.amount) : null;
    const notes = String(body.notes || body['contact[Toelichting]'] || '').trim();
    const paidStatus = String(body.paidStatus || '').trim();
    const paidAt = String(body.paidAt || '').trim();
    const paymentMethod = String(body.paymentMethod || '').trim();

    if (!store) return res.status(400).json({ success: false, message: 'Winkel ontbreekt.' });
    if (!employeeName) return res.status(400).json({ success: false, message: 'Naam medewerker ontbreekt.' });
    if (!purpose) return res.status(400).json({ success: false, message: 'Categorie ontbreekt.' });
    if (amount == null || Number.isNaN(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Bedrag ontbreekt of is ongeldig.' });
    }

    const declaration = await createDeclaration({
      store,
      employeeName,
      responsible,
      purpose,
      amount,
      notes,
      fileName,
      fileUrl,
      status: 'Ingediend',
      paidAt: paidStatus === 'yes' ? paidAt : '',
      paymentMethod: paidStatus === 'yes' ? paymentMethod : ''
    });

    return res.status(200).json({
      success: true,
      message: 'Declaratie ingediend.',
      declaration
    });
  } catch (error) {
    console.error('Declaratie submit fout:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Declaratie kon niet worden ingediend.'
    });
  }
}
