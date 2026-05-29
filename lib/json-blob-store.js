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
