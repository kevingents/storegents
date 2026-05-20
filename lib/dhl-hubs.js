/**
 * DHL hub mapping per GENTS winkel.
 *
 * Bron: Excel "Gents B.V. - Contactgegevens per winkel" (DHL pickups).
 * Per winkel staat het serving DHL hub + bijbehorende depot-email/telefoon
 * en het verwachte pickup-venster.
 *
 * Gebruik:
 *   - api/transport/dhl-noshow: kiest depot-email op basis van winkel
 *   - winkel-modal: toont aan medewerker wanneer DHL had moeten komen
 *   - admin DHL Prestaties: toont hub per winkel
 *
 * Antwerpen valt buiten dit overzicht (BE, andere DHL-organisatie).
 */

export const DHL_HUBS = {
  'GENTS Almere': {
    hub: 'RH Amersfoort',
    email: 'boq.ame@dhl.com',
    phone: '06-51174489',
    pickupWindow: '15:00 - 17:00',
    registeredSince: '2025-01-19',
    pickupAddress: 'Stadhuisstraat 4, 1315HC Almere'
  },
  'GENTS Amersfoort': {
    hub: 'RH Amersfoort',
    email: 'boq.ame@dhl.com',
    phone: '06-51174489',
    pickupWindow: '15:00 - 17:00',
    registeredSince: '2025-01-19',
    pickupAddress: 'Langestraat 71, 3811AC Amersfoort'
  },
  'GENTS Amsterdam': {
    hub: 'RH Amsterdam',
    email: 'boq.ams@dhl.com',
    phone: '088-3430265',
    pickupWindow: '15:00 - 17:00',
    registeredSince: '2025-01-19',
    pickupAddress: 'Van Woustraat 68, 1073LN Amsterdam'
  },
  'GENTS Arnhem': {
    hub: 'RH Arnhem',
    email: 'arnhem@dhl.com',
    phone: '088-3430335',
    pickupWindow: '12:00 - 16:00',
    registeredSince: '2025-01-21',
    pickupAddress: 'Bakkerstraat 28, 6811EH Arnhem'
  },
  'GENTS Breda': {
    hub: 'RH Roosendaal',
    email: 'boq.roo@dhl.com',
    phone: '088-3430673',
    pickupWindow: '16:00 - 18:00',
    registeredSince: '2025-01-19',
    pickupAddress: 'Karrestraat 1, 4811WT Breda'
  },
  'GENTS Delft': {
    hub: 'RH Den Haag',
    email: 'denhaag@dhl.com',
    phone: '088-3430403',
    pickupWindow: '10:00 - 12:00',
    registeredSince: '2025-01-19',
    pickupAddress: 'Oude Langedijk 10, 2611GK Delft'
  },
  'GENTS Den Bosch': {
    hub: 'RH den Bosch',
    email: 'boq.her@dhl.com',
    phone: '088-3430474',
    pickupWindow: '14:00 - 16:00',
    registeredSince: '2025-03-09',
    pickupAddress: 'Schapenmarkt 22, 5211ET Den Bosch'
  },
  'GENTS Enschede': {
    hub: 'RH Hengelo',
    email: 'planning.hengelo@dhl.com',
    phone: '088-3430600',
    pickupWindow: '10:00 - 12:00',
    registeredSince: '2025-01-19',
    pickupAddress: 'Langestraat 8, 7511HC Enschede'
  },
  'GENTS Groningen': {
    hub: 'RH Drachten',
    email: 'planning.drachten@dhl.com',
    phone: '088-3430512',
    pickupWindow: '10:00 - 12:00',
    registeredSince: '2025-01-19',
    pickupAddress: 'Zwanestraat 41, 9712CK Groningen'
  },
  'GENTS Hilversum': {
    hub: 'RH Utrecht',
    email: 'boq.utr@dhl.com',
    phone: '06-23018485',
    pickupWindow: '10:00 - 12:00',
    registeredSince: '2025-01-21',
    pickupAddress: 'Gijsbrecht van Amstelstraat 127, 1214AW Hilversum'
  },
  'GENTS Leiden': {
    hub: 'RH Den Haag',
    email: 'denhaag@dhl.com',
    phone: '088-3430403',
    pickupWindow: '15:00 - 17:00',
    registeredSince: '2025-01-19',
    pickupAddress: 'Haarlemmerstraat 149, 2312DN Leiden'
  },
  'GENTS Maastricht': {
    hub: 'RH Beek',
    email: 'boq.bee@dhl.com',
    phone: '088-3430397',
    pickupWindow: '15:00 - 17:00',
    registeredSince: '2025-01-19',
    pickupAddress: 'Sint Amorsplein 8, 6211GT Maastricht'
  },
  'GENTS Nijmegen': {
    hub: 'RH Arnhem',
    email: 'arnhem@dhl.com',
    phone: '088-3430335',
    pickupWindow: '12:00 - 16:00',
    registeredSince: '2025-01-21',
    pickupAddress: 'Molenstraat 56, 6511HG Nijmegen'
  },
  'GENTS Rotterdam': {
    hub: 'RH Rotterdam',
    email: 'dispatch-dd-rotterdam@dhl.com',
    phone: '088-3430700',
    pickupWindow: '10:00 - 12:00',
    registeredSince: '2025-01-19',
    pickupAddress: 'Oude Binnenweg 102A, 3012JG Rotterdam'
  },
  'GENTS Tilburg': {
    hub: 'RH Eindhoven',
    email: 'dispatch.eindhoven@dhl.com',
    phone: '088-3430555',
    pickupWindow: '14:00 - 18:00',
    registeredSince: '2025-01-19',
    pickupAddress: 'Emmapassage 30, 5038XA Tilburg'
  },
  'GENTS Utrecht': {
    hub: 'RH Utrecht',
    email: 'boq.utr@dhl.com',
    phone: '06-23018485',
    pickupWindow: '15:00 - 17:00',
    registeredSince: '2025-01-19',
    pickupAddress: 'Steenweg 43, 3511JM Utrecht'
  },
  'GENTS Zoetermeer': {
    hub: 'RH Den Haag',
    email: 'denhaag@dhl.com',
    phone: '088-3430403',
    pickupWindow: '15:00 - 17:00',
    registeredSince: '2025-01-19',
    pickupAddress: 'Noordwaarts 212, 2711HP Zoetermeer'
  },
  'GENTS Zwolle': {
    hub: 'RH Zwolle',
    email: 'zwolle@dhl.com',
    phone: '088-3430800',
    pickupWindow: '15:00 - 17:00',
    registeredSince: '2025-01-26',
    pickupAddress: 'Luttekestraat 42, 8011LS Zwolle'
  }
};

