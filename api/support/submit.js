import formidable from 'formidable';
import fs from 'fs';
import { put } from '@vercel/blob';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { sendMail, baseMailHtml } from '../../lib/gents-mailer.js';
import { createSupportTicket } from '../../lib/support-tickets-store.js';

export const config = {
  api: {
    bodyParser: false
  }
};

const ALLOWED_PRIORITIES = new Set(['low', 'medium', 'high', 'urgent']);
const PRIORITY_LABEL = { low: 'Laag', medium: 'Medium', high: 'Hoog', urgent: 'Urgent' };
const ALLOWED_FILE_EXT = /\.(pdf|jpg|jpeg|png|heic|webp|gif)$/i;

function parseMultipart(req) {
  const form = formidable({
    multiples: false,
    maxFileSize: 10 * 1024 * 1024,
    keepExtensions: true
  });
  return new Promise((resolve, reject) => {
    form.parse(req, (error, fields, files) => {
      if (error) reject(error);
      else resolve({ fields, files });
    });
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function field(value) {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function safeFileName(fileName) {
  return String(fileName || 'support-upload')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function getSupportEmail() {
  return String(process.env.SUPPORT_EMAIL || process.env.ADMIN_EMAIL || '').trim();
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen POST is toegestaan.' });
  }

  /* Body parsing: multipart voor bijlage, anders JSON */
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  let fields = {};
  let files = {};
  try {
    if (contentType.startsWith('multipart/form-data')) {
      const parsed = await parseMultipart(req);
      fields = parsed.fields || {};
      files = parsed.files || {};
    } else {
      fields = await readJsonBody(req);
    }
  } catch (error) {
    return res.status(400).json({ success: false, message: 'Form kon niet worden verwerkt: ' + (error.message || 'onbekend') });
  }

  const store        = String(field(fields.store) || field(fields['contact[Winkel]']) || '').trim();
  const employeeName = String(field(fields.employeeName) || field(fields.employee) || field(fields.medewerker) || field(fields['contact[Medewerker]']) || '').trim();
  const subject      = String(field(fields.subject) || field(fields['contact[Onderwerp]']) || '').trim();
  const description  = String(field(fields.description) || field(fields['contact[Omschrijving]']) || '').trim();
  const priorityRaw  = String(field(fields.priority) || 'medium').toLowerCase().trim();
  const priority     = ALLOWED_PRIORITIES.has(priorityRaw) ? priorityRaw : 'medium';

  if (!employeeName) return res.status(400).json({ success: false, message: 'Naam medewerker ontbreekt.' });
  if (!subject) return res.status(400).json({ success: false, message: 'Onderwerp ontbreekt.' });
  if (!description) return res.status(400).json({ success: false, message: 'Omschrijving ontbreekt.' });

  /* Bijlage uploaden (optioneel) */
  let attachmentUrl = '';
  let attachmentName = '';
  const uploadedFile = files.attachment || files.bijlage || files.file;
  const file = Array.isArray(uploadedFile) ? uploadedFile[0] : uploadedFile;
  if (file && file.filepath) {
    const fileName = file.originalFilename || 'bijlage';
    if (!ALLOWED_FILE_EXT.test(fileName)) {
      return res.status(400).json({ success: false, message: 'Bijlage type wordt niet ondersteund. Gebruik PDF, JPG, PNG, GIF, HEIC of WEBP.' });
    }
    try {
      const content = fs.readFileSync(file.filepath);
      const cleanName = safeFileName(fileName);
      const blobPath = `support/files/${Date.now()}-${cleanName}`;
      const uploaded = await put(blobPath, content, {
        access: 'public',
        addRandomSuffix: false,
        contentType: file.mimetype || 'application/octet-stream'
      });
      attachmentUrl = uploaded.url || '';
      attachmentName = cleanName;
    } catch (error) {
      return res.status(500).json({ success: false, message: 'Bijlage uploaden mislukt: ' + (error.message || 'onbekend') });
    }
  }

  /* Ticket opslaan in tickets-store */
  let ticket = null;
  try {
    ticket = await createSupportTicket({
      store,
      employeeName,
      subject,
      description,
      priority,
      attachmentUrl,
      attachmentName
    });
  } catch (error) {
    console.error('Support ticket store error:', error);
    /* niet blokkerend — email proberen we alsnog */
  }

  /* Email versturen (best-effort) */
  let emailSent = false;
  let emailError = '';
  const to = getSupportEmail();
  if (to) {
    try {
      const priorityLabel = PRIORITY_LABEL[priority] || priority;
      const attachmentRow = attachmentUrl
        ? `<tr><td style="padding:8px 0;font-size:14px;color:#3a4a5a;font-weight:700;">Bijlage</td><td style="padding:8px 0;font-size:14px;color:#0a1f33;"><a href="${attachmentUrl}" target="_blank">${attachmentName || 'bekijken'}</a></td></tr>`
        : '';

      const html = baseMailHtml({
        title: `Support [${priorityLabel}]: ${subject}`,
        intro: `Nieuwe supportmelding via het GENTS Winkelportaal.`,
        bodyHtml: `
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
            <tr><td style="padding:8px 0;border-bottom:1px solid #eef2f7;font-size:14px;color:#3a4a5a;width:140px;font-weight:700;">Winkel</td><td style="padding:8px 0;border-bottom:1px solid #eef2f7;font-size:14px;color:#0a1f33;">${store || '(niet opgegeven)'}</td></tr>
            <tr><td style="padding:8px 0;border-bottom:1px solid #eef2f7;font-size:14px;color:#3a4a5a;font-weight:700;">Medewerker</td><td style="padding:8px 0;border-bottom:1px solid #eef2f7;font-size:14px;color:#0a1f33;">${employeeName}</td></tr>
            <tr><td style="padding:8px 0;border-bottom:1px solid #eef2f7;font-size:14px;color:#3a4a5a;font-weight:700;">Prioriteit</td><td style="padding:8px 0;border-bottom:1px solid #eef2f7;font-size:14px;color:#0a1f33;">${priorityLabel}</td></tr>
            <tr><td style="padding:8px 0;border-bottom:1px solid #eef2f7;font-size:14px;color:#3a4a5a;font-weight:700;">Onderwerp</td><td style="padding:8px 0;border-bottom:1px solid #eef2f7;font-size:14px;color:#0a1f33;">${subject}</td></tr>
            <tr><td style="padding:8px 0;${attachmentRow ? 'border-bottom:1px solid #eef2f7;' : ''}font-size:14px;color:#3a4a5a;font-weight:700;vertical-align:top;">Omschrijving</td><td style="padding:8px 0;${attachmentRow ? 'border-bottom:1px solid #eef2f7;' : ''}font-size:14px;color:#0a1f33;white-space:pre-line;">${description}</td></tr>
            ${attachmentRow}
          </table>`,
        footer: 'Automatisch verstuurd vanuit het GENTS Winkelportaal — supportformulier.'
      });

      await sendMail({
        to,
        subject: `[Support ${priorityLabel}] ${subject} — ${store || employeeName}`,
        html,
        text: `Winkel: ${store}\nMedewerker: ${employeeName}\nPrioriteit: ${priorityLabel}\nOnderwerp: ${subject}\n${attachmentUrl ? 'Bijlage: ' + attachmentUrl + '\n' : ''}\n${description}`
      });
      emailSent = true;
    } catch (error) {
      console.error('Support email fout:', error);
      emailError = error.message || 'email mislukt';
    }
  }

  return res.status(200).json({
    success: true,
    message: emailSent ? 'Supportmelding verstuurd en opgeslagen.' : 'Supportmelding opgeslagen' + (emailError ? ' (email mislukt: ' + emailError + ')' : ' (email niet geconfigureerd)'),
    ticket,
    emailSent
  });
}
