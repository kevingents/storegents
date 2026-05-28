/**
 * GENTS Brandbook — gestructureerde merkrichtlijnen.
 *
 * Bron: "BRANDBOOK - GENTS.docx" (v2.0, jan 2026) + "Visie GENTS (2026–2028).docx".
 * Wordt getoond in Marketing → Merk-assets en dient als context voor de
 * AI-generatie van product-omschrijvingen (custom.long_description).
 *
 * De `photos[].file` / `logos[].file` verwijzen naar theme-assets (brand-*.jpg/png
 * in shopifystore/assets). De frontend zet die om naar een asset-URL.
 */

export const BRANDBOOK = {
  version: '2.0',
  updated: 'Januari 2026',

  brand: {
    name: 'GENTS',
    tagline: 'GENTS - SUITS YOU -',
    description: 'Pakken, overhemden, smoking en nog veel meer. Je vindt het allemaal bij GENTS!',
    positioning:
      'GENTS is dé FORMELE MOMENTEN SPECIALIST die BETAALBARE LUXE biedt voor ÁLLE formele gelegenheden. ' +
      'We zijn de dresscode-expert die klanten helpt perfect gekleed te zijn voor hun belangrijkste momenten — ' +
      'van bruiloften tot zakelijke meetings, van gala’s tot diploma-uitreikingen. Onze aanpak is warm, ' +
      'menselijk en toegankelijk, gecombineerd met echte expertise. We focussen op de gelegenheid in plaats van ' +
      'demografische doelgroepen.',
    proposition: [
      'BETAALBARE LUXE VOOR ÁLLE FORMELE GELEGENHEDEN',
      'WARM, MENSELIJK EN TOEGANKELIJK — MET EXPERTISE',
      'GELEGENHEID > DOELGROEP'
    ],
    nameRules: [
      'De merknaam "GENTS" mag NOOIT vertaald worden',
      'Altijd in hoofdletters schrijven',
      'Geen spaties of speciale tekens'
    ],
    taglineRules: [
      'De tagline mag NOOIT vertaald worden',
      'Altijd exact zo schrijven, inclusief het streepje',
      'Gebruiken we alleen in ons logo'
    ],
    doelgroep: {
      primair: 'Mannen met een formele gelegenheid (bruiloft, zakelijk, gala, event)',
      secundair: 'Mannen die hun garderobe willen upgraden met betaalbare kwaliteit formalwear',
      geografisch: 'Nederland (primair), België, Duitsland, overige EU',
      psychografisch: 'Waarderen kwaliteit, persoonlijk en deskundig advies'
    }
  },

  usps: [
    { title: 'Formele momenten specialist', points: ['Specialist in alle formele gelegenheden', 'Van bruiloft tot boardroom', 'Van gala tot diploma-uitreiking'] },
    { title: 'Betaalbare luxe, subtiel gecommuniceerd', points: ['Prima kwaliteit tegen eerlijke prijzen', 'Geen opschepperige marketing', 'Laat product en service voor zich spreken'] },
    { title: 'Dresscode-expert', points: ['Dé autoriteit in dresscodes', 'Black tie, cocktail, business formal — we kennen ze allemaal', 'Educatieve content en persoonlijk advies'] },
    { title: 'Offline service + ervaring', points: ['Persoonlijke aandacht in de winkel', 'Pasvorm-expertise', 'Face-to-face styling advies'] }
  ],

  values: [
    { title: 'Betaalbare luxe (subtiel)', points: ['Goede kwaliteit tegen eerlijke prijzen', 'Geen opschepperige "luxury"-marketing', 'Transparant over prijs-kwaliteit'] },
    { title: 'Formele momenten expertise', points: ['Specialist in alle dresscodes', 'Advies op maat per gelegenheid', 'Van bruiloft tot boardroom'] },
    { title: 'Dresscode-experthoofd', points: ['Dé autoriteit in formele kleding', 'Educatieve content over dresscodes', 'Vertrouwde adviseur'] },
    { title: 'Offline service + ervaring', points: ['Persoonlijke aandacht in showroom', 'Pasvorm-expertise', 'Styling advies face-to-face'] },
    { title: 'Warm, menselijk, toegankelijk', points: ['Geen corporate afstandelijkheid', 'Oprechte interesse in de klant', 'Expertise zonder arrogantie'] },
    { title: 'Gelegenheid > doelgroep', points: ['Focus op het moment, niet op leeftijd/demografie', 'Iedereen welkom voor zijn formele moment', 'Inclusief en toegankelijk'] }
  ],

  colors: {
    primary: [
      { name: 'Zwart', hex: '#000000', use: 'Hoofdkleur voor tekst en accenten' },
      { name: 'Wit', hex: '#FFFFFF', use: 'Achtergronden en contrast' },
      { name: 'Donkergrijs', hex: '#2C2C2C', use: 'Secundaire tekst' }
    ],
    secondary: [
      { name: 'Lichtgrijs', hex: '#F5F5F5', use: 'Achtergronden, secties' },
      { name: 'Middengrijs', hex: '#8B8B8B', use: 'Borders, dividers' }
    ],
    accent: [
      { name: 'Navy', hex: '#1A1A2E', use: 'Premium touch (smoking, luxury line)' },
      { name: 'Goud', hex: '#D4AF37', use: 'Luxe accenten — alleen voor VIP/exclusieve aanbiedingen' }
    ],
    usage: [
      'Zwart/wit voor maximale impact en leesbaarheid',
      'Grijstinten voor hiërarchie en structuur',
      'Navy voor premium producten (smoking, luxury line)',
      'Goud alleen voor VIP/exclusieve aanbiedingen (spaarzaam)'
    ],
    luxe: {
      dont: ['"Luxury menswear for the elite"', '"Exclusieve collectie voor de veeleisende man"'],
      do: ['"Betaalbare luxe die bij het moment past"', '"Advies waar je jaren plezier van hebt"', '"Betaalbaar, zonder concessies aan kwaliteit"']
    }
  },

  typography: {
    primary: { family: 'Myriad Pro', use: 'Headers, titels, productnamen, CTA’s', weights: 'Light (300), Regular (400), Bold (700)' },
    secondary: { family: 'Montserrat', use: 'Productbeschrijvingen, algemene tekst', weights: 'Regular (400), Medium (500)' },
    rules: [
      'H1: 48–72px, Bold, zwart',
      'H2: 36–48px, Bold, zwart',
      'H3: 24–32px, Regular/Bold, zwart',
      'Body: 16–18px, Regular, donkergrijs',
      'Small: 12–14px, Regular, middengrijs',
      'Regelhoogte: 1.5–1.8 · Letter-spacing: -0.5px headers, 0px body'
    ]
  },

  logo: {
    do: [
      'Gebruik op neutrale achtergronden (wit, lichtgrijs, donkergrijs, zwart)',
      'Behoud altijd de originele verhoudingen',
      'Zorg voor voldoende contrast met de achtergrond',
      'Minimaal 20% witruimte rondom het logo',
      'Lock de aspect ratio bij schalen'
    ],
    dont: [
      'Niet vervormen of uitrekken',
      'Niet roteren of schuin plaatsen',
      'Geen effecten (schaduwen, glows, gradients)',
      'Kleuren niet aanpassen',
      'Geen extra elementen toevoegen',
      'Niet in vormen plaatsen (cirkel, badge)'
    ],
    clearSpace: 'Minimaal 20% van de logohoogte witruimte aan alle zijden. Minimale breedte 512px voor digitaal gebruik.',
    contrastOk: ['Zwart logo op witte achtergrond', 'Wit logo op zwarte achtergrond'],
    contrastNo: [
      'Zwart logo op lichtgrijs (#F5F5F5 of lichter)',
      'Wit logo op donkergrijs (#2C2C2C of donkerder)',
      'Grijs logo op grijze achtergrond',
      'Logo op een drukke foto, patroon of textuur'
    ]
  },

  photography: {
    aesthetic: ['Dark Luxury', 'Spa-inspired', 'Minimalistisch', 'Editorial'],
    kenmerken: [
      'Neutrale, effen achtergronden (wit, lichtgrijs, donkergrijs, zwart)',
      'Professionele studio lighting met zachte schaduwen',
      'Spa-inspired sfeer: rustig, verfijnd, premium',
      'Editorial stijl: clean, sophisticated',
      'Focus op product en pasvorm, minimale props'
    ],
    modelDo: [
      { title: 'Professionele presentatie', points: ['Natuurlijke, zelfverzekerde houding', 'Ontspannen uitdrukking', 'Directe of subtiel wegkijkende blik', 'Staand, zittend, lopend — natuurlijke poses'] },
      { title: 'Verzorgd uiterlijk', points: ['Netjes haar (niet stijf gestyled)', 'Schoon geschoren of verzorgde baard', 'Schone, gestreken kleding', 'Passende schoenen (zwart/bruin leer)'] },
      { title: 'Correcte pasvorm', points: ['Jasje goed op de schouders', 'Mouwen tonen 1cm overhemdmanchet', 'Broek breekt licht op de schoen', 'Boord netjes, das correct geknoopt'] },
      { title: 'Neutrale achtergrond', points: ['Effen wit/lichtgrijs/donkergrijs/zwart', 'Studio met zachte schaduwen', 'Minimale props (stoel, tafel max)'] },
      { title: 'Diverse representatie', points: ['Verschillende leeftijden (25–50)', 'Verschillende etniciteiten en body types', 'Authentieke, herkenbare mannen'] }
    ],
    modelDont: [
      { title: 'Onnatuurlijke poses', points: ['Overdreven fashion poses', 'Stijve, ongemakkelijke houding', 'Geforceerde uitdrukkingen'] },
      { title: 'Slechte grooming', points: ['Onverzorgd haar', 'Gekreukte kleding', 'Vuile of verkeerde schoenen'] },
      { title: 'Verkeerde pasvorm', points: ['Jasje te groot/klein', 'Broek te lang (te veel break)', 'Overhemd te strak of te wijd'] },
      { title: 'Afleidende achtergrond', points: ['Drukke patronen of felle kleuren', 'Rommelige settings', 'Te veel props of decoratie'] },
      { title: 'Stereotype representatie', points: ['Alleen jonge modelachtige mannen', 'Geen diversiteit', 'Overdreven "macho" / te fashion-forward'] },
      { title: 'Technische fouten', points: ['Slechte belichting (te donker/licht)', 'Out of focus / harde schaduwen', 'Verkeerde witbalans, ruis/grain'] }
    ],
    product: [
      { title: 'Lifestyle shots', desc: 'Model draagt het product in een natuurlijke setting, neutrale achtergrond, focus op hoe het valt en past.' },
      { title: 'Detail shots', desc: 'Close-ups van materiaal, textuur, naden, knoopsgaten, voering en labels — craftsmanship.' },
      { title: 'Flat lays', desc: 'Product symmetrisch en gecentreerd op neutrale achtergrond, consistent licht, evt. complementaire items.' },
      { title: 'Ghost mannequin', desc: 'Voor overhemden en jassen — schone uitsnede, consistente hoek en positie.' }
    ],
    lighting: [
      'Soft, diffuus licht — geen harde schaduwen',
      'Three-point lighting (key, fill, backlight)',
      'Kleurtemperatuur 5000–5500K (daylight balanced)',
      'Consistente belichting over alle productfoto’s',
      'Spa-inspired mood: zachte, warme undertones toegestaan'
    ],
    specs: [
      { label: 'Productfoto', value: '2048×2048px min. (vierkant), sRGB, JPG (web) / PNG (transparant), < 500KB web' },
      { label: 'Lifestyle', value: '1600×2400px (2:3) of 2048×2048px, 72 DPI, JPG, sRGB' },
      { label: 'Banner', value: 'Desktop 1920×600px min., mobile 800×1200px, 72 DPI, JPG/PNG' }
    ]
  },

  toneOfVoice: {
    personality: ['Professioneel', 'Toegankelijk', 'Verfijnd', 'Betrouwbaar', 'Warm', 'Menselijk', 'Expert'],
    intro:
      'GENTS communiceert als een ervaren stylist en dresscode-expert: deskundig maar niet arrogant, ' +
      'professioneel maar toegankelijk, verfijnd maar niet pretentieus, warm en menselijk met echte expertise.',
    do: [
      'Spreek met respect ("u" formeel, "je" casual)',
      'Gebruik heldere, directe taal',
      'Focus op de gelegenheid (bruiloft, zakelijk, gala)',
      'Toon dresscode-expertise en geef styling-advies',
      'Wees informatief over materialen en onderhoud',
      'Wees warm, menselijk en toegankelijk'
    ],
    dont: [
      'Geen overdreven marketing-taal',
      'Geen agressieve sales-tactieken',
      'Geen jargon zonder uitleg',
      'Geen beloftes die niet waargemaakt kunnen worden',
      'Geen negatieve vergelijkingen met concurrenten',
      'Geen corporate afstandelijkheid'
    ],
    occasionsDo: ['"Perfect voor je bruiloft"', '"Ideaal voor zakelijke meetings"', '"Jouw gala-outfit"', '"Black tie? Wij hebben je covered"'],
    occasionsDont: ['"Voor de moderne man van 30-40"', '"Ideaal voor millennials"', '"Perfect voor de zakenman"'],
    expertiseDo: ['"Als dresscode-specialist adviseren we..."', '"Voor black tie events is de regel..."', '"Tip van onze styling experts..."'],
    expertiseDont: ['"Wij weten het beste"', '"Luister naar de experts"', '"Als marktleider..."'],
    examples: {
      productDescription:
        'Dit premium wolblend pak combineert tijdloze elegantie met modern comfort. De fijne wol zorgt voor een ' +
        'luxe uitstraling en perfecte pasvorm, terwijl de stretch-component bewegingsvrijheid garandeert. Ideaal ' +
        'voor zakelijke gelegenheden en speciale events zoals bruiloften en gala’s.',
      emailSubjects: ['"Jouw perfecte pak voor het nieuwe seizoen"', '"Nieuw: Premium overhemden collectie"', '"Styling tip: Zo draag je een smoking"'],
      socialCaption: 'Elegantie in elk detail. Ontdek onze nieuwe wolblend collectie — perfect voor alle formele momenten. #GENTS #SuitsYou'
    }
  },

  vision: {
    title: 'Visie GENTS 2026–2028',
    summary: 'GENTS groeit internationaal met behoud van identiteit. Eén merk, één beleving, meerdere landen. Groei is het gevolg van consistentie, niet van toeval.',
    pillars: [
      { title: 'Ambitie', body: 'Van sterke Nederlandse omnichannel-retailer naar een internationaal herkenbaar menswear-merk, met gecontroleerde buitenlandse expansie binnen twee jaar.' },
      { title: 'Internationale expansie', body: 'Binnen 12 maanden actief in 2–3 strategische EU-markten. Gefaseerd: eerst e-commerce, daarna fysieke touchpoints. Marktselectie op koopkracht, logistiek en merkfit.' },
      { title: 'Eén consistente merkbeleving', body: 'Of een klant nu in Haarlem winkelt of online bestelt vanuit Duitsland: GENTS voelt overal hetzelfde — één visuele identiteit, één tone of voice, één serviceniveau, één verhaal.' },
      { title: 'Omnichannel als fundament', body: 'Online en offline versterken elkaar. Eén centrale voorraad- en orderlogica, een naadloze klantreis en data-gedreven sturing. Omnichannel is de basisvoorwaarde voor schaalbare groei.' },
      { title: 'Assortiment & positionering', body: 'Tijdloze kwaliteit: business casual, tailoring en gelegenheidskleding. Duidelijke subcategorieën (formeel, casual, wedding, seasonal) met balans tussen NOS en commerciële collecties.' },
      { title: 'Klant centraal', body: 'Uitblinken in relevantie en gemak: persoonlijke communicatie op basis van data, transparantie in prijs/levertijd/service en loyaliteit belonen via consistente voordelen.' },
      { title: 'Organisatie & cultuur', body: 'Duidelijke structuren en processen, schaalbare systemen, eigenaarschap per team met één gedeelde visie en continue verbetering op basis van data.' },
      { title: 'Lange termijn', body: 'Geen snelle omzetgroei maar een duurzaam merk: internationaal herkenbaar, vertrouwenwekkend en jarenlang relevant voor de moderne man.' }
    ]
  },

  logos: [
    { label: 'Logo zwart', file: 'brand-logo-zwart.png', bg: 'light' },
    { label: 'Logo wit', file: 'brand-logo-wit.png', bg: 'dark' },
    { label: 'Logo zwart + slogan', file: 'brand-logo-zwart-slogan.png', bg: 'light' },
    { label: 'Beeldmerk vierkant', file: 'brand-logo-vierkant.png', bg: 'light' },
    { label: 'Beeldmerk 512px (transparant)', file: 'brand-logo-512.png', bg: 'light' }
  ],

  photos: {
    modelStyling: [
      { file: 'brand-model-charcoal.jpg', caption: 'Charcoal kostuum — staand', kind: 'do' },
      { file: 'brand-model-navy.jpg', caption: 'Navy kostuum — zittend', kind: 'do' },
      { file: 'brand-model-tuxedo.jpg', caption: 'Zwarte smoking', kind: 'do' },
      { file: 'brand-model-grey3piece.jpg', caption: 'Grijs three-piece — lopend', kind: 'do' },
      { file: 'brand-model-tan.jpg', caption: 'Tan/beige kostuum', kind: 'do' },
      { file: 'brand-model-not-diversity.jpg', caption: 'Geen diversiteit + technische fouten', kind: 'dont' },
      { file: 'brand-model-not-stereotype.jpg', caption: 'Stereotype + verkeerde pasvorm', kind: 'dont' },
      { file: 'brand-model-not-grooming.jpg', caption: 'Slechte grooming + rommelig', kind: 'dont' },
      { file: 'brand-model-not-fit.jpg', caption: 'Te strak + overdreven', kind: 'dont' }
    ],
    product: [
      { file: 'brand-product-lifestyle.jpg', caption: 'Lifestyle product shot' },
      { file: 'brand-product-fabric.jpg', caption: 'Stof-detail (macro)' },
      { file: 'brand-product-flatlay.jpg', caption: 'Flat lay compositie' },
      { file: 'brand-product-ghost.jpg', caption: 'Ghost mannequin — overhemd' },
      { file: 'brand-product-label.jpg', caption: 'Interieur label-detail' }
    ],
    impression: [
      { file: 'brand-impression-wedding-social.jpg', caption: 'Bruiloft — social' },
      { file: 'brand-impression-wedding.jpg', caption: 'Bruiloft — setting' },
      { file: 'brand-impression-gala.jpg', caption: 'Gala — setting' },
      { file: 'brand-impression-interview.jpg', caption: 'Zakelijk — interview' },
      { file: 'brand-impression-funeral.jpg', caption: 'Uitvaart — sober' },
      { file: 'brand-impression-peaky.jpg', caption: 'Peaky-blinders bruiloft (editorial)' }
    ]
  },

  downloads: [
    { label: 'Volledig brandbook (Word)', note: 'BRANDBOOK - GENTS.docx — SharePoint' },
    { label: 'Visie 2026–2028 (Word)', note: 'Visie GENTS (2026–2028).docx — SharePoint' },
    { label: 'Fonts: Myriad Pro', note: 'MyriadPro-FontPack.zip — SharePoint (Adobe-licentie)' }
  ]
};

