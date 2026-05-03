import SftpClient from 'ssh2-sftp-client';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || '12345';
  const incoming = String(req.headers['x-admin-token'] || req.query.adminToken || '').trim();
  return incoming === adminToken;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  const sftp = new SftpClient();

  try {
    const host = String(process.env.SRS_STOCK_SFTP_HOST || '').trim();
    const port = Number(process.env.SRS_STOCK_SFTP_PORT || 22);
    const username = String(process.env.SRS_STOCK_SFTP_USER || '').trim();
    const password = String(process.env.SRS_STOCK_SFTP_PASSWORD || '');

    const mode = String(req.query.mode || 'delta').toLowerCase() === 'full' ? 'full' : 'delta';
    const folder = mode === 'full'
      ? String(process.env.SRS_STOCK_FULL_FOLDER || '/production/stock/full').trim()
      : String(process.env.SRS_STOCK_DELTA_FOLDER || '/production/stock/delta').trim();

    await sftp.connect({
      host,
      port,
      username,
      password,
      readyTimeout: 30000,
      retries: 0
    });

    const files = await sftp.list(folder);
    const xmlFiles = files
      .filter((file) => file.type !== 'd' && /\.xml$/i.test(file.name || ''))
      .sort((a, b) => Number(b.modifyTime || 0) - Number(a.modifyTime || 0));

    if (!xmlFiles.length) {
      return res.status(404).json({
        success: false,
        message: `Geen XML-bestanden gevonden in ${folder}.`,
        folder,
        files: files.map((file) => file.name)
      });
    }

    const file = xmlFiles[0];
    const path = `${folder.replace(/\/$/, '')}/${file.name}`;
    const buffer = await sftp.get(path);
    const xml = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');

    return res.status(200).json({
      success: true,
      mode,
      folder,
      file: {
        name: file.name,
        path,
        size: file.size,
        modifyTime: file.modifyTime,
        modifiedAt: file.modifyTime ? new Date(file.modifyTime).toISOString() : ''
      },
      xmlPreview: xml.slice(0, 5000)
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
      code: error.code || ''
    });
  } finally {
    try {
      await sftp.end();
    } catch (_error) {}
  }
}
