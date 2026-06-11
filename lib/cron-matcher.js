/**
 * lib/cron-matcher.js
 *
 * Minimale cron-matcher voor de dispatcher (api/cron/dispatch.js). Ondersteunt
 * standaard 5-velds expressies: `minuut uur dag-vd-maand maand dag-vd-week`.
 *
 * Per veld:
 *   '*'            alles
 *   'a'            losse waarde
 *   'a,b,c'        lijst
 *   'a-b'          range
 *   '*\/n'          stap vanaf veld-minimum (bv. '*\/5' = 0,5,10,…)
 *   'a-b/n'        stap binnen range
 *
 * Matching gebeurt in **UTC** — exact zoals Vercel native crons draaien — zodat
 * het samenvoegen van losse crons naar één dispatcher GÉÉN gedragsverandering
 * geeft. Dag-van-week: 0=zondag..6=zaterdag (cron staat 7=zondag ook toe).
 *
 * Cron-quirk: zijn ZOWEL dag-vd-maand als dag-vd-week beperkt (geen '*'), dan
 * matcht de dag als één van beide matcht (OR); anders AND.
 */

function fieldMatches(field, value, min, max) {
  for (const partRaw of String(field).split(",")) {
    const part = partRaw.trim();
    if (part === "*") return true;
    let range = part;
    let step = 1;
    if (part.includes("/")) {
      const [r, s] = part.split("/");
      range = r.trim();
      step = parseInt(s, 10);
      if (!Number.isFinite(step) || step <= 0) continue;
    }
    let lo, hi;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = parseInt(a, 10);
      hi = parseInt(b, 10);
    } else {
      lo = hi = parseInt(range, 10);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    if (value < lo || value > hi) continue;
    if ((value - lo) % step === 0) return true;
  }
  return false;
}

/** True als `schedule` (5-velds cron) op tijdstip `date` (UTC) moet draaien. */
export function isDue(schedule, date = new Date()) {
  const parts = String(schedule).trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minF, hourF, domF, monF, dowF] = parts;

  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const dom = date.getUTCDate();
  const month = date.getUTCMonth() + 1; // 1-12
  const dow = date.getUTCDay(); // 0-6 (0=zondag)

  if (!fieldMatches(minF, minute, 0, 59)) return false;
  if (!fieldMatches(hourF, hour, 0, 23)) return false;
  if (!fieldMatches(monF, month, 1, 12)) return false;

  const domRestricted = String(domF).trim() !== "*";
  const dowRestricted = String(dowF).trim() !== "*";
  const domMatch = fieldMatches(domF, dom, 1, 31);
  // 7 = zondag wordt ook geaccepteerd naast 0.
  const dowMatch = fieldMatches(dowF, dow, 0, 6) || (dow === 0 && fieldMatches(dowF, 7, 0, 7));

  return domRestricted && dowRestricted ? domMatch || dowMatch : domMatch && dowMatch;
}
