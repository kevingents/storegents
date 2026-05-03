import SftpClient from 'ssh2-sftp-client';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || '12345';
  return String(req.headers['x-admin-token'] || req.query.adminToken || '').trim() === adminToken;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const sftp = new SftpClient();

  try {
    const host = process.env.SRS_STOCK_SFTP_HOST;
    const port = Number(process.env.SRS_STOCK_SFTP_PORT || 22);
    const username = process.env.SRS_STOCK_SFTP_USER;
    const password = process.env.SRS_STOCK_SFTP_PASSWORD;
    const folder = String(req.query.folder || process.env.SRS_STOCK_DELTA_FOLDER || '/production/stock/delta');

    if (!host || !username || !password) {
      return res.status(400).json({
        success: false,
        message: 'SFTP configuratie mist host, user of password.',
        hasHost: Boolean(host),
        hasUser: Boolean(username),
        hasPassword: Boolean(password)
      });
    }

    await sftp.connect({
      host,
      port,
      username,
      password,
      readyTimeout: 30000,
      retries: 0
    });

    const files = await sftp.list(folder);

    return res.status(200).json({
      success: true,
      host,
      port,
      username,
      folder,
      count: files.length,
      files: files.slice(0, 20).map((file) => ({
        name: file.name,
        type: file.type,
        size: file.size,
        modifyTime: file.modifyTime
      }))
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
      code: error.code || '',
      level: error.level || '',
      hint: 'Als authentication faalt: controleer wachtwoord exact of vraag SRS of key-auth nodig is.'
    });
  } finally {
    try {
      await sftp.end();
    } catch (_error) {}
  }
}