/**
 * Geeft DHL hub-info terug voor een specifieke winkel.
 * Returnt null als de winkel geen mapping heeft (bijv. Antwerpen, magazijn).
 */
export function getDhlHubForStore(store) {
  if (!store) return null;
  const key = String(store).trim();
  if (DHL_HUBS[key]) return { store: key, ...DHL_HUBS[key] };
  /* Case-insensitive fallback */
  const lc = key.toLowerCase();
  const matchKey = Object.keys(DHL_HUBS).find((k) => k.toLowerCase() === lc);
  if (matchKey) return { store: matchKey, ...DHL_HUBS[matchKey] };
  return null;
}

/**
 * Geeft een platte lijst terug van alle hubs + de winkels die ze bedienen.
 * Handig voor admin UI ("Per hub: welke winkels"?).
 */
export function getDhlHubsGrouped() {
  const groups = new Map();
  for (const [store, info] of Object.entries(DHL_HUBS)) {
    if (!groups.has(info.hub)) {
      groups.set(info.hub, {
        hub: info.hub,
        email: info.email,
        phone: info.phone,
        stores: []
      });
    }
    groups.get(info.hub).stores.push({
      store,
      pickupWindow: info.pickupWindow,
      pickupAddress: info.pickupAddress
    });
  }
  return Array.from(groups.values()).sort((a, b) => a.hub.localeCompare(b.hub));
}

/**
 * Bepaalt het juiste depot-emailadres voor een no-show melding.
 * Volgorde:
 *   1. Winkel-specifieke hub-email uit DHL_HUBS
 *   2. Fallback: DHL_DEPOT_EMAIL env var
 *   3. Fallback: SUPPORT_EMAIL env var
 */
export function getDepotEmailForStore(store) {
  const hub = getDhlHubForStore(store);
  if (hub && hub.email) return hub.email;
  return String(
    process.env.DHL_DEPOT_EMAIL ||
    process.env.SUPPORT_EMAIL ||
    ''
  ).trim();
}
