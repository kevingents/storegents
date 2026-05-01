import crypto from 'crypto';

const DEFAULT_TTL_SECONDS = 12 * 60 * 60;

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(value) {
  const secret = process.env.PERSONNEL_SESSION_SECRET || process.env.SRS_PERSONNEL_SECRET || '';

  if (!secret) {
    throw new Error('PERSONNEL_SESSION_SECRET ontbreekt in Vercel.');
  }

  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function safeJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function createPersonnelSession(employee, options = {}) {
  const ttlSeconds = Number(process.env.PERSONNEL_SESSION_TTL_SECONDS || DEFAULT_TTL_SECONDS);
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + ttlSeconds;

  const payload = {
    typ: 'gents-personnel-session',
    iat: issuedAt,
    exp: expiresAt,
    employee: {
      personnelId: String(employee.personnelId || ''),
      name: employee.name || employee.externalName || employee.internalName || '',
      internalName: employee.internalName || '',
      externalName: employee.externalName || '',
      personnelGroupId: String(employee.personnelGroupId || ''),
      branches: (employee.branches || []).map(String),
      stores: employee.stores || [],
      isMasterAdmin: Boolean(employee.isMasterAdmin || options.isMasterAdmin)
    }
  };

  const encodedPayload = base64url(JSON.stringify(payload));
  const signature = sign(encodedPayload);

  return `${encodedPayload}.${signature}`;
}

export function verifyPersonnelSession(token) {
  const raw = String(token || '').replace(/^Bearer\s+/i, '').trim();

  if (!raw || !raw.includes('.')) {
    throw new Error('Sessie ontbreekt. Log opnieuw in.');
  }

  const [encodedPayload, signature] = raw.split('.');
  const expected = sign(encodedPayload);

  try {
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new Error('Ongeldige sessie. Log opnieuw in.');
    }
  } catch {
    throw new Error('Ongeldige sessie. Log opnieuw in.');
  }

  const payload = safeJson(Buffer.from(encodedPayload, 'base64url').toString('utf8'));

  if (!payload || payload.typ !== 'gents-personnel-session') {
    throw new Error('Ongeldige sessie. Log opnieuw in.');
  }

  if (Number(payload.exp || 0) < Math.floor(Date.now() / 1000)) {
    throw new Error('Sessie verlopen. Log opnieuw in.');
  }

  return payload.employee;
}

export function getBearerToken(req) {
  return String(req.headers.authorization || req.headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
}
