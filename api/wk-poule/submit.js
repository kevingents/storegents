import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { savePrediction, getPrediction } from '../../lib/wk-poule-store.js';

/**
 * /api/wk-poule/submit
 *
 * Publiek POST endpoint waarmee medewerkers (en gasten) hun WK-Poule
 * voorspelling indienen. Eén entry per e-mailadres — opnieuw indienen
 * overschrijft, met een revisie-teller voor audit.
 *
 * Body:
 *   {
 *     name: string (verplicht),
 *     email: string (verplicht — strikt @gents.nl OF anders zonder restrictie?),
 *     store: string,
 *     champion: string (verplicht),
 *     topScorer: string,
 *     surprise: string
 *   }
 *
 * Returns: { success, prediction }
 *
 * NB: hier laten we ook niet-@gents.nl adressen toe — collega's of klanten
 * mogen meedoen. Voor administratieve checks (mail-naar-winkel-flows) is
 * @gents.nl restrictie elders geregeld.
 */
export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'GET', 'OPTIONS']);

  /* GET → laat de huidige inzending terugzien op basis van ?email= */
  if (req.method === 'GET') {
    const email = String(req.query?.email || '').trim();
    if (!email) {
      return res.status(400).json({ success: false, message: 'email-parameter vereist.' });
    }
    try {
      const prediction = await getPrediction(email);
      return res.status(200).json({ success: true, prediction });
    } catch (error) {
      console.error('[wk-poule/submit GET]', error);
      return res.status(500).json({ success: false, message: error.message || 'Inzending kon niet worden opgehaald.' });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen POST of GET.' });
  }

  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim();
    const champion = String(body.champion || '').trim();

    if (!name || name.length < 2) {
      return res.status(400).json({ success: false, message: 'Vul je naam in.' });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Vul een geldig e-mailadres in.' });
    }
    if (!champion) {
      return res.status(400).json({ success: false, message: 'Kies een wereldkampioen-voorspelling.' });
    }

    const prediction = await savePrediction({
      name,
      email,
      store: body.store,
      champion,
      topScorer: body.topScorer,
      surprise: body.surprise
    });

    return res.status(200).json({
      success: true,
      prediction,
      isUpdate: prediction.revision > 1
    });
  } catch (error) {
    console.error('[wk-poule/submit POST]', error);
    return res.status(500).json({ success: false, message: error.message || 'Inzending kon niet worden opgeslagen.' });
  }
}
