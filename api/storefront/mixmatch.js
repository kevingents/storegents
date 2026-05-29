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

    const [pairsData, pak] = await Promise.all([
      findBundlePairs().catch(() => ({ pairs: [] })),
      readPakketten().catch(() => ({ pakketten: [] }))
    ]);

    const isThis = (piece) => piece && (
      (artikelId && lc(piece.artikelId) === lc(artikelId)) ||
      (handle && lc(piece.handle) === handle)
    );

    const pair = (pairsData.pairs || []).find((p) => isThis(p.colbert) || isThis(p.broek) || isThis(p.gilet)) || null;
    if (!pair) return res.status(200).json({ success: true, found: false });

    const slim = (piece, role) => piece ? { role, artikelId: piece.artikelId, handle: piece.handle, title: piece.title, image: piece.image, productUrl: piece.productUrl } : null;
    const all = [slim(pair.colbert, 'colbert'), slim(pair.broek, 'broek'), slim(pair.gilet, 'gilet')].filter(Boolean);
    const partners = all.filter((pp) => !((artikelId && lc(pp.artikelId) === lc(artikelId)) || (handle && lc(pp.handle) === handle)));

    /* Actief pakket dat dit artikel bevat → theme kan kiezen alleen gecureerde
       (actieve) pakken te tonen. */
    const pakket = (pak.pakketten || []).find((p) => p.status === 'actief' && (p.components || []).some((c) => artikelId && lc(c.artikelId) === lc(artikelId)));

    return res.status(200).json({
      success: true,
      found: partners.length > 0,
      code: pair.code,
      type: pair.threePiece ? '3-delig' : '2-delig',
      active: Boolean(pakket),
      pak: pakket ? { naam: pakket.naam, type: pakket.type, categorie: pakket.categorie, prijsType: pakket.prijsType } : null,
      partners
    });
  } catch (e) {
    console.error('[storefront/mixmatch]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
