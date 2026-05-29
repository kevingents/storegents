import { put, list } from '@vercel/blob';

async function readBlobText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Blob kon niet worden gelezen.');
  return response.text();
}

export async function readJsonBlob(path, fallback = []) {
  /* BELANGRIJK — onderscheid "bestaat niet" van "lezen/parsen mislukt".
     Vroeger ving deze functie ÉLKE fout (netwerk, 5xx, corrupte JSON) en gaf
     dan stilletjes de lege fallback terug. Bij een read-modify-write store
     betekende dat: tijdelijke leesfout -> lege fallback -> daarna put() ->
     de héle store overschreven met leeg. Eén transient blob-500 = dataverlies.

     Nu: een ontbrekende blob -> fallback (normaal). Een mislukte lees- of
     parse-actie -> gooi de fout door, zodat de aanroeper NIET per ongeluk
     een lege waarde terugschrijft. */
  const result = await list({ prefix: path, limit: 1 });
  const blob = (result.blobs || []).find((item) => item.pathname === path);
  if (!blob) return fallback;
  const raw = await readBlobText(blob.url);
  try {
    return JSON.parse(raw || JSON.stringify(fallback));
  } catch (error) {
    error.message = `readJsonBlob: corrupte JSON in ${path} — ${error.message}`;
    throw error;
  }
}

export async function writeJsonBlob(path, value) {
  await put(path, JSON.stringify(value, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 30
  });
  return value;
}

/* ── Optimistic read-modify-write ───────────────────────────────────────────
   Vercel Blob heeft GEEN compare-and-swap, dus echte atomiciteit kan niet.
   Wat wel kan: optimistische concurrency. We lezen de huidige waarde + haar
   versie (uploadedAt uit dezelfde list-call, dus consistent), passen de
   mutator toe, en checken vlak vóór het schrijven of de versie nog gelijk is.
   Wijzigde een andere run de blob in de tussentijd, dan lezen we opnieuw en
   proberen we het opnieuw. Dit elimineert lost-updates bij de realistische
   lage contentie (dagelijkse cron + incidentele handmatige trigger). Er blijft
   een klein TOCTOU-venster tussen de laatste versie-check en de put; voor échte
   garanties is een externe lock/KV nodig. */

async function readJsonFresh(path, fallback) {
  /* Eén list-call levert url ÉN uploadedAt → content en versie horen bij
     elkaar. We omzeilen de CDN-cache met een cache-buster zodat we niet een
     verouderde (tot cacheControlMaxAge oude) versie binnenhalen. */
  const result = await list({ prefix: path, limit: 1 });
  const blob = (result.blobs || []).find((item) => item.pathname === path);
  if (!blob) return { value: fallback, version: 0 };
  const version = blob.uploadedAt ? new Date(blob.uploadedAt).getTime() : 0;
  const bust = (blob.url.includes('?') ? '&' : '?') + '_=' + Date.now();
  const response = await fetch(blob.url + bust, { cache: 'no-store' });
  if (!response.ok) throw new Error(`mutateJsonBlob: lezen van ${path} mislukte — HTTP ${response.status}`);
  const raw = await response.text();
  try {
    return { value: JSON.parse(raw || JSON.stringify(fallback)), version };
  } catch (error) {
    throw new Error(`mutateJsonBlob: corrupte JSON in ${path} — ${error.message}`);
  }
}

async function currentVersion(path) {
  const result = await list({ prefix: path, limit: 1 });
  const blob = (result.blobs || []).find((item) => item.pathname === path);
  return blob && blob.uploadedAt ? new Date(blob.uploadedAt).getTime() : 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Lees-muteer-schrijf met optimistische conflictdetectie + retry.
 *
 * @param {string}   path     blob-pad
 * @param {Function} mutator  (currentValue) => nextValue  (sync of async).
 *                            Krijgt telkens een VERSE waarde; bij een conflict
 *                            wordt 'ie opnieuw aangeroepen.
 * @param {Object}   [opts]
 * @param {*}        [opts.fallback]      waarde als de blob nog niet bestaat
 * @param {number}   [opts.retries]       max. aantal retries bij conflict (default 4)
 * @param {number}   [opts.cacheMaxAge]   CDN-cache van de write (default 0 = vers)
 * @returns {Promise<*>} de geschreven waarde
 */
export async function mutateJsonBlob(path, mutator, { fallback = [], retries = 4, cacheMaxAge = 0 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const { value, version } = await readJsonFresh(path, fallback);
    const next = await mutator(value);
    const after = await currentVersion(path);
    if (after !== version) {
      /* Iemand schreef tussendoor → onze `value` kan verouderd zijn. Backoff +
         opnieuw lezen/muteren. */
      await sleep(40 + Math.floor(Math.random() * 120));
      continue;
    }
    await put(path, JSON.stringify(next, null, 2), {
      access: 'public',
      allowOverwrite: true,
      contentType: 'application/json',
      cacheControlMaxAge: cacheMaxAge
    });
    return next;
  }
  /* Retries op — best-effort schrijven (gelijk aan oud gedrag: last-writer-wins)
     zodat we geen nieuwe faalmodus introduceren, maar mét een waarschuwing. */
  console.warn(`[mutateJsonBlob] ${path}: geen conflict-vrije write na ${retries + 1} pogingen; best-effort.`);
  const { value } = await readJsonFresh(path, fallback);
  const next = await mutator(value);
  await put(path, JSON.stringify(next, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: cacheMaxAge
  });
  return next;
}
