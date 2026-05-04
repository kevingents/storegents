import { handleCors, setCorsHeaders } from '../../lib/cors.js';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '12345';

function isAdmin(req) {
  if (String(req.query.public || '') === 'true') return true;

  const token = String(
    req.headers['x-admin-token'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();

  return token === ADMIN_TOKEN;
}

function nowIso() {
  return new Date().toISOString();
}

function baseUrlFromReq(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host;
  return `${proto}://${host}`;
}

function safeMessage(error) {
  return error?.message || String(error || 'Onbekende fout');
}

async function checkJsonService({ key, label, url, timeoutMs = 12000 }) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'x-admin-token': ADMIN_TOKEN
      }
    });

    const text = await response.text();
    let data = {};

    try {
      data = text ? JSON.parse(text) : {};
    } catch (_error) {
      data = { message: text };
    }

    const durationMs = Date.now() - startedAt;
    const degraded = Boolean(data.degraded);
    const success = response.ok && data.success !== false;

    let status = 'ok';

    if (!success) status = 'error';
    else if (degraded) status = 'warning';

    return {
      key,
      label,
      status,
      ok: success,
      degraded,
      durationMs,
      checkedAt: nowIso(),
      message:
        data.note ||
        data.message ||
        data.error ||
        (success ? 'Endpoint werkt.' : 'Endpoint gaf een fout terug.'),
      meta: {
        httpStatus: response.status,
        source: data.source || '',
        total:
          data.totals?.openCount ??
          data.summary?.totalOpenCount ??
          data.open ??
          data.count ??
          null,
        overdue:
          data.totals?.overdueCount ??
          data.summary?.overdueCount ??
          data.overdue ??
          data.overdueCount ??
          null
      }
    };
  } catch (error) {
    return {
      key,
      label,
      status: 'error',
      ok: false,
      degraded: false,
      durationMs: Date.now() - startedAt,
      checkedAt: nowIso(),
      message: error.name === 'AbortError'
        ? `Timeout na ${timeoutMs / 1000} seconden.`
        : safeMessage(error),
      meta: {}
    };
  } finally {
    clearTimeout(timer);
  }
}

function overallStatus(services) {
  if (services.some(service => service.status === 'error')) return 'error';
  if (services.some(service => service.status === 'warning')) return 'warning';
  return 'ok';
}

function buildLogs(services) {
  return services.map(service => ({
    time: service.checkedAt,
    level: service.status,
    title: service.label,
    message: service.message,
    durationMs: service.durationMs
  }));
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      message: 'Alleen GET is toegestaan.'
    });
  }

  if (!isAdmin(req)) {
    return res.status(401).json({
      success: false,
      message: 'Niet bevoegd.'
    });
  }

  const baseUrl = baseUrlFromReq(req);
  const sampleStore = String(req.query.store || 'GENTS Utrecht').trim();

  const services = await Promise.all([
    checkJsonService({
      key: 'weborders_srs',
      label: 'SRS openstaande weborders',
      url: `${baseUrl}/api/admin/weborders/overdue-report?adminToken=${encodeURIComponent(ADMIN_TOKEN)}&t=${Date.now()}`,
      timeoutMs: 30000
    }),
    checkJsonService({
      key: 'store_weborders',
      label: 'Winkel openstaande orders',
      url: `${baseUrl}/api/srs/open-weborders?store=${encodeURIComponent(sampleStore)}&adminToken=${encodeURIComponent(ADMIN_TOKEN)}&t=${Date.now()}`,
      timeoutMs: 30000
    }),
    checkJsonService({
      key: 'exchanges',
      label: 'SRS uitwisselingen',
      url: `${baseUrl}/api/srs/exchanges/open?store=${encodeURIComponent(sampleStore)}&summary=true&adminToken=${encodeURIComponent(ADMIN_TOKEN)}&t=${Date.now()}`,
      timeoutMs: 30000
    }),
    checkJsonService({
      key: 'pickup_orders',
      label: 'Shopify ophaalorders',
      url: `${baseUrl}/api/pickup-orders?store=${encodeURIComponent(sampleStore)}&status=open&days=1&adminToken=${encodeURIComponent(ADMIN_TOKEN)}&t=${Date.now()}`,
      timeoutMs: 30000
    }),
    checkJsonService({
      key: 'declarations',
      label: 'Declaraties',
      url: `${baseUrl}/api/declarations?store=${encodeURIComponent(sampleStore)}&adminToken=${encodeURIComponent(ADMIN_TOKEN)}&t=${Date.now()}`,
      timeoutMs: 15000
    }),
    checkJsonService({
      key: 'weborder_health',
      label: 'Weborder API health',
      url: `${baseUrl}/api/weborders/health?adminToken=${encodeURIComponent(ADMIN_TOKEN)}&t=${Date.now()}`,
      timeoutMs: 15000
    })
  ]);

  return res.status(200).json({
    success: true,
    checkedAt: nowIso(),
    overallStatus: overallStatus(services),
    sampleStore,
    services,
    logs: buildLogs(services)
  });
}
