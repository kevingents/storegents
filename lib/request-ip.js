/**
 * lib/request-ip.js
 *
 * Haalt het client-IP uit een Vercel-serverless request. Headers worden door
 * Vercel/Edge gezet — req.socket is op serverless functies onbetrouwbaar.
 *
 * Volgorde van waarheid:
 *   1. x-vercel-forwarded-for (Vercel's eigen header, meest betrouwbaar)
 *   2. x-forwarded-for (standaard proxy-header; eerste IP = origineel)
 *   3. x-real-ip
 *   4. fallback: lege string
 */

export function getRequestIp(req) {
  if (!req || !req.headers) return '';
  const candidates = [
    req.headers['x-vercel-forwarded-for'],
    req.headers['x-forwarded-for'],
    req.headers['x-real-ip']
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    const first = String(raw).split(',')[0].trim();
    if (first) return first.toLowerCase();
  }
  return '';
}

/** True als IP een private/loopback range is (LAN test, niet wereld-bereikbaar). */
export function isPrivateIp(ip) {
  if (!ip) return false;
  const v = String(ip).toLowerCase().trim();
  if (v === '::1' || v === '127.0.0.1' || v.startsWith('127.')) return true;
  if (v.startsWith('10.') || v.startsWith('192.168.')) return true;
  if (v.startsWith('172.')) {
    const oct2 = Number(v.split('.')[1]);
    if (oct2 >= 16 && oct2 <= 31) return true;
  }
  if (v.startsWith('fc') || v.startsWith('fd')) return true; /* IPv6 ULA */
  if (v.startsWith('fe80:')) return true; /* IPv6 link-local */
  return false;
}
