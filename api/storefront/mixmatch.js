/**
 * /api/storefront/mixmatch   (PUBLIEK, read-only)
 *
 * Data-brug voor de Mix & Match-widget op de webshop. Geeft, voor een product
 * (op artikel_id of handle), de gematchte pak-partner(s) terug zodat de theme
 * een "koop als compleet pak"-blok kan tonen. Bevat ALLEEN publieke
 * product-info (titel, handle, foto) — geen voorraad/prijzen/gevoelige data.
 *
 *   GET ?artikelId=COL-SW091   → partner(s) voor dit artikel
 *   GET ?handle=<product-handle>
 *
 * De theme haalt zelf de varianten/maten op via /products/<handle>.js en voegt
 * beide echte producten (zelfde maat) toe aan de cart. Prijs = som; voorraad
 * blijft kloppen want het zijn de echte producten. Géén catalogus-writes.
 */

import { findBundlePairs } from '../../lib/bundle-pairing.js';
import { readPakketten } from '../../lib/mixmatch-store.js';
import { corsJson } from '../../lib/request-guards.js';

export const maxDuration = 30;

const clean = (v) => String(v == null ? '' : v).trim();
const lc = (v) => clean(v).toLowerCase();

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });

  /* Storefront-caching: relatie verandert hooguit dagelijks. */
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');

  try {
    const artikelId = clean(req.query.artikelId || req.query.artikel_id);
    const handle = lc(req.query.handle);
    if (!artikelId && !handle) {
      return res.status(400).json({ success: false, message: 'artikelId of handle vereist.' });
    }

    const [pak, pairsData] = await Promise.all([
      readPakketten().catch(() => ({ pakketten: [] })),
      findBundlePairs().catch(() => ({ pairs: [] }))
    ]);

    const matches = (c) => c && (
      (artikelId && lc(c.artikelId) === lc(artikelId)) ||
      (handle && lc(c.handle) === handle)
    );

    /* 1) PRIMAIR: een actief pakket dat dit product bevat. Werkt op wat de
       beheerder heeft samengesteld — onafhankelijk van de cache-pairing. */
    const pakket = (pak.pakketten || []).find((p) => p.status === 'actief' && (p.components || []).some(matches));
    if (pakket) {
      const partners = (pakket.components || [])
        .filter((c) => !matches(c))
        .map((c) => ({ role: c.role, artikelId: c.artikelId, handle: c.handle, title: c.title, image: c.image }))
        .filter((c) => c.handle); /* handle nodig om varianten op te halen in de theme */
      return res.status(200).json({
        success: true,
        found: partners.length > 0,
        code: pakket.code || '',
        type: pakket.type || '2-delig',
        active: true,
        pak: { naam: pakket.naam, type: pakket.type, categorie: pakket.categorie, prijsType: pakket.prijsType },
        partners
      });
    }

    /* 2) FALLBACK: de cache-pairing (colbert↔broek via artikel_id). */
    const isThis = (piece) => piece && (
      (artikelId && lc(piece.artikelId) === lc(artikelId)) ||
      (handle && lc(piece.handle) === handle)
    );
    const pair = (pairsData.pairs || []).find((p) => isThis(p.colbert) || isThis(p.broek) || isThis(p.gilet)) || null;
    if (!pair) return res.status(200).json({ success: true, found: false });

    const slim = (piece, role) => piece ? { role, artikelId: piece.artikelId, handle: piece.handle, title: piece.title, image: piece.image, productUrl: piece.productUrl } : null;
    const all = [slim(pair.colbert, 'colbert'), slim(pair.broek, 'broek'), slim(pair.gilet, 'gilet')].filter(Boolean);
    const partners = all.filter((pp) => !((artikelId && lc(pp.artikelId) === lc(artikelId)) || (handle && lc(pp.handle) === handle)));

    return res.status(200).json({
      success: true,
      found: partners.length > 0,
      code: pair.code,
      type: pair.threePiece ? '3-delig' : '2-delig',
      active: false,
      pak: null,
      partners
    });
  } catch (e) {
    console.error('[storefront/mixmatch]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