/**
 * Bouwt de system-prompt voor de AI-generatie van product-omschrijvingen,
 * o.b.v. de GENTS tone-of-voice uit het brandbook.
 */
export function buildDescriptionSystemPrompt() {
  const b = BRANDBOOK;
  const tov = b.toneOfVoice;
  return [
    `Je bent de copywriter van ${b.brand.name}, een Nederlandse premium herenmode-retailer en formele-momenten-specialist. Schrijf Nederlandse product-omschrijvingen in de ${b.brand.name}-tone-of-voice.`,
    '',
    `POSITIONERING: ${b.brand.positioning}`,
    '',
    `TONE OF VOICE: ${tov.personality.join(', ')}. ${tov.intro}`,
    `WEL: ${tov.do.join(' · ')}`,
    `NIET: ${tov.dont.join(' · ')}`,
    `OVER GELEGENHEDEN — wel: ${tov.occasionsDo.join(' ')} | niet: ${tov.occasionsDont.join(' ')}`,
    `OVER "LUXE" — wel: ${b.colors.luxe.do.join(' ')} | niet: ${b.colors.luxe.dont.join(' ')}`,
    `VOORBEELD (alleen voor de TOON, niet voor de lengte): "${tov.examples.productDescription}"`,
    '',
    'REGELS:',
    '- Nederlands, MAXIMAAL 2 korte zinnen (één alinea), platte tekst — geen koppen, opsommingen of emoji.',
    '- Focus op de gelegenheid en op pasvorm, materiaal en comfort waar relevant.',
    '- Geen opschepperige "luxury"-claims en geen demografie (leeftijd/doelgroep).',
    '- Verzin geen feiten (exacte samenstelling, prijs, herkomst) die niet zijn aangeleverd; blijf dan algemeen.',
    '- Geef alleen de omschrijving terug, zonder aanhef of ondertekening.'
  ].join('\n');
}

export default BRANDBOOK;
