import { put, list } from '@vercel/blob';

const STORE_PATH = 'function-help/items.json';

/**
 * Rijke handleidingen voor alle portaal-functies.
 *
 * Per item:
 *   - category: 'daily' | 'customer' | 'returns' | 'reports' | 'admin' | 'logistics'
 *   - icon, title, description (oneliner voor in de lijst)
 *   - modalId (optioneel, knop "Open" springt direct in de modal)
 *   - steps: stap-voor-stap workflow
 *   - tips: korte praktische tips
 *   - faqs: veelgestelde vragen + antwoord
 *   - order: sorteerwaarde binnen de modal
 */
const DEFAULT_ITEMS = [
  /* ─────────── DAGELIJKSE ACTIES ─────────── */
  {
    id: 'pickup',
    category: 'daily',
    icon: '📦',
    title: 'Afhaalorders',
    description: 'Klant haalt online bestelling op in de winkel — overzicht + reminders.',
    modalId: 'pickup',
    order: 10,
    steps: [
      { step: 1, title: 'Open de modal', body: 'Klik op "Afhaalorders" in de sidebar of de KPI-tegel "Afhaalorders" op het dashboard.' },
      { step: 2, title: 'Sorteer op leeftijd', body: 'Oudste eerst — klanten die >24u wachten zijn rood gemarkeerd.' },
      { step: 3, title: 'Stuur reminder', body: 'Klik op het mail-icoon naast een order om een herinneringsmail te versturen. Tweede reminder kan via WhatsApp.' },
      { step: 4, title: 'Markeer als opgehaald', body: 'Bij overhandiging: klik "Afgehaald" — Shopify krijgt automatisch een fulfillment-update.' },
      { step: 5, title: 'Notitie toevoegen', body: 'Bv. "Klant wilde maat L proberen" — blijft zichtbaar voor collega\'s.' }
    ],
    tips: [
      'Oranje accent = klant wacht > 24u. Bel of mail direct.',
      'Telefonisch bereikbaar? Klik op het telefoon-icoon voor click-to-call (mobiel).',
      'Klant niet bereikbaar via mail? Stuur WhatsApp via het 💬 icoon.'
    ],
    faqs: [
      { q: 'Klant zegt dat hij geen e-mail heeft ontvangen?', a: 'Check het mail-log onder "Mijn declaraties" → er staat per order de mail-status. Stuur opnieuw via de reminder-knop.' },
      { q: 'Order staat in Shopify als afgehaald maar SRS niet?', a: 'Klik "Afgehaald" in het portaal — die syncht beide systemen.' },
      { q: 'Klant haalt order van een andere winkel op?', a: 'Het portaal toont alleen orders voor jouw eigen winkel. Verwijs door naar de juiste winkel.' }
    ]
  },
  {
    id: 'store-open-weborders',
    category: 'daily',
    icon: '⏱',
    title: 'Open orders',
    description: 'Weborders die jouw winkel moet verwerken via SRS — picking, packing, verzenden.',
    modalId: 'store-open-weborders',
    order: 20,
    steps: [
      { step: 1, title: 'Open de lijst', body: 'Klik "Open orders" — alle SRS-fulfillments die nog niet "processed" zijn voor jouw winkel.' },
      { step: 2, title: 'Filter op leeftijd', body: 'Rood = >48 uur oud, deadline overschreden. Pak deze eerst aan.' },
      { step: 3, title: 'Klik op de rij', body: 'Toont productdetails, foto, klantgegevens, voorraad in jouw winkel, en SRS-status.' },
      { step: 4, title: 'Pak fysiek in', body: 'Gebruik de productfoto en SKU om het artikel snel te vinden. Voorraad-tegel laat zien hoeveel je in winkel hebt.' },
      { step: 5, title: 'Verwerk in SRS', body: 'Gebruik de uitlevertafel in SRS POS. Het portaal verifieert dit zodra je weer ververst.' }
    ],
    tips: [
      'Klant-info heeft "geen Shopify-koppeling"? Dan is het een ouder order zonder klant-match — SRS-gegevens zijn leidend.',
      'Voorraad-tegel zegt "snapshot ontbreekt"? De SFTP-cron heeft nog niet gedraaid — wacht 5 min of check handmatig via SRS POS.',
      'Bij "geen verzending nodig" badge: dit is een digitale giftcard, doe niets.'
    ],
    faqs: [
      { q: 'Artikel niet meer op voorraad?', a: 'Markeer als "niet leverbaar" via SRS POS. Het portaal toont dit in admin als signaal en stuurt klant automatisch een mail.' },
      { q: 'Order voor andere winkel maar staat bij mij?', a: 'Filter op "Verstuurt vanuit" kolom — als die "Magazijn" toont was het centraal. Soms verschuift dit als magazijn niet kan leveren.' },
      { q: 'Hoe weet ik welke order eerst?', a: 'Sortering staat default op oudste eerst. Rode rand = al te laat. Begin daar.' }
    ]
  },
  {
    id: 'customer-lookup',
    category: 'customer',
    icon: '🔍',
    title: 'Klant zoeken',
    description: 'Volledig klantprofiel: orders, gradatie, voorkeuren, retour-historie, open online orders.',
    modalId: 'customer-lookup',
    order: 30,
    steps: [
      { step: 1, title: 'Voer zoekterm in', body: 'E-mail, klantnummer, telefoon, postcode, naam óf ordernummer (laatste werkt ook bij vergeten klantnummer).' },
      { step: 2, title: 'Bekijk profiel', body: 'Avatar met gradatie (A/B/C/D/E + Topklant/Reguliere/Nieuwe), totale omzet, online vs winkel-aankopen, retour-ratio.' },
      { step: 3, title: 'Open online bestellingen', body: 'Bovenaan zie je actieve online orders met "Verstuurt vanuit" — directe info als klant aan de balie staat met "waar blijft mijn pakket?"' },
      { step: 4, title: 'Voorkeuren + voorraad-suggestie', body: 'Top maten/kleuren/merken uit aankoop-historie + matches op jouw winkel-voorraad.' },
      { step: 5, title: 'Notities en tags toevoegen', body: 'Klant heeft allergie wol? Voorkeur slim fit? Schrijf het op — blijft per klant zichtbaar voor alle collega\'s.' }
    ],
    tips: [
      'Recent-bekeken klanten staan boven als pillen — 1-klik terug naar vorige klant.',
      'Risk-badge "HOOG" = veel retouren of openstaande rekeningen. Wees extra alert.',
      'Bekende-NL detectie geeft soms 🏆 badge — discreet doorgeven, niet uitspreken.',
      'Bij gedeeld scherm: klik "Wissen" op recent-pillen om kale start te geven.'
    ],
    faqs: [
      { q: 'Klant zegt dat hij meerdere accounts heeft?', a: 'Zoek op naam of postcode → toont eventuele duplicates onderaan. Klik op een match om te wisselen, gebruik "Mogelijke duplicates" knop om te mergen via admin.' },
      { q: 'Hoe stuur ik klant-voorkeuren naar Shopify voor marketing?', a: 'Klik "Sync voorkeuren → Shopify" — top maten/kleuren komen als tags in Shopify-klantkaart voor segmentatie.' },
      { q: 'Klant wil zijn GDPR-export?', a: 'Klik "GDPR data export" — download alle persoonsgegevens als JSON.' },
      { q: 'Hoe zie ik welke retouren een klant deed?', a: 'In het profiel staat "Retour-historie" — overzicht met datum, product, reden, bedrag.' }
    ]
  },
  {
    id: 'refund',
    category: 'returns',
    icon: '↩',
    title: 'Retour & terugbetaling',
    description: 'Twee-staps flow: zoek order → kies producten → SRS-retour + Shopify-refund tegelijk.',
    modalId: 'refund',
    order: 40,
    steps: [
      { step: 1, title: 'Zoek de order', body: 'Voer ordernummer in (#GNT-2026-001 of gewoon 1234) + klant e-mail of postcode ter verificatie. Beide vereist als veiligheid.' },
      { step: 2, title: 'Selecteer artikelen', body: 'Vink aan welke producten retour gaan. Bij "al X geretourneerd" badge → max-aantal is automatisch verlaagd.' },
      { step: 3, title: 'Vul medewerker + reden in', body: 'Bij reden "Beschadigd / Defect / Klacht" verschijnt extra klacht-omschrijving veld — verplicht in te vullen.' },
      { step: 4, title: 'Voorraad-toggle', body: '"Voorraad terug op meldend filiaal" — standaard aan. Vink uit bij beschadigd artikel dat niet terug in voorraad mag.' },
      { step: 5, title: 'Verzendkosten meecrediteren?', body: 'Toggle aan = verzendkosten ook terug. Standaard uit (klant heeft die al gebruikt).' },
      { step: 6, title: 'Bevestigingen aanvinken', body: 'Twee verplichte checks: (1) reden gecontroleerd, (2) terugbetaling bevestigd. Verwerk-knop wordt actief.' },
      { step: 7, title: 'Verwerken', body: 'Shopify refund + SRS retour worden parallel verwerkt. Klant krijgt automatisch mail.' }
    ],
    tips: [
      'Klant-retour-historie verschijnt automatisch bovenaan — bij 3+ retouren laatste jaar krijg je een waarschuwing.',
      'Cross-sell? Vink "Klant heeft iets anders gekocht" aan + bedrag — komt in rapportage.',
      'Shopify-voorraad wordt NOOIT aangeraakt — er loopt een stock-sync vanuit SRS naar Shopify, dat regelt zelf de webshop-voorraad.',
      'Idempotency: bij dubbel-klik gebeurt de refund maar 1× (zelfde key wordt server-side gedetecteerd).'
    ],
    faqs: [
      { q: 'Foutmelding "Niet alle geselecteerde producten mogen retour"?', a: 'De gele callout toont per regel waarom: bijv "SRS status pending" of "al volledig terugbetaald". Vink die regels uit en probeer opnieuw.' },
      { q: 'Lange Shopify-ID werkt niet als ordernummer?', a: 'Gebruik het ordernummer zoals klant ziet (#GNT-...). De lange numerieke ID uit Shopify URL werkt wel als fallback maar is niet ideaal.' },
      { q: 'Klant wil alleen een deel retour?', a: 'Pas het aantal per regel aan met de pijltjes. Max = wat nog niet eerder geretourneerd is.' },
      { q: 'Wat gebeurt bij "SRS retour overgeslagen"?', a: 'Je hebt de voorraad-toggle uitgezet. Shopify is wel gecrediteerd, SRS niet — artikel staat als "onverkoopbaar" gemarkeerd in tags.' }
    ]
  },
  {
    id: 'exchanges',
    category: 'logistics',
    icon: '⇆',
    title: 'Uitwisselingen',
    description: 'Inkomende artikelen van andere winkels — bevestig ontvangst per regel.',
    modalId: 'exchanges',
    order: 50,
    steps: [
      { step: 1, title: 'Bekijk inkomende lijst', body: 'Alle uitwisselingen waarbij jouw winkel de bestemming is. Te lang open (>7d) = oranje accent.' },
      { step: 2, title: 'Klik op een rij', body: 'Toont alle artikelen in de zending met bron-winkel en aantal.' },
      { step: 3, title: 'Vul ontvangen aantal in', body: 'Per regel: aantal werkelijk ontvangen. 0 = niets ontvangen (item zoek of verkeerd).' },
      { step: 4, title: 'Verwerken', body: 'Klik "Bevestig" — SRS boekt voorraad-correctie van bron-winkel naar jouw winkel.' }
    ],
    tips: [
      'Een uitwisseling die al >7 dagen open staat — vraag de bron-winkel of de zending verstuurd is.',
      'Bij meer ontvangen dan gestuurd: alleen bevestigen wat geboekt is, rest separaat met admin afhandelen.'
    ],
    faqs: [
      { q: 'Doos was leeg / artikel ontbreekt?', a: 'Vul 0 in voor dat artikel. Stuur foto naar bron-winkel + admin.' },
      { q: 'Kan ik later nog aanpassen?', a: 'Nee. Bevestiging is final — neem contact op met admin voor correcties.' }
    ]
  },
  {
    id: 'store-customer-month',
    category: 'customer',
    icon: '@',
    title: 'Klantinschrijvingen',
    description: 'Overzicht nieuw ingeschreven klanten deze maand — bewaak datakwaliteit.',
    modalId: 'store-customer-month',
    order: 60,
    steps: [
      { step: 1, title: 'Open de modal', body: 'Toont alle nieuwe SRS-klantinschrijvingen van deze maand voor jouw winkel.' },
      { step: 2, title: 'Check rode regels', body: 'Rood = ontbrekende bon (geen aankoop gekoppeld) OF ontbrekende e-mail. Aanvullen!' },
      { step: 3, title: 'Klik op klant', body: 'Springt naar het volledige profiel waar je e-mail/telefoon kunt aanvullen.' }
    ],
    tips: [
      'Doel: 100% van inschrijvingen heeft e-mail. Mail = marketing-mogelijkheid.',
      'Inschrijving zonder bon = klant kreeg loyaltykaart maar kocht (nog) niets. Volg op met persoonlijke mail.'
    ],
    faqs: []
  },
  {
    id: 'declarations',
    category: 'admin',
    icon: '⇪',
    title: 'Declaratie indienen',
    description: 'Upload factuur + bedrag + categorie → administratie verwerkt.',
    modalId: 'declaration-submit',
    order: 70,
    steps: [
      { step: 1, title: 'Klik "Declaratie indienen"', body: 'Modal opent met upload-veld en formulier.' },
      { step: 2, title: 'Upload PDF of foto', body: 'Onder 5 MB. Foto van een bon mag ook (maakt JPG/PNG).' },
      { step: 3, title: 'Vul bedrag + categorie', body: 'Categorieën: kantoor, schoonmaak, klein-onderhoud, lunch, reiskosten, overig.' },
      { step: 4, title: 'Geef aan of al betaald', body: 'Ja = jij hebt voorgeschoten en wilt terugbetaald. Nee = factuur moet door admin betaald worden.' },
      { step: 5, title: 'Submit', body: 'Administratie krijgt notificatie. Status zie je onder "Mijn declaraties".' }
    ],
    tips: [
      'Upload de bon zo snel mogelijk — vervaagt op kassabonpapier.',
      'Bij twijfel categorie: gebruik "overig" + beschrijving in toelichting.'
    ],
    faqs: [
      { q: 'Hoe lang duurt verwerken?', a: 'Meestal 5 werkdagen. Status onder "Mijn declaraties".' },
      { q: 'Declaratie afgekeurd, wat nu?', a: 'Reden staat in de status. Pas aan en dien opnieuw in.' }
    ]
  },
  {
    id: 'label',
    category: 'logistics',
    icon: '🚚',
    title: 'Verzendlabel maken',
    description: 'DHL-label via Sendcloud — klant of winkel-naar-winkel.',
    modalId: 'label',
    order: 80,
    steps: [
      { step: 1, title: 'Kies bestemming', body: 'Klant (vul adres in) of Winkel (kies uit lijst).' },
      { step: 2, title: 'Vul afzender en gewicht', body: 'Jouw winkel als afzender. Gewicht in kg — bij twijfel 1 kg.' },
      { step: 3, title: 'Label genereren', body: 'Klik "Maak label" — PDF wordt direct geopend. Print op 10x15 cm.' },
      { step: 4, title: 'Tracking', body: 'Tracking-nummer staat onderaan label én onder "Labels raadplegen".' }
    ],
    tips: [
      'Plak label op vlak deel van doos, niet over naden.',
      'Foto van afgegeven pakket? Sla op in OneDrive — bewijs bij verlies.'
    ],
    faqs: [
      { q: 'Label is verkeerd, kan ik annuleren?', a: 'Ja, binnen 24u: ga naar "Labels raadplegen" → annuleer. Daarna is het label al gefactureerd.' },
      { q: 'Welk gewicht moet ik invullen?', a: 'Bij twijfel 1 kg. Sendcloud weegt achteraf en factureert correct.' }
    ]
  },

  /* ─────────── RAPPORTAGES ─────────── */
  {
    id: 'omnichannel-score',
    category: 'reports',
    icon: '🏆',
    title: 'Omnichannel Score',
    description: 'Jouw winkel-score op 4 pijlers + maandelijkse winnaar. Klik op hero-tile voor breakdown.',
    modalId: 'trophy-cabinet',
    order: 90,
    steps: [
      { step: 1, title: 'Bekijk de hero op dashboard', body: 'Boven aan "Vandaag in de winkel" zie je de Omnichannel Score 0-100.' },
      { step: 2, title: 'Lees per pijler', body: 'Klantbekendheid (30 pt), Loyalty (25 pt), Cross-channel (25 pt), Data-kwaliteit (20 pt). Klik op de ⓘ icoontjes voor uitleg.' },
      { step: 3, title: 'Open trofeekast', body: 'Klik op de hero-tile → modal met huidige winnaar, subprijzen en historiek.' },
      { step: 4, title: 'Bekijk score-trend', body: 'In trofeekast: kies jouw winkel uit dropdown → grafiek 6 maanden terug.' }
    ],
    tips: [
      'Eerste van de maand: winnaar wordt automatisch bekendgemaakt + confetti voor de winnende winkel.',
      'Score < 60 = rood. Focus op de pijler met grootste gap.',
      'Tie-breaker bij gelijke score: hoogste klantbekendheid wint.'
    ],
    faqs: [
      { q: 'Mijn klantbekendheid is laag — hoe verbeter ik?', a: 'Vraag bij élke kassabon naar e-mailadres. Bij weigering: vermeld dat ze daarmee ook hun spaarpunten zien.' },
      { q: 'Hoe word ik winnaar?', a: 'Minimaal 50 transacties per maand én hoogste totaalscore. Subprijzen zijn los te winnen op één van de 4 pijlers.' }
    ]
  },
  {
    id: 'store-insights',
    category: 'reports',
    icon: '📊',
    title: 'Winkelinzicht',
    description: 'Verkoop-analyse uit SRS kassa-data: beste dagen, top maten/kleuren, fast/slow movers.',
    modalId: 'store-insights',
    order: 100,
    steps: [
      { step: 1, title: 'Open de modal', body: 'Klik "Winkelinzicht" in de sidebar onder Rapportages.' },
      { step: 2, title: 'Kies periode', body: 'Default 30 dagen. Voor seizoenstrends: kies kwartaal of jaar.' },
      { step: 3, title: 'Lees de tegels', body: 'AOV (gem. bonbedrag), aantal transacties, omzet, repeat-rate, gem. korting%.' },
      { step: 4, title: 'Beste dagen + uren', body: 'Heatmap onder de KPI\'s — gebruik voor personeel-planning.' },
      { step: 5, title: 'Fast/slow movers', body: 'Welke SKUs lopen goed/slecht. Slow movers: overweeg afprijzen of terug naar magazijn.' }
    ],
    tips: [
      '"Nog geen cache" → klik de bouw-knop. Eerste keer kan 1-5 min duren.',
      'Cache wordt elke nacht om 03:00 opnieuw gebouwd — data is dus max 1 dag oud.',
      'Top kleuren / maten = direct bruikbaar voor inkoop-feedback aan admin.'
    ],
    faqs: [
      { q: 'Waarom is de data niet realtime?', a: 'Live SRS-call duurt te lang (1-3 min per winkel × 22 winkels). Daarom nightly cache. Trade-off snelheid vs. actualiteit.' },
      { q: 'Kan ik mijn eigen periode kiezen?', a: 'Nu nog niet — alleen maand/kwartaal/jaar/5jaar. Aangepaste range volgt in toekomstige update.' }
    ]
  },
  {
    id: 'google-reviews',
    category: 'reports',
    icon: '⭐',
    title: 'Google Reviews',
    description: 'Score, recente reviews, trend, regio-vergelijking + QR-code voor klanten.',
    modalId: 'store-google-reviews',
    order: 110,
    steps: [
      { step: 1, title: 'Bekijk hero', body: 'Grote score-cijfer + sterren + aantal reviews + label (Uitstekend/Goed/Voldoende/Verbeterpunt).' },
      { step: 2, title: 'Lees nieuwe reviews', body: 'NIEUW-pill bij ongeziene reviews. Klik "Markeer als gelezen" om de teller te resetten.' },
      { step: 3, title: 'Reageer met template', body: 'Bij elke niet-beantwoorde review: klik "📋 Kopieer antwoord-template" → plak in Google Business profiel.' },
      { step: 4, title: 'Bekijk trend + regio-compare', body: 'Trend laatste 12 mnd + jouw rating vs. regio-gemiddelde + GENTS-gem.' },
      { step: 5, title: 'Print QR-code voor klanten', body: 'Onderaan: print poster met QR. Hang bij kassa zodat tevreden klanten direct review kunnen schrijven.' }
    ],
    tips: [
      'Reageer binnen 24u op nieuwe reviews — telt mee voor Google ranking.',
      'Vraag aan klanten die net iets gekocht hebben (i.p.v. koud) → 0.4★ hoger gemiddeld.',
      'Mismatch-signaal: 5★ met negatieve woorden? Klant uitte mogelijk klacht ondanks hoge ster — lees de tekst goed.'
    ],
    faqs: [
      { q: 'Waarom zie ik geen reviews maar wel een aantal?', a: 'Google Places API levert max 5 reviews per call. Bij sommige winkels rouleert Google welke worden getoond. Probeer "Verversen".' },
      { q: 'Hoe weet ik welke reviews al beantwoord zijn?', a: '"✓ beantwoord" pill staat naast naam. Niet-beantwoord ≤3★ jonger dan 7 dagen krijgen rood-accent.' },
      { q: 'Automatisch reageren?', a: 'Niet mogelijk via portaal — Google Business Profile vereist owner-OAuth. Wel: "Kopieer template" → plak in Business profiel.' }
    ]
  },

  /* ─────────── NOTIFICATIES & SUPPORT ─────────── */
  {
    id: 'notifications',
    category: 'admin',
    icon: '🔔',
    title: 'Notificaties',
    description: 'Berichten van admin + automatische signalen (nieuwe order, lage rating, etc.)',
    modalId: 'notifications-center',
    order: 120,
    steps: [
      { step: 1, title: 'Open bel-icoon', body: 'Rechtsboven in de topbar. Rode badge = ongelezen aantal.' },
      { step: 2, title: 'Lees per notificatie', body: 'Klik op een rij om uit te klappen. Severity-kleur (blauw info, geel warning, rood danger).' },
      { step: 3, title: 'Archiveren', body: 'Per item: "Archiveer" tekst-link. Bulk: "Alles archiveren" knop bovenaan.' },
      { step: 4, title: 'Push inschakelen', body: 'Klik "Push inschakelen" → krijg native browser-notificaties bij nieuwe events (ook als portaal niet open is).' }
    ],
    tips: [
      'Auto-notificaties: nieuwe afhaalorder, nieuwe weborder, te late order, lage Google review, klant met openstaande rekening.',
      'Archiveren ≠ verwijderen — andere winkels zien de notificatie nog wel.',
      'Lees-status is per medewerker (via session), niet gedeeld.'
    ],
    faqs: [
      { q: 'Push werkt niet in Chrome?', a: 'Sta notificaties toe in browser-instellingen voor gents.nl. Sommige werkbrowsers blokkeren ze.' },
      { q: 'Spam aan notificaties?', a: 'Vraag admin om de trigger-drempel aan te passen — bv. niet voor elke nieuwe weborder maar alleen voor te-late.' }
    ]
  },
  {
    id: 'my-tickets',
    category: 'admin',
    icon: '🎫',
    title: 'Mijn tickets',
    description: 'Support-tickets aan admin: vragen, problemen, ideeën. Met antwoorden + reply.',
    modalId: 'my-tickets',
    order: 130,
    steps: [
      { step: 1, title: 'Open "Mijn tickets"', body: 'In sidebar onder Support. Toont al jouw tickets met laatste status.' },
      { step: 2, title: 'Filter op status', body: 'Open / In behandeling / Wacht op klant / Gesloten — zoek op onderwerp.' },
      { step: 3, title: 'Antwoord op admin-reactie', body: 'Klik ticket open → typ in textarea → "Plaats antwoord". Admin krijgt notificatie.' },
      { step: 4, title: 'Nieuw ticket', body: 'Geen knop voor in deze view — gebruik "Hulp / contact" elders.' }
    ],
    tips: [
      'Gele rand + groene gloed = admin heeft net geantwoord, lees binnen 24u.',
      'Last-reply preview is zichtbaar in de gesloten kaart — snel scannen wat de status is.',
      'Auto-refresh elke 30s zolang modal open is.'
    ],
    faqs: []
  },

  /* ─────────── ADMIN-ONLY FUNCTIES ─────────── */
  {
    id: 'admin-region-reporting',
    category: 'admin',
    icon: '🗺️',
    title: 'Regio-rapportage (admin)',
    description: 'Wekelijkse mails naar regio-managers met overdue orders + winkel-stats.',
    modalId: 'admin-region-reporting',
    order: 200,
    adminOnly: true,
    steps: [
      { step: 1, title: 'Configureer 4 regio\'s', body: 'Wijs winkels toe aan Regio 1/2/3/4. Geef per regio een manager-mail + cc.' },
      { step: 2, title: 'Mail-templates', body: 'Bekijk preview van het wekelijkse rapport per regio.' },
      { step: 3, title: 'Manueel triggeren', body: 'Knop "Stuur nu" voor handmatige verzending — gebruik bij ad-hoc gevallen.' }
    ],
    tips: [
      'Auto-mail elke maandag 08:00. Bottom 3 winkels worden expliciet genoemd voor opvolging.',
      'Maandelijks omnichannel-winnaar mail wordt apart verstuurd op de 1e van de maand.'
    ],
    faqs: [
      { q: 'Regio-manager krijgt geen mail?', a: 'Check Resend logs onder admin-mail-log. Vaak: bounce-status of typo in mailadres.' }
    ]
  },
  {
    id: 'admin-omnichannel-score',
    category: 'admin',
    icon: '📈',
    title: 'Omnichannel scoreboard (admin)',
    description: 'Alle 22 winkels in 1 overzicht met scores, ranking en drilldown per winkel.',
    modalId: 'admin-omnichannel-score',
    order: 210,
    adminOnly: true,
    steps: [
      { step: 1, title: 'Bekijk scoreboard', body: 'Sortable tabel met score, pijler-breakdown, transactie-volume per winkel.' },
      { step: 2, title: 'Klik op winkel', body: 'Drilldown met topActions per pijler — direct bruikbaar voor regio-manager.' }
    ],
    tips: [
      'Periode default = laatste 30 dagen. Pas aan voor maand/kwartaal/jaar.',
      'Min. 50 transacties vereist om mee te dingen voor maandwinnaar.'
    ],
    faqs: []
  }
];

