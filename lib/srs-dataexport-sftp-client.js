/**
 * lib/srs-dataexport-sftp-client.js
 *
 * SFTP-koppeling met de SRS data-export server (transfer.srs.nl:50022).
 * Hier komen de periodieke exports (productinformatie, klant-exports,
 * eventueel ander materiaal). Voor de SRS stock-exports is er een aparte
 * client (srs-stock-sftp-client.js) met eigen credentials.
 *
 * ENV vars (Vercel project settings):
 *   SRS_DATAEXPORT_SFTP_HOST     bv. transfer.srs.nl
 *   SRS_DATAEXPORT_SFTP_PORT     bv. 50022
 *   SRS_DATAEXPORT_SFTP_USER     bv. 1088_dataexport
 *   SRS_DATAEXPORT_SFTP_PASSWORD wachtwoord
 *
 * NIET in code committen — alleen env vars.
 */

import SftpClient from 'ssh2-sftp-client';

const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024; /* 5 MB hard cap voor preview/download */
const DEFAULT_TIMEOUT_MS = 30_000;

function env(name, fallback = '') {
  return process.env[name] || fallback;
}

function sftpConfig() {
  const host = env('SRS_DATAEXPORT_SFTP_HOST');
  const username = env('SRS_DATAEXPORT_SFTP_USER');
  const password = env('SRS_DATAEXPORT_SFTP_PASSWORD');
  const port = Number(env('SRS_DATAEXPORT_SFTP_PORT', '50022')) || 50022;

  if (!host || !username || !password) {
    throw new Error(
      'SRS_DATAEXPORT_SFTP_* configuratie ontbreekt. ' +
      'Vereist: SRS_DATAEXPORT_SFTP_HOST, _PORT, _USER, _PASSWORD in Vercel env vars.'
    );
  }
  return { host, port, username, password, readyTimeout: DEFAULT_TIMEOUT_MS };
}

/**
 * Path-traversal beveiliging: weiger `..` segmenten en niet-absolute paden.
 * Lege string → '/' (root). Eindigt nooit op trailing slash behalve root zelf.
 */
function safePath(input) {
  let p = String(input || '/').trim();
  if (!p.startsWith('/')) p = '/' + p;
  /* Strip `..` en `~` segmenten */
  const parts = p.split('/').filter((s) => s && s !== '..' && s !== '~' && !s.includes('\0'));
  return '/' + parts.join('/');
}

/**
 * Voer meerdere SFTP-operaties uit binnen ÉÉN verbinding. Veel sneller dan
 * losse connect/end per operatie (SFTP-handshake kost ~2-5s).
 *
 * Gebruik:
 *   const result = await withSftp(async (sftp) => {
 *     const entries = await sftp.list('/');
 *     const buf = await sftp.get('/foo.csv.gz');
 *     return { entries, buf };
 *   });
 */
export async function withSftp(fn) {
  const sftp = new SftpClient();
  try {
    await sftp.connect(sftpConfig());
    return await fn(sftp);
  } finally {
    try { await sftp.end(); } catch (_) {}
  }
}

/**
 * Lijst de inhoud van een directory.
 * Returnt: [{ name, type ('d'|'-'|'l'), size, modifyTime, mode }, ...]
 */
export async function listDirectory(remotePath = '/') {
  const sftp = new SftpClient();
  const path = safePath(remotePath);
  try {
    await sftp.connect(sftpConfig());
    const entries = await sftp.list(path);
    return {
      path,
      entries: entries.map((e) => ({
        name: e.name,
        type: e.type, /* '-' file, 'd' dir, 'l' symlink */
        size: Number(e.size || 0),
        modifyTime: e.modifyTime ? new Date(e.modifyTime).toISOString() : '',
        accessTime: e.accessTime ? new Date(e.accessTime).toISOString() : '',
        owner: e.owner || '',
        group: e.group || '',
        rights: e.rights || null
      }))
    };
  } finally {
    try { await sftp.end(); } catch (_) {}
  }
}

/**
 * Download bestand-inhoud. Returnt Buffer.
 * Throws bij paden > MAX_DOWNLOAD_BYTES.
 */
export async function downloadFile(remotePath) {
  const sftp = new SftpClient();
  const path = safePath(remotePath);
  try {
    await sftp.connect(sftpConfig());
    /* Check size eerst — voorkomt OOM op grote bestanden */
    const stat = await sftp.stat(path);
    if (Number(stat.size) > MAX_DOWNLOAD_BYTES) {
      throw new Error(
        `Bestand is te groot (${(stat.size / 1024 / 1024).toFixed(1)} MB). ` +
        `Max ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB. ` +
        `Gebruik 'preview' voor eerste regels.`
      );
    }
    const buf = await sftp.get(path);
    return { content: buf, size: Number(stat.size), modifyTime: stat.modifyTime ? new Date(stat.modifyTime).toISOString() : '' };
  } finally {
    try { await sftp.end(); } catch (_) {}
  }
}

/**
 * Preview: returnt eerste `maxBytes` bytes als string (text). Voor inkijken
 * van grote CSV/XML zonder volledig te downloaden.
 */
export async function previewFile(remotePath, maxBytes = 64 * 1024) {
  const sftp = new SftpClient();
  const path = safePath(remotePath);
  try {
    await sftp.connect(sftpConfig());
    const stat = await sftp.stat(path);
    const buf = await sftp.get(path); /* lib heeft geen native range-read, dus volledig + slice */
    const totalSize = Number(stat.size || buf.length);
    const sliced = Buffer.isBuffer(buf) ? buf.slice(0, maxBytes) : Buffer.from(String(buf)).slice(0, maxBytes);
    return {
      preview: sliced.toString('utf8'),
      previewBytes: sliced.length,
      totalSize,
      truncated: totalSize > sliced.length,
      modifyTime: stat.modifyTime ? new Date(stat.modifyTime).toISOString() : ''
    };
  } finally {
    try { await sftp.end(); } catch (_) {}
  }
}

/**
 * Smoke-test connectie — list root, return alleen success/errors.
 * Voor system-health check.
 */
export async function testConnection() {
  try {
    const result = await listDirectory('/');
    return { success: true, entryCount: result.entries.length, host: env('SRS_DATAEXPORT_SFTP_HOST') };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
