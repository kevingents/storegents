import formidable from 'formidable';
import fs from 'fs';
import { put } from '@vercel/blob';
import { createDeclaration } from '../lib/declarations-store.js';
import { sendDeclarationEmail } from '../lib/resend-mailer.js';
import { handleCors, setCorsHeaders } from '../lib/cors.js';

export const config = {
  api: {
    bodyParser: false
  }
};

function parseForm(req) {
  const form = formidable({
    multiples: false,
    maxFileSize: 10 * 1024 * 1024,
    keepExtensions: true
  });

  return new Promise((resolve, reject) => {
    form.parse(req, (error, fields, files) => {
      if (error) {
        reject(error);
      } else {
        resolve({ fields, files });
      }
    });
  });
}

function field(value) {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function safeFileName(fileName) {
  return String(fileName || 'factuur-upload')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);

  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      message: 'Alleen POST is toegestaan.'
    });
  }

  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return res.status(500).json({
        success: false,
        message: 'BLOB_READ_WRITE_TOKEN ontbreekt in Vercel Environment Variables.'
      });
    }

    const { fields, files } = await parseForm(req);

    const store = field(fields.store).trim();
    const employeeName = field(fields.employeeName).trim();
    const responsible = field(fields.responsible).trim();
    const purpose = field(fields.purpose).trim();
    const notes = field(fields.notes).trim();
    const signed = field(fields.signed).trim();

    const uploadedFile = Array.isArray(files.invoiceFile)
      ? files.invoiceFile[0]
      : files.invoiceFile;

    if (!store || !employeeName || !responsible || !purpose || !uploadedFile) {
      return res.status(400).json({
        success: false,
        message: 'Niet alle verplichte gegevens zijn ingevuld.'
      });
    }

    if (signed !== 'Ja') {
      return res.status(400).json({
        success: false,
        message: 'Het document moet ondertekend zijn voordat de declaratie kan worden ingediend.'
      });
    }

    const allowedPurposes = [
      'Eten/drinken',
      'Vermaakkosten',
      'Facilitaire kosten'
    ];

    if (!allowedPurposes.includes(purpose)) {
      return res.status(400).json({
        success: false,
        message: 'Ongeldige categorie.'
      });
    }

    const fileName = uploadedFile.originalFilename || 'factuur-upload';
    const filePath = uploadedFile.filepath;

    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(400).json({
        success: false,
        message: 'Bestand kon niet worden verwerkt.'
      });
    }

    const allowedExtensions = /\.(pdf|jpg|jpeg|png|heic|webp)$/i;

    if (!allowedExtensions.test(fileName)) {
      return res.status(400).json({
        success: false,
        message: 'Upload een geldig bestand: PDF, JPG, PNG, HEIC of WEBP.'
      });
    }

    const fileContent = fs.readFileSync(filePath);
    const cleanFileName = safeFileName(fileName);
    const blobPath = `declarations/files/${Date.now()}-${cleanFileName}`;

    const uploadedBlob = await put(blobPath, fileContent, {
      access: 'public',
      addRandomSuffix: false,
      contentType: uploadedFile.mimetype || 'application/octet-stream'
    });

    const declaration = await createDeclaration({
      store,
      employeeName,
      responsible,
      purpose,
      notes,
      fileName,
      fileUrl: uploadedBlob.url
    });

    await sendDeclarationEmail({
      declaration,
      store: escapeHtml(store),
      employeeName: escapeHtml(employeeName),
      responsible: escapeHtml(responsible),
      purpose: escapeHtml(purpose),
      notes: escapeHtml(notes),
      signed: escapeHtml(signed),
      fileName,
      fileContent
    });

    return res.status(200).json({
      success: true,
      message: 'Declaratie succesvol verzonden.',
      declaration
    });
  } catch (error) {
    console.error('Invoice upload error:', error);

    return res.status(500).json({
      success: false,
      message: error.message || 'Er ging iets mis bij het verwerken van de declaratie.'
    });
  }
}
