/**
 * Cron-guard: helper die elke cron-handler aan het begin aanroept om te
 * checken of de admin de cron heeft uitgezet / vertraagd.
 *
 * Gebruik in cron-handler:
 *
 *   import { guardCron, finishCron } from '../../lib/cron-guard.js';
 *
 *   export default async function handler(req, res) {
 *     const guard = await guardCron('daily-loyalty-vouchers', req);
 *     if (guard.skip) return res.status(200).json({ skipped: true, reason: guard.reason });
 *     ...doe de cron-werk...
 *     await finishCron('daily-loyalty-vouchers', { status: 'success', durationMs: 1234 });
 *     return res.status(200).json({...});
 *   }
 *
 * Skip-regels:
 *   - enabled === false  -> altijd skippen
 *   - lastRun + minIntervalMin > now -> skippen (rate limit)
 *   - manueel trigger (?force=true) -> ALTIJD draaien (override)
 */

import {
  getCronConfig,
  getEffectiveCronConfig,
  recordCronRun
} from './cron-config-store.js';

/**
 * Check of de cron mag draaien op dit moment.
 * Returnt { skip: bool, reason: string, config }
 */
export async function guardCron(key, req) {
  /* Handmatige trigger heeft voorrang op alle skip-regels */
  const force = req?.query?.force === 'true' || req?.query?.force === '1';
  const override = await getCronConfig(key);
  const config = getEffectiveCronConfig(key, override);

  if (force) {
    return { skip: false, reason: 'force-triggered', config, forced: true };
  }

  if (config.enabled === false) {
    return { skip: true, reason: 'cron-disabled-by-admin', config };
  }

  if (config.lastRun && config.minIntervalMin > 0) {
    const lastMs = new Date(config.lastRun).getTime();
    if (Number.isFinite(lastMs)) {
      const elapsedMin = (Date.now() - lastMs) / 60000;
      if (elapsedMin < config.minIntervalMin) {
        const remaining = Math.round(config.minIntervalMin - elapsedMin);
        return {
          skip: true,
          reason: `rate-limited-${remaining}min-remaining`,
          config,
          elapsedMin: Math.round(elapsedMin),
          minIntervalMin: config.minIntervalMin
        };
      }
    }
  }

  return { skip: false, reason: 'allowed', config };
}

/**
 * Markeer dat de cron is afgerond. Werkt enabled-flag bij + lastRun/status.
 */
export async function finishCron(key, { status = 'success', durationMs = 0, error = '', summary = null } = {}) {
  try {
    await recordCronRun(key, { status, durationMs, error, summary });
  } catch (err) {
    console.warn(`[cron-guard] recordCronRun faalde voor ${key}:`, err.message);
  }
}

/**
 * Wrapper voor de meeste cron-handlers: guard + run + finish in 1.
 *
 *   return runGuarded('cron-key', req, res, async () => {
 *     // doe de cron-werk
 *     return { vouchersCreated: 12 };
 *   });
 */
export async function runGuarded(key, req, res, fn) {
  const startedAt = Date.now();
  const guard = await guardCron(key, req);
  if (guard.skip) {
    return res.status(200).json({
      success: true,
      skipped: true,
      reason: guard.reason,
      config: {
        enabled: guard.config.enabled,
        minIntervalMin: guard.config.minIntervalMin,
        lastRun: guard.config.lastRun
      },
      ...(guard.elapsedMin !== undefined ? { elapsedMin: guard.elapsedMin } : {})
    });
  }
  try {
    const result = await fn();
    await finishCron(key, {
      status: 'success',
      durationMs: Date.now() - startedAt,
      summary: result && typeof result === 'object' ? result : null
    });
    return res.status(200).json({
      success: true,
      forced: Boolean(guard.forced),
      result
    });
  } catch (error) {
    await finishCron(key, {
      status: 'failed',
      durationMs: Date.now() - startedAt,
      error: error.message || String(error)
    });
    return res.status(500).json({
      success: false,
      message: error.message || 'Cron faalde.'
    });
  }
}
