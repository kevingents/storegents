# GENTS Portal — Architectuur

> Voor wie dit leest: opvolger of nieuwe developer die wil snappen
> "hoe stroomt data door dit systeem". Diagrammen zijn ASCII-art zodat
> ze in GitHub-markdown direct leesbaar zijn.

## Inhoudsopgave

- [🗺️ Het grote plaatje](#het-grote-plaatje)
- [📦 Repo-structuur](#repo-structuur)
- [🔌 Externe systemen](#externe-systemen)
- [🌊 Vijf belangrijkste data-flows](#vijf-belangrijkste-data-flows)
- [💾 Waar zit welke state](#waar-zit-welke-state)
- [🔐 Authenticatie & autorisatie](#authenticatie--autorisatie)
- [🧠 Ontwerpkeuzes](#ontwerpkeuzes)

---

## 🗺️ Het grote plaatje

```
                            ┌──────────────────────┐
                            │  MEDEWERKER (browser)│
                            │   Chrome / Edge /    │
                            │   Safari op laptop   │
                            │   of mobiel          │
                            └──────────┬───────────┘
                                       │ HTTPS
                                       │ (Shopify-theme = login-shell)
                            ┌──────────▼───────────┐
                            │  SHOPIFY THEME       │
                            │  (shopifystore repo) │
                            │                      │
                            │  ┌─────────────────┐ │
                            │  │ portal-v6 .     │ │
                            │  │  liquid section │ │
                            │  │  + asset .js    │ │
                            │  └────────┬────────┘ │
                            └───────────┼──────────┘
                                        │
                                        │ fetch() naar
                                        │ storegents.vercel.app
                                        │
                            ┌───────────▼──────────┐
                            │  VERCEL API          │
                            │  (storegents repo)   │
                            │                      │
                            │  /api/admin/*        │
                            │  /api/store/*        │
                            │  /api/srs/*          │
                            │  /api/cron/*         │
                            └────┬────┬────┬───┬───┘
                                 │    │    │   │
                  ┌──────────────┘    │    │   └─────────────┐
                  │                   │    │                 │
                  ▼                   ▼    ▼                 ▼
        ┌────────────────┐  ┌──────────────────┐  ┌──────────────┐
        │  SRS ERP       │  │   SHOPIFY ADMIN  │  │ VERCEL BLOB  │
        │  (SOAP)        │  │   (GraphQL)      │  │ (JSON files) │
        │                │  │                  │  │              │
        │  Voorraad      │  │  Producten       │  │ config/      │
        │  Klanten       │  │  Orders          │  │ srs/         │
        │  Weborders     │  │  Variants        │  │ audit/       │
        │  Kassa-bonnen  │  │  Refunds         │  │ wk-poule/    │
        │  Vouchers      │  │  Customers       │  │ ...          │
        └────────────────┘  └──────────────────┘  └──────────────┘

                            ┌──────────────────────────────────────┐
                            │  AUXILIARY SERVICES                  │
                            │                                      │
                            │  Resend       (mail)                 │
                            │  Sendcloud    (verzendlabels)        │
                            │  Google Places(reviews)              │
                            │  Google Biz   (uitgebreide reviews)  │
                            │  Returnista   (retours)              │
                            └──────────────────────────────────────┘
```

**Stappen om data uit het systeem te halen** (voorbeeld: dashboard-laden):

1. Browser opent shopify-page → Liquid section renderert → `gents-portal-v6.js` boot
2. JS doet `fetch('https://storegents.vercel.app/api/admin/today-stats')`
3. Vercel API leest SRS via SOAP + Shopify via GraphQL parallel
4. Aggregeert → returns JSON
5. JS rendert KPI-cards in de DOM

---

## 📦 Repo-structuur

### `shopifystore/` — frontend (Shopify-theme)

```
shopifystore/
├── sections/
│   └── gents-portal-v6.liquid       ← Hoofdsectie. Bevat sidebar-nav,
│                                       page-headers, en de "shell"
│                                       voor de portal.
├── snippets/
│   ├── gents-portal-v6-modals.liquid ← ALLE modals (~80+) staan hier.
│   │                                   Modal-naam: `data-modal="xxx"`.
│   └── gents-admin-page-*.liquid     ← Grote admin-pages die niet in
│                                        de section passen (256kB limit).
├── assets/
│   ├── gents-portal-v6.js            ← Monolieth (~30k+ regels).
│   │                                   Boot, state, alle event-handlers,
│   │                                   alle modal-loaders. Splitsen
│   │                                   wenselijk maar nog open.
│   └── gents-portal-v6.css           ← Bible-style design tokens +
│                                        per-component klassen.
└── mockups/
    └── *.html                        ← Stand-alone HTML-mockups,
                                         design-referentie. Niet live.
```

### `storegents/` — backend (Vercel API)

```
storegents/
├── api/
│   ├── admin/*                       ← Endpoints die admin-token vereisen.
│   │                                   Per domein gesplitst: orders/,
│   │                                   reports/, wk-poule/, etc.
│   ├── store/*                       ← Publieke (CORS-open) endpoints
│   │                                   die de portal aanroept zonder
│   │                                   token (oa article-search,
│   │                                   stock-lookup).
│   ├── srs/*                         ← Directe SRS-passthrough endpoints
│   │                                   (customer-info, transactions).
│   ├── cron/*                        ← Vercel cron-handlers.
│   │                                   Auth via CRON_SECRET.
│   └── wk-poule/*                    ← WK Poule publieke endpoints.
│
├── lib/
│   ├── business-config.js            ← Single source of truth voor
│   │                                   bedrijfsregels (zie CONFIGURATION.md)
│   ├── srs-*-client.js               ← SOAP-clients per SRS-onderdeel
│   ├── shopify-*-client.js           ← GraphQL helpers
│   ├── *-store.js                    ← Blob-backed CRUD stores
│   │                                   (config/audit/cache)
│   ├── gents-mailer.js               ← Resend-wrapper met templates
│   └── cors.js                       ← CORS + admin-auth helpers
│
├── docs/                              ← Deze documentatie-suite
├── vercel.json                       ← Cron-schedules + rewrites
└── package.json
```

---

## 🔌 Externe systemen

### SRS ERP (Store Retail Suite)
- **Protocol**: SOAP via XML over HTTPS
- **Auth**: username + password in elk request (legacy)
- **Endpoints we gebruiken**:
  - `Customers/Data` — `GetTransactions`, `GetCustomerInfo`, `GetBills`
  - `Stock/Data` — `GetStock`, `GetStockSnapshot`
  - `Personnel/Data` — `GetPersonnel`, `GetBranches`
  - `Orders/Data` — `GetWebOrder`, `CancelWebOrder`, `SetUnavailable`
  - `Exchanges/Data` — `CreateExchange`, `GetExchanges`
  - `Loyalty/Data` — `GetPoints`, `GetVouchers`
- **Bottleneck**: 1 call tegelijk per session, 15-20s per call typisch
- **Caching strategie**: bijna alles cached (snapshot-cron), realtime alleen voor
  individuele klant-lookup of write-actions

### Shopify Admin API
- **Protocol**: GraphQL Admin API + REST (oude endpoints)
- **Auth**: `X-Shopify-Access-Token` header
- **Belangrijkste queries**:
  - `products(query:)` — productcatalogus (cached, dagelijks ververst)
  - `productVariants(query:)` — barcode-zoek
  - `orders` — REST endpoint voor today-stats + refund-detail
  - `customers` — niet veel gebruikt (SRS is bron-of-truth)
- **Rate-limit**: 1000 punten/request, ~50ms recovery per punt
- **Webhooks**: alleen Resend-webhook voor bounce/complaint, geen Shopify-webhooks

### Vercel Blob
- **Wat**: persistent key-value JSON-storage, beheerd door Vercel
- **Auth**: `BLOB_READ_WRITE_TOKEN` (auto-gezet door Vercel)
- **Pad-conventies**:
  - `config/*.json` — admin-instellingen (role-permissions, region-config, store-emails)
  - `srs/*.json` — SRS-cache (branch-snapshots, transactions-cache)
  - `audit/*.json` — change-logs (permissions-audit, cron-log)
  - `wk-poule/*.json` — poule-data (prizes, schedule, predictions/, bonus-questions, correct-bonus)
  - `mail-events/*.json` — mail-audit-log (bounces, complaints, sent)

### Resend (mail)
- **Wat**: transactional mail-provider
- **Templates**: inline HTML in `gents-mailer.js` (`baseMailHtml(...)`)
- **Audit**: elke send in `mail-events-store` (90 dagen retention)
- **Webhook**: bounce + complaint via `/api/webhooks/resend-events`

### Sendcloud
- **Wat**: verzendlabel-generator (DHL, Bpost, PostNL)
- **Auth**: API-key
- **Flow**: label aanmaken → tracking-code → mailen naar klant

### Google Places + Business Profile
- **Wat**: reviews-data per winkel
- **Auth**: Places-key (publiek) + service-account JSON (business)
- **Cache**: dagelijks snapshot via cron (`google-reviews-snapshot.js`)

### Returnista
- **Wat**: externe retour-provider
- **Auth**: API-key per winkel
- **Flow**: retour-pakket aanmaken → klant ontvangt QR-code

---

## 🌊 Vijf belangrijkste data-flows

### 1. Pickup-flow (klant haalt weborder op)

```
KLANT plaatst order op Shopify (webshop)
   │
   ▼
SHOPIFY genereert orderNr, stuurt naar SRS via SRS-push
   │
   ▼
SRS markeert order voor fulfilment in branch X
   │
   ├─→ ELK UUR: /api/cron/pickup-mail-run
   │       │
   │       ▼
   │   leest SRS open-weborders → bouwt mail-batch
   │       │
   │       ▼
   │   RESEND mailt klant "kom afhalen in winkel X"
   │       │
   │       ▼
   │   mail-event opgeslagen in audit-log
   │
KLANT komt naar winkel en haalt order op
   │
   ▼
MEDEWERKER scant barcode aan kassa → SRS POS-bon
   │
   ▼
SRS-bon heeft zowel `receiptNr` als `orderNr`
   = pickup, telt voor WEBSHOP-omzet (niet winkel-omzet)
```

### 2. Voorraad-correctie aanvraag (winkel → HQ → SRS)

```
WINKEL telt voorraad en ziet afwijking (bv. 3 ipv 5 stuks)
   │
   ▼
Medewerker opent "Voorraad correctie aanvragen" modal
   │ search artikel → vul werkelijke aantal in per maat
   │ kies reden → submit
   ▼
POST /api/store/stock-corrections (action: 'create')
   │
   ▼
stock-corrections-store schrijft naar
   config/stock-correction-requests.json (Vercel Blob)
   status='pending'
   │
   ▼
ADMIN ziet aanvraag in admin-page voorraad-correcties
   bekijkt vertrouwensscore + historie
   │
   ▼
[Goedkeuren]                   [Afwijzen]
   │                              │
   ▼                              ▼
status='approved'           status='rejected'
   │                          mail naar winkel
   ▼
HQ-medewerker doet de SRS-update handmatig (write-API is in audit)
   markeert als 'completed' in admin
```

### 3. Omzet-rapportage (SRS-bonnen + Shopify webshop → dashboard)

```
GEBRUIKER opent omzet-pagina, kiest periode "deze week"
   │
   ▼
fetch /api/admin/revenue-srs?period=week (SRS-kant)
      /api/admin/revenue?period=week     (Shopify-kant)
   │  parallel
   ▼
SRS-call: GetTransactions(from, until) over alle branches
   │
   ▼
aggregate() in revenue-srs.js:
   - per item: charged ≥ 0 → grossRevenue
                charged  < 0 → refundedRevenue (retour)
   - filter pure POS (receipt JA, orderNr NEE)
   - groepeer per branch + per dag
   - netRevenue = gross - refunded
   │
   ▼
Shopify-call: Orders met status=any in periode
   │
   ▼
filter webshop-orders (geen 'gents-offline' tag)
   - per order: total - refunds - cancellations
   - aparte buckets: bruto, refunded, cancelled, net
   │
   ▼
Frontend rendert split-view:
   - Winkels: € X bruto − € Y retour = € X-Y netto
   - Webshop: € A bruto − € B refund − € C cancel = € net
   - Totaal: winkel-netto + webshop-netto
```

### 4. WK Poule scoring (admin vult uitslag → leaderboards updaten)

```
WEDSTRIJD wordt gespeeld
   │
   ▼
ADMIN opent "WK Poule uitslagen invoeren" modal
   vult homeScore + awayScore per match → Bevestigen
   │
   ▼
POST /api/admin/wk-poule/match-result
   │
   ▼
setMatchResult() in wk-poule-store:
   - match status → 'finished'
   - resultEnteredAt = now
   schrijft naar wk-poule/schedule.json
   │
   ▼
invalidateLeaderboardCache() (in-memory, 60s TTL)
   │
   ▼
SPELER opent WK Poule modal volgende keer
   │
   ▼
fetch /api/wk-poule/leaderboard
   │
   ▼
buildFull():
   - listPredictions() — alle blob predictions/*.json
   - voor elke: scorePrediction(matches, correctBonus, bonusQs)
     * per match: 10/5/3/0 pt op basis van uitslag
     * lastWeekPoints: matches finished in 7 dagen
   - aggregeer per user + per winkel
   - top 3 lastWeekPoints = topWeek
   │
   ▼
Modal toont: jouw winkel positie, leaderboards, top-voorspeller podium
```

### 5. Klantinschrijving aan kassa

```
KLANT bij kassa, medewerker vraagt voor klant-registratie
   │
   ▼
Medewerker opent "Klantinschrijving" modal
   vult naam + e-mail + (optioneel postcode/huisnr) in
   │
   ▼
POST /api/store/customer-create
   │
   ▼
srs-customers-client.createCustomer(data)
   SOAP-call → SRS maakt customerId aan
   │
   ▼
[Parallel] gents-mailer.sendWelcomeMail(klantEmail)
   via Resend → audit in mail-events-store
   │
   ▼
[Parallel] log naar 'klantinschrijvingen-deze-maand' aggregaat
   voor weekrapport + KPI
   │
   ▼
Returns: { customerId, welcomeMailSent: true }
   │
   ▼
Modal toont success: "Klant 12345 aangemaakt, welkomstmail verstuurd"
```

---

## 💾 Waar zit welke state

| Type data | Locatie | TTL / Permanentie |
|---|---|---|
| **Login-sessie** (personnel) | Browser `localStorage` | 12 uur |
| **Login-sessie** (office-user) | Vercel Blob `personnel-sessions/` | 12 uur |
| **Sessie-info zichtbaar voor JS** | `window.localStorage.gents_portal_session` | Persistent tot logout |
| **Drafts** (bv. WK Poule, voorraad-correctie) | JS-memory in modal-state | Tot save of modal-sluiten |
| **API-cache** | In-memory per-Vercel-instance | 1-60 min (zie BUSINESS_CONFIG.cache) |
| **SRS-snapshots** (voorraad) | Vercel Blob `srs/branch-stock-*.json` | Refresh elke 30 min via cron |
| **Shopify products cache** | Vercel Blob `shopify/products-cache.json` | Refresh dagelijks 03:00 UTC |
| **Admin-config** (permissions, regio's) | Vercel Blob `config/*.json` | Permanent, edited via admin-UI |
| **Audit-logs** | Vercel Blob `audit/*.json` | Permanent (GDPR-overweging) |
| **Mail-events** | Vercel Blob `mail-events/*.json` | 90 dagen retention |
| **WK Poule predictions** | Vercel Blob `wk-poule/predictions/*.json` | Permanent (toernooi-duur) |
| **Cron-runs log** | Vercel Blob `audit/cron-log.json` | Permanent |
| **Secrets** | Vercel env-vars | Beheerd in Vercel dashboard |

---

## 🔐 Authenticatie & autorisatie

```
┌─────────────────────────────────────────────────────────────┐
│  4 SOORTEN AUTH                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. PERSONNEL (winkelmedewerker)                            │
│     → personnelNumber + pincode                             │
│     → 12u sessie in localStorage + blob                     │
│     → Permissies via rol + allowedStores                    │
│                                                             │
│  2. OFFICE USER (hoofdkantoor)                              │
│     → email + wachtwoord + 2FA-code                         │
│     → Granulaire permissies via user-permissions-store      │
│     → Kan via "store-switcher" werken namens een winkel     │
│                                                             │
│  3. ADMIN-TOKEN (system-to-system)                          │
│     → env-var ADMIN_TOKEN                                   │
│     → Vereist voor alle /api/admin/* endpoints              │
│     → Frontend stuurt 'm via x-admin-token header           │
│                                                             │
│  4. CRON-SECRET (Vercel cron)                               │
│     → env-var CRON_SECRET                                   │
│     → Vercel zet automatisch Authorization: Bearer <token>  │
│     → Alleen /api/cron/* endpoints accepteren dit           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Permission-flow per request**:

```
Request → CORS check → Auth check (token?) → Permission check (rol+overrides)
        → Endpoint logic → Response
```

**Permission-driven UI** (zie ook GLOSSARY):
- Elk modal/nav-link heeft `data-perm="page.xxx"` of `data-perm="action.yyy"`
- Bij login leest JS `/api/me/permissions` → bouwt Set in geheugen
- Alle elementen waarvan perm-key niet in de Set zit → `display:none`

---

## 🧠 Ontwerpkeuzes

### Waarom Shopify als login-shell?
GENTS heeft al een Shopify webshop. Hergebruiken van het theme als
"medewerker-portal" betekent: gratis SSL, hosting, CDN, eenvoudige
auth-koppeling. Trade-off: 256KB liquid-section limiet (waardoor we
sommige admin-pages naar snippets verhuisden).

### Waarom Vercel Blob ipv echte database?
Use case is overgrote meerderheid **read-heavy config + audit-logs**,
geen transacties of complex queries. Blob = goedkoop, snel, geen
schema-migraties. Real-time data komt uit SRS/Shopify zelf.

Wanneer je TOCH een database wilt: relationale queries (joins) of
zoeken-met-filter over honderdduizenden rijen. Tot nu toe niet nodig.

### Waarom monoliteke `gents-portal-v6.js` (~30k regels)?
Historisch organisch gegroeid. Voordeel: alles in 1 file vinden via
grep, geen build-step. Nadeel: scrollbalken pijn. Splitsen naar
modules is op de roadmap (sprint "refactor naar modules").

### Waarom permission-driven UI ipv pagina's-per-rol?
Ondersteunt **fine-grained** overrides per gebruiker (bv. "Lisa mag
declaraties zien maar geen mail-log"). Alternatief was 4-5 vaste
rollen — te grof voor 19 winkels + HQ-functies.

### Waarom alles in modals ipv pages?
Snelheid van bouwen. Een modal = HTML in 1 snippet + 1 loader in JS.
Een echte page-route zou Shopify-template-wisseling vereisen.
Trade-off: deep-linking lastiger (lossen we op met `?modal=xxx` query).

### Waarom SOAP voor SRS?
SRS-vendor levert alleen SOAP. We hadden het niet zelf gekozen. Wel
gemaskeerd achter `srs-*-client.js` libs met sane interfaces zodat
callers geen XML zien.

### Waarom geen tests?
Eerlijk: tijd-trade-off. De portal heeft ~80 modals + 100+ endpoints,
elk schrijven van een test zou triple-development tijd kosten. Wel
hebben we **smoke-checklists** in `docs/admin-smoke-checklist.md` voor
manueel testen na deploy. Als regressies vaker voorkomen → eerst test-
infrastructure opzetten.

---

## Aanverwante docs

- [`CONFIGURATION.md`](CONFIGURATION.md) — Welke knoppen kun je draaien
- [`GLOSSARY.md`](GLOSSARY.md) — Domein-jargon uitgelegd
- `RUNBOOKS.md` — Incident playbooks (TODO)
- `ONBOARDING.md` — Eerste week dev guide (TODO)