async function readBlobText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Function help kon niet worden gelezen.');
  return response.text();
}

async function loadAll() {
  try {
    const result = await list({ prefix: STORE_PATH, limit: 1 });
    const blob = result.blobs.find((item) => item.pathname === STORE_PATH);
    if (!blob) return null;
    const raw = await readBlobText(blob.url);
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function saveAll(items) {
  await put(STORE_PATH, JSON.stringify(items, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
}

function sortItems(items) {
  return [...items].sort((a, b) => (Number(a.order || 0)) - (Number(b.order || 0)));
}

export async function getFunctionHelpItems() {
  const items = await loadAll();
  /* Merge: gebruik blob items als die er zijn, anders defaults. Items van Blob
     die GEEN steps/faqs hebben krijgen die uit DEFAULT_ITEMS automatisch erbij. */
  if (items && items.length) {
    const defaultMap = new Map(DEFAULT_ITEMS.map((d) => [d.id, d]));
    const merged = items.map((it) => {
      const def = defaultMap.get(it.id) || {};
      return {
        ...def,
        ...it,
        steps: it.steps?.length ? it.steps : (def.steps || []),
        tips: it.tips?.length ? it.tips : (def.tips || []),
        faqs: it.faqs?.length ? it.faqs : (def.faqs || []),
        category: it.category || def.category || 'admin'
      };
    });
    /* Voeg defaults toe die nog niet in Blob staan (nieuwe handleiding-entries) */
    for (const def of DEFAULT_ITEMS) {
      if (!merged.find((m) => m.id === def.id)) merged.push(def);
    }
    return sortItems(merged);
  }
  return sortItems(DEFAULT_ITEMS);
}

export async function upsertFunctionHelpItem(input) {
  const id = String(input.id || '').trim();
  const item = {
    id: id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
    icon: String(input.icon || '?').trim(),
    title: String(input.title || '').trim(),
    description: String(input.description || '').trim(),
    modalId: String(input.modalId || '').trim(),
    category: String(input.category || 'admin').trim(),
    order: Number(input.order || 0) || 0,
    steps: Array.isArray(input.steps) ? input.steps : [],
    tips: Array.isArray(input.tips) ? input.tips : [],
    faqs: Array.isArray(input.faqs) ? input.faqs : [],
    adminOnly: Boolean(input.adminOnly),
    updatedAt: new Date().toISOString()
  };

  let existing = await loadAll();
  if (!existing) existing = [...DEFAULT_ITEMS];

  const idx = existing.findIndex((it) => it.id === item.id);
  if (idx === -1) existing.push(item);
  else existing[idx] = { ...existing[idx], ...item };

  await saveAll(existing);
  return item;
}

export async function deleteFunctionHelpItem(id) {
  const target = String(id || '').trim();
  if (!target) return false;
  let existing = await loadAll();
  if (!existing) existing = [...DEFAULT_ITEMS];
  const next = existing.filter((it) => it.id !== target);
  if (next.length === existing.length) return false;
  await saveAll(next);
  return true;
}

export const FUNCTION_HELP_CATEGORIES = {
  daily: { label: 'Dagelijkse acties', icon: '☀️', order: 1 },
  customer: { label: 'Klanten', icon: '👥', order: 2 },
  returns: { label: 'Retouren', icon: '↩️', order: 3 },
  logistics: { label: 'Logistiek', icon: '📦', order: 4 },
  reports: { label: 'Rapportages', icon: '📊', order: 5 },
  admin: { label: 'Admin & support', icon: '⚙️', order: 6 }
};
