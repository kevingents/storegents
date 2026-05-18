import { put, list } from '@vercel/blob';

/**
 * System alert state — bewaart laatste gezien storing per service zodat
 * notificaties pas verstuurd worden als de storing langer duurt dan threshold
 * (voorkomt spam bij korte flaps).
 *
 * Bestand: system-alerts/state.json
 * Structuur:
 * {
 *   services: {
 *     'shopify_admin': { firstSeenAt, status, lastNotifiedAt, notifyCount },
 *     ...
 *   },
 *   updatedAt
 * }
 */

const STATE_PATH = 'system-alerts/state.json';

async function readBlobText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('Alert-state niet leesbaar');
  return r.text();
}

export async function getAlertState() {
  try {
    const result = await list({ prefix: STATE_PATH, limit: 1 });
    const blob = result.blobs.find((b) => b.pathname === STATE_PATH);
    if (!blob) return { services: {}, updatedAt: null };
    const raw = await readBlobText(blob.url);
    return JSON.parse(raw || '{}');
  } catch { return { services: {}, updatedAt: null }; }
}

export async function saveAlertState(state) {
  await put(STATE_PATH, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 30
  });
}

/**
 * Bekijk service-statuses van system-health en bepaal welke notifications
 * verstuurd moeten worden. Returnt array van { service, message, severity }.
 *
 * Threshold: storing moet ≥ ALERT_THRESHOLD_MIN minuten aanhouden voor notif.
 * Re-notify na NOTIFY_COOLDOWN_MIN minuten als storing aanhoudt.
 */
const ALERT_THRESHOLD_MIN = Number(process.env.SYSTEM_ALERT_THRESHOLD_MIN || 10);
const NOTIFY_COOLDOWN_MIN = Number(process.env.SYSTEM_ALERT_COOLDOWN_MIN || 60);

export async function evaluateAlerts(services) {
  const state = await getAlertState();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const toNotify = [];

  for (const service of services || []) {
    const key = service.key;
    const cur = state.services[key] || null;
    const isProblem = service.status === 'error' || service.status === 'warning';

    if (!isProblem) {
      /* Service herstelt → clear state + notify recovery indien er een actieve was */
      if (cur && cur.status !== 'recovered') {
        toNotify.push({
          service: service.label || key,
          serviceKey: key,
          severity: 'recovered',
          message: `Service '${service.label}' is hersteld na ${humanDuration(now - new Date(cur.firstSeenAt).getTime())}.`,
          firstSeenAt: cur.firstSeenAt
        });
        delete state.services[key];
      }
      continue;
    }

    /* Service has problem */
    if (!cur || cur.status !== service.status) {
      /* Eerste keer of status veranderd → start nieuwe periode */
      state.services[key] = {
        firstSeenAt: nowIso,
        status: service.status,
        lastNotifiedAt: null,
        notifyCount: 0,
        message: service.message || ''
      };
      continue;
    }

    /* Bestaande problem — check threshold + cooldown */
    const ageMin = (now - new Date(cur.firstSeenAt).getTime()) / 60000;
    const lastNotifyAgeMin = cur.lastNotifiedAt ? (now - new Date(cur.lastNotifiedAt).getTime()) / 60000 : Infinity;

    if (ageMin >= ALERT_THRESHOLD_MIN && lastNotifyAgeMin >= NOTIFY_COOLDOWN_MIN) {
      toNotify.push({
        service: service.label || key,
        serviceKey: key,
        severity: service.status,
        message: `Service '${service.label}' is al ${humanDuration(ageMin * 60000)} ${service.status === 'error' ? 'in storing' : 'in waarschuwing'}: ${service.message}`,
        firstSeenAt: cur.firstSeenAt,
        notifyCount: (cur.notifyCount || 0) + 1
      });
      cur.lastNotifiedAt = nowIso;
      cur.notifyCount = (cur.notifyCount || 0) + 1;
    }
  }

  await saveAlertState(state);
  return { toNotify, state };
}

function humanDuration(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return `${h}u ${m}min`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}u`;
}
