/**
 * Lijst van bekende Nederlanders voor interne klant-flagging.
 *
 * Doel: medewerker ziet bij een bekende klant een 🇳🇱 badge zodat ze
 * weten extra zorgvuldig om te gaan met de persoon (privacy, mediagevoelig,
 * potentieel ambassadeurschap, etc.).
 *
 * Privacy & ethiek:
 * - ALLEEN intern zichtbaar voor admin-medewerkers
 * - Wordt NOOIT teruggekoppeld naar de klant
 * - Geen gevoelige info, alleen "wie het is"
 *
 * Bron: handmatig samengestelde lijst van publiek-figuren waarvan de naam
 * uniek genoeg is om met redelijke zekerheid te matchen. Bij twijfelgevallen
 * (zoals "Jan de Boer" — kan iedereen zijn) wordt match-zekerheid 'low'
 * gemarkeerd.
 *
 * Updates: lijst hier uitbreiden + redeploy. Geen externe API call.
 */

export const KNOWN_NL_PEOPLE = [
  /* ── Politici (Tweede Kamer / kabinet) ── */
  { firstName: 'Mark', lastName: 'Rutte', category: 'politiek', note: 'Ex-MP, NAVO secretaris-generaal', confidence: 'high' },
  { firstName: 'Wopke', lastName: 'Hoekstra', category: 'politiek', note: 'CDA, EU Commissaris', confidence: 'high' },
  { firstName: 'Sigrid', lastName: 'Kaag', category: 'politiek', note: 'D66 oud-minister', confidence: 'high' },
  { firstName: 'Geert', lastName: 'Wilders', category: 'politiek', note: 'PVV', confidence: 'high' },
  { firstName: 'Frans', lastName: 'Timmermans', category: 'politiek', note: 'GL-PvdA', confidence: 'high' },
  { firstName: 'Dilan', lastName: 'Yeşilgöz', category: 'politiek', note: 'VVD', confidence: 'high' },
  { firstName: 'Dilan', lastName: 'Yesilgoz', category: 'politiek', note: 'VVD', confidence: 'high' },
  { firstName: 'Pieter', lastName: 'Omtzigt', category: 'politiek', note: 'NSC', confidence: 'high' },
  { firstName: 'Caroline', lastName: 'van der Plas', category: 'politiek', note: 'BBB', confidence: 'high' },
  { firstName: 'Rob', lastName: 'Jetten', category: 'politiek', note: 'D66', confidence: 'high' },
  { firstName: 'Thierry', lastName: 'Baudet', category: 'politiek', note: 'FvD', confidence: 'high' },
  { firstName: 'Femke', lastName: 'Halsema', category: 'politiek', note: 'Burgemeester Amsterdam', confidence: 'high' },
  { firstName: 'Ahmed', lastName: 'Aboutaleb', category: 'politiek', note: 'Burgemeester Rotterdam', confidence: 'high' },

  /* ── Koninklijk huis ── */
  { firstName: 'Willem-Alexander', lastName: 'van Oranje', category: 'koningshuis', note: 'Koning', confidence: 'high' },
  { firstName: 'Maxima', lastName: 'Zorreguieta', category: 'koningshuis', note: 'Koningin', confidence: 'high' },

  /* ── Voetbal (huidige + recente Oranje) ── */
  { firstName: 'Virgil', lastName: 'van Dijk', category: 'sport-voetbal', note: 'Liverpool, captain Oranje', confidence: 'high' },
  { firstName: 'Memphis', lastName: 'Depay', category: 'sport-voetbal', note: 'Oranje aanvaller', confidence: 'high' },
  { firstName: 'Frenkie', lastName: 'de Jong', category: 'sport-voetbal', note: 'Barcelona, Oranje', confidence: 'high' },
  { firstName: 'Matthijs', lastName: 'de Ligt', category: 'sport-voetbal', note: 'Man United, Oranje', confidence: 'high' },
  { firstName: 'Cody', lastName: 'Gakpo', category: 'sport-voetbal', note: 'Liverpool, Oranje', confidence: 'high' },
  { firstName: 'Denzel', lastName: 'Dumfries', category: 'sport-voetbal', note: 'Inter, Oranje', confidence: 'high' },
  { firstName: 'Donyell', lastName: 'Malen', category: 'sport-voetbal', note: 'Aston Villa, Oranje', confidence: 'high' },
  { firstName: 'Xavi', lastName: 'Simons', category: 'sport-voetbal', note: 'RB Leipzig, Oranje', confidence: 'high' },
  { firstName: 'Jurrien', lastName: 'Timber', category: 'sport-voetbal', note: 'Arsenal, Oranje', confidence: 'high' },
  { firstName: 'Stefan', lastName: 'de Vrij', category: 'sport-voetbal', note: 'Inter, Oranje', confidence: 'high' },
  { firstName: 'Ronald', lastName: 'Koeman', category: 'sport-voetbal', note: 'Bondscoach Oranje', confidence: 'high' },
  { firstName: 'Wesley', lastName: 'Sneijder', category: 'sport-voetbal', note: 'Oud-Oranje', confidence: 'high' },
  { firstName: 'Robin', lastName: 'van Persie', category: 'sport-voetbal', note: 'Oud-Oranje, trainer', confidence: 'high' },
  { firstName: 'Arjen', lastName: 'Robben', category: 'sport-voetbal', note: 'Oud-Oranje', confidence: 'high' },
  { firstName: 'Edwin', lastName: 'van der Sar', category: 'sport-voetbal', note: 'Oud-Oranje, Ajax CEO', confidence: 'high' },
  { firstName: 'Marc', lastName: 'Overmars', category: 'sport-voetbal', note: 'Oud-Oranje, oud-directeur Ajax', confidence: 'high' },
  { firstName: 'Erik', lastName: 'ten Hag', category: 'sport-voetbal', note: 'Trainer', confidence: 'high' },

  /* ── Schaatsen ── */
  { firstName: 'Sven', lastName: 'Kramer', category: 'sport-schaatsen', note: 'Olympisch kampioen', confidence: 'high' },
  { firstName: 'Ireen', lastName: 'Wüst', category: 'sport-schaatsen', note: 'Olympisch kampioen', confidence: 'high' },
  { firstName: 'Ireen', lastName: 'Wust', category: 'sport-schaatsen', note: 'Olympisch kampioen', confidence: 'high' },
  { firstName: 'Jutta', lastName: 'Leerdam', category: 'sport-schaatsen', note: 'Sprinter, influencer', confidence: 'high' },

  /* ── Hockey / overige sport ── */
  { firstName: 'Eva', lastName: 'de Goede', category: 'sport-hockey', note: 'Oud-Oranje hockey', confidence: 'high' },
  { firstName: 'Femke', lastName: 'Bol', category: 'sport-atletiek', note: '400m horden, Olympisch', confidence: 'high' },
  { firstName: 'Sifan', lastName: 'Hassan', category: 'sport-atletiek', note: 'Olympisch goud marathon', confidence: 'high' },
  { firstName: 'Max', lastName: 'Verstappen', category: 'sport-f1', note: 'F1 wereldkampioen', confidence: 'high' },

  /* ── TV / Media presentators ── */
  { firstName: 'Matthijs', lastName: 'van Nieuwkerk', category: 'media', note: 'Presentator', confidence: 'high' },
  { firstName: 'Beau', lastName: 'van Erven Dorens', category: 'media', note: 'Presentator', confidence: 'high' },
  { firstName: 'Eva', lastName: 'Jinek', category: 'media', note: 'Presentatrice', confidence: 'high' },
  { firstName: 'Humberto', lastName: 'Tan', category: 'media', note: 'Presentator', confidence: 'high' },
  { firstName: 'Wilfred', lastName: 'Genee', category: 'media', note: 'Vandaag Inside', confidence: 'high' },
  { firstName: 'Johan', lastName: 'Derksen', category: 'media', note: 'Vandaag Inside', confidence: 'medium' },
  { firstName: 'René', lastName: 'van der Gijp', category: 'media', note: 'Vandaag Inside', confidence: 'high' },
  { firstName: 'Rene', lastName: 'van der Gijp', category: 'media', note: 'Vandaag Inside', confidence: 'high' },
  { firstName: 'Jeroen', lastName: 'Pauw', category: 'media', note: 'Presentator', confidence: 'medium' },
  { firstName: 'Twan', lastName: 'Huys', category: 'media', note: 'Presentator', confidence: 'high' },
  { firstName: 'Khalid', lastName: 'Kasem', category: 'media', note: 'Presentator', confidence: 'high' },
  { firstName: 'Tijs', lastName: 'van den Brink', category: 'media', note: 'Presentator', confidence: 'high' },

  /* ── Acteurs ── */
  { firstName: 'Carice', lastName: 'van Houten', category: 'film', note: 'Actrice (GoT)', confidence: 'high' },
  { firstName: 'Famke', lastName: 'Janssen', category: 'film', note: 'Actrice', confidence: 'high' },
  { firstName: 'Michiel', lastName: 'Huisman', category: 'film', note: 'Acteur', confidence: 'high' },
  { firstName: 'Rutger', lastName: 'Hauer', category: 'film', note: 'Oud-acteur', confidence: 'high' },

  /* ── Muziek ── */
  { firstName: 'Marco', lastName: 'Borsato', category: 'muziek', note: 'Zanger', confidence: 'high' },
  { firstName: 'Guus', lastName: 'Meeuwis', category: 'muziek', note: 'Zanger', confidence: 'high' },
  { firstName: 'Anouk', lastName: 'Teeuwe', category: 'muziek', note: 'Zangeres', confidence: 'medium' },
  { firstName: 'Ilse', lastName: 'DeLange', category: 'muziek', note: 'Zangeres', confidence: 'high' },
  { firstName: 'Tiësto', lastName: 'Verwest', category: 'muziek', note: 'DJ Tiësto', confidence: 'medium' },
  { firstName: 'Armin', lastName: 'van Buuren', category: 'muziek', note: 'DJ', confidence: 'high' },
  { firstName: 'Martin', lastName: 'Garrix', category: 'muziek', note: 'DJ (Martijn Garritsen)', confidence: 'medium' },
  { firstName: 'Hardwell', lastName: 'van de Corput', category: 'muziek', note: 'DJ (Robbert)', confidence: 'medium' },

  /* ── Ondernemers / bedrijfsleven ── */
  { firstName: 'John', lastName: 'de Mol', category: 'ondernemer', note: 'Talpa', confidence: 'medium' },
  { firstName: 'Joop', lastName: 'van den Ende', category: 'ondernemer', note: 'Stage Entertainment', confidence: 'high' },
  { firstName: 'Pieter', lastName: 'Zwart', category: 'ondernemer', note: 'Coolblue', confidence: 'medium' },
  { firstName: 'Peter R.', lastName: 'de Vries', category: 'media-historisch', note: 'Misdaadverslaggever †', confidence: 'high' },
  { firstName: 'Peter', lastName: 'de Vries', category: 'media-historisch', note: 'Mogelijk Peter R. de Vries', confidence: 'low' },

  /* ── Schrijvers / publicisten ── */
  { firstName: 'Adriaan', lastName: 'van Dis', category: 'schrijver', note: 'Schrijver', confidence: 'high' },
  { firstName: 'Connie', lastName: 'Palmen', category: 'schrijver', note: 'Schrijfster', confidence: 'high' },
  { firstName: 'Maarten', lastName: 'van Rossem', category: 'media', note: 'Historicus, presentator', confidence: 'high' }
];

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') /* strip accenten */
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detecteert of de gegeven naam matcht met een bekende NL persoon.
 * Returns null bij geen match, anders { person, confidence, matchType }.
 *
 * @param {string} fullName
 * @param {string} [firstName]
 * @param {string} [lastName]
 */
export function detectKnownPerson(fullName, firstName, lastName) {
  const full = normalize(fullName);
  const f = normalize(firstName);
  const l = normalize(lastName);
  if (!full && !f && !l) return null;

  for (const p of KNOWN_NL_PEOPLE) {
    const pf = normalize(p.firstName);
    const pl = normalize(p.lastName);

    /* Exact full-name match (most reliable) */
    const pFull = `${pf} ${pl}`.trim();
    if (full && (full === pFull || full.includes(pFull))) {
      return { person: p, confidence: p.confidence, matchType: 'full' };
    }

    /* First + last apart vergeleken */
    if (f && l && f === pf && l === pl) {
      return { person: p, confidence: p.confidence, matchType: 'firstLast' };
    }

    /* Last name alleen — alleen voor unieke achternamen */
    if (l && l === pl && pl.length >= 5 && !['vries', 'mol', 'jong', 'dijk', 'boer', 'bakker', 'visser', 'meijer', 'jansen', 'wit', 'smit'].includes(pl)) {
      return { person: p, confidence: 'low', matchType: 'lastOnly' };
    }
  }
  return null;
}

export function getKnownPeopleCount() {
  return KNOWN_NL_PEOPLE.length;
}
