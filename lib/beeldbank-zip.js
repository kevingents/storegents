import JSZip from 'jszip';
import { put } from '@vercel/blob';

/**
 * Bouwt een ZIP van product-afbeeldingen en zet 'm in Vercel Blob → publieke
 * download-URL. Gebruikt door de beeldbank: ZIP-download én mailen.
 *
 * STORE (geen compressie): JPEG/PNG zijn al gecomprimeerd, dus dat scheelt CPU
 * zonder noemenswaardig grotere zip.
 */

function extFromUrl(url) {
  const m = String(url || '').split('?')[0].match(/\.(jpe?g|png|webp|gif|tiff?)$/i);
  return m ? m[0].toLowerCase() : '.jpg';
}

function safeName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'beeldbank';
}

/**
 * @param {object} opts
 * @param {string} opts.filename  basis-bestandsnaam (zonder .zip)
 * @param {string[]} opts.images  afbeeldings-URL's
 * @returns {Promise<{url:string, count:number, bytes:number, filename:string}>}
 */
export async function buildImageZip({ filename = 'beeldbank', images = [] } = {}) {
  const urls = (Array.isArray(images) ? images : []).map((u) => String(u || '').trim()).filter(Boolean);
  if (!urls.length) throw new Error('Geen afbeeldingen meegegeven.');

  const zip = new JSZip();
  let n = 0;
  /* Parallel ophalen, maar gecapt zodat we Shopify-CDN niet bestoken. */
  const results = await Promise.all(urls.map(async (url, i) => {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      return { i, buf: Buffer.from(await r.arrayBuffer()), ext: extFromUrl(url) };
    } catch {
      return null;
    }
  }));
  for (const r of results) {
    if (!r) continue;
    zip.file(`${String(r.i + 1).padStart(2, '0')}${r.ext}`, r.buf);
    n++;
  }
  if (!n) throw new Error('Geen afbeeldingen konden worden opgehaald.');

  const content = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  const base = safeName(filename);
  const blob = await put(`beeldbank-zips/${base}.zip`, content, {
    access: 'public',
    contentType: 'application/zip',
    addRandomSuffix: true,
  });
  return { url: blob.url, count: n, bytes: content.length, filename: `${base}.zip` };
}
