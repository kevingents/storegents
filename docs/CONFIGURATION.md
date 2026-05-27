# GENTS Portal — Configuratie-handboek

> Voor wie dit leest: dit is de plek waar je vindt **welke knoppen je
> kunt draaien zonder developer**. Drie lagen:
>
> 1. **Vercel env-vars** — secrets en omgevings-specifieke waardes
> 2. **`lib/business-config.js`** — defaults voor bedrijfsregels
> 3. **Admin-UI (portal)** — runtime instellingen via Vercel Blob

## Inhoudsopgave

- [Mentaal model](#mentaal-model)
- [Vercel env-vars (top-prioriteit)](#vercel-env-vars)
- [business-config.js — bedrijfsregels in code](#business-configjs)
- [Admin-UI — runtime instellingen](#admin-ui)
- [Cron-schedules](#cron-schedules)
- [Veelvoorkomende wijzigingen — recepten](#veelvoorkomende-wijzigingen)

---

## Mentaal model

```
┌─────────────────────────────────────────────────────────────┐
│  Bedrijf wil iets wijzigen                                  │
│                                                             │
│  Is het een secret / API key?       → Vercel env-var        │
│  Is het een NL-omgeving-specifiek?  → Vercel env-var        │
│  Is het een bedrijfsregel?          → business-config.js    │
│  Is het runtime aanpasbaar?         → Admin-UI (Blob)       │
└─────────────────────────────────────────────────────────────┘
```

**Vuistregel**: hoeft business niet zelf aan te kunnen → business-config.js.
Wil je dat manager X via portal zelf wijzigt → admin-UI / blob.

---

## Vercel env-vars

Volledige lijst staat in Vercel-dashboard onder **Settings → Environment
Variables**. De belangrijkste:

### Authenticatie & API-keys

| Variabele | Wat doet het | Hoe ontbreken merken |
|---|---|---|
| `ADMIN_TOKEN` | Token waarmee admin-endpoints zichzelf identificeren | Alle `/api/admin/*` returnen 401 |
| `CRON_SECRET` | Vercel-cron Bearer-token voor cron-endpoints | Cron-jobs falen met "Niet geautoriseerd" |
| `SHOPIFY_STORE_DOMAIN` | Shopify shop-domein (bv. `gents-production.myshopify.com`) | Productcache leeg, omzet-pagina toont 0 |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | Shopify admin API token | Idem als boven |
| `SHOPIFY_API_VERSION` | bv. `2025-01` | Defaults naar laatste; alleen forceren bij breaking change |
| `RESEND_API_KEY` | Mailing-provider key | Alle outbound mail faalt |
| `SRS_USERNAME`, `SRS_PASSWORD` | SRS SOAP login | Alle SRS-data-flows falen (omzet, voorraad) |
| `GOOGLE_PLACES_API_KEY` | Google Places voor reviews | Reviews-modal leeg |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob auto-gezet | Alle blob-stores falen |

### Override-flags voor business-config defaults

| Variabele | Default | Wijzigt |
|---|---|---|
| `WEBORDER_DEADLINE_OPERATIONAL_DAYS` | 2 | Wanneer een weborder "te laat" is |
| `EXCHANGE_DEADLINE_OPERATIONAL_DAYS` | 7 | Uitwisselingen overdue na X dagen |
| `DRAGER_DEADLINE_HOURS` | 48 | Pakket "vermist" na X uur |
| `WEBORDER_DEADLINE_HOURS` | 48 | Fulfilment SLA in uren |
| `RESERVATION_VALID_DAYS` | 7 | Klant moet binnen X dagen ophalen |
| `RESERVATION_CLEANUP_DAYS` | 30 | Verlopen reserveringen tonen voor X dagen |
| `PERSONNEL_SESSION_TTL_SECONDS` | 43200 (12u) | Hoe lang portal-login geldig blijft |
| `INVITE_TTL_MS` | 172800000 (2 dagen) | Invite-link geldigheid |
| `MAIL_MAX_RECIPIENTS` | 10 | Max recipients per geplande rapportage |
| `MAX_UPLOAD_BYTES` | 10485760 (10 MB) | Bijlage upload-limiet |
| `SRS_SOAP_TIMEOUT_MS` | 20000 | Wachttijd SOAP-calls naar SRS |
| `WK_POULE_DEADLINE` | 2026-06-11T16:00:00Z | WK toernooi-start (voor countdown) |

---

## business-config.js

Volledige uitleg per waarde staat als JSDoc in **`lib/business-config.js`**.
Hieronder samenvatting per domein:

### 📅 deadlines
Wanneer is iets "te laat". Beïnvloedt alle overdue-meldingen, KPI's, mail-
triggers. Verandering = direct verschuiving in alle dashboards.

### 🎯 targets
Default-waardes voor omnichannel-score (klant-registraties, loyalty,
vouchers, labels per winkel per periode). Per-winkel override via
Region-report-config admin-modal.

### 🏆 omnichannelScoring
Weegfactoren + penalties voor de trofeekast. **Som van `weights` MOET 1.0
zijn** — anders schalen scores scheef. Penalties zijn aftrekpunten op ~0-100.

### ⚽ wkPouleScoring + wkPouleTournament
Punten per match-uitkomst (10/5/3) en bonus-tolerantie. Plus toernooi-
metadata (deadline-datum).

### ✉️ mail
- `allowedDomainRegex` — security-filter voor rapportage-ontvangers
- `maxRecipientsPerSchedule` — limiet per geplande rapportage
- `defaultScheduleHourUtc` — wanneer nieuwe schedules standaard draaien
- `maxUploadBytes` — max attachment-grootte
- `eventsRetentionDays` — GDPR-overweging voor mail-audit-log

### 🔐 session
Sessie-duur, invite-link-TTL, 2FA-code-TTL. Balans tussen UX en security.

### ⚡ cache
Per-endpoint cache-duur in ms. Centrale tabel maakt rate-limit-tuning
triviaal.

### ⏱️ timeouts
API/SOAP timeouts per externe service. Te laag = false-positive errors,
te hoog = users wachten onnodig.

### 📦 shopifyPaging
Aantal items per Shopify GraphQL-query. Verhogen = minder calls maar
hogere cost (Shopify-limiet 1000 punten/request).

### 🏪 branches
**Single source of truth** voor de winkellijst + branchIds. Vóór deze
refactor stond dezelfde lijst gedupliceerd in 3 bestanden — UI toonde
soms winkels die niet in backend bestonden.

**Nieuwe winkel toevoegen**:
1. Voeg toe aan `BUSINESS_CONFIG.branches.list`
2. Deploy storegents
3. Frontend pakt 'm automatisch via `/api/branches`
4. Check dat SRS-snapshot-cron de nieuwe branchId picked up

---

## Admin-UI

Sommige settings wijzigen via de portal (Beheer-sectie):

| Modal | Wat instelt |
|---|---|
| **Cron-beheer** (`admin-cron-config`) | Per cron: aan/uit, min-interval, "Nu draaien" |
| **Feature flags** (`admin-feature-flags`) | Module-flags zonder deploy |
| **Winkel-emails** (`admin-store-emails`) | Per winkel notificatie-mailadres |
| **DHL hubs** (`admin-dhl-hubs`) | DHL depot per winkel |
| **Voorraad-correctie redenen** (`admin-stock-corrections`) | Reden-codes + labels |
| **WK Poule prijzen / uitslagen / bonus-antwoorden** | Per-edition data |
| **Rapportages schedulen** (`admin-report-schedules`) | Geplande mails |
| **Klanten-targets** | Per winkel per maand targets |
| **Region-report-config** | Regio-grenzen + thresholds |
| **Role-permissions** | Per-rol grant/revoke van permissies |

---

## Cron-schedules

Configuratie staat in **`vercel.json`** maar gedrag is tunable via
**Cron-beheer modal** (uit-zetten of vertragen zonder deploy).

Belangrijkste:

| Path | Schedule | Wat doet het |
|---|---|---|
| `/api/cron/birthday-notifications` | `0 7 * * *` | Dagelijks 07:00 UTC verjaardags-mails |
| `/api/cron/pickup-mail-run` | `0 8 * * 1-6` | Ma-Za 08:00 UTC pickup-herinneringen |
| `/api/cron/customer-mail-run` | `0 8 * * *` | Dagelijks 08:00 klanten-mails |
| `/api/cron/daily-loyalty-vouchers` | `0 6 * * *` | Dagelijks 06:00 loyalty-vouchers |
| `/api/cron/srs-revenue-cache` | `30 */2 * * *` | Elke 2 uur omzet-cache vullen |
| `/api/cron/shopify-products-refresh` | `0 3 * * *` | Dagelijks 03:00 productcache herbouwen |
| `/api/cron/run-report-schedules` | `0,15,30,45 * * * *` | Elke 15 min geplande rapportages |
| `/api/cron/google-reviews-snapshot` | `0 4 * * *` | Dagelijks 04:00 review-stats |
| `/api/cron/srs-cancellations-nightly` | `15 * * * *` | Elk uur op :15 SRS cancellations |
| `/api/cron/srs-unavailable-hourly` | `20 * * * *` | Elk uur op :20 niet-leverbaar check |

**Tijd-tip**: UTC = NL-tijd −1 (winter) of −2 (zomer). 07:00 UTC ≈ 09:00 NL.

---

## Veelvoorkomende wijzigingen

### "We willen overdue-deadline van 48 naar 72 uur"

Was vroeger: code-edit op 11 plekken + deploy + alles testen.

Nu:
- **Quick**: zet env-var `DRAGER_DEADLINE_HOURS=72` in Vercel → herstart
- **Permanent**: wijzig `BUSINESS_CONFIG.deadlines.dragerHours` default in
  `lib/business-config.js` → commit + deploy

### "Nieuwe winkel openen: GENTS Apeldoorn"

1. Bedrijf zorgt dat SRS een nieuwe branchId krijgt (bv. `22`)
2. Voeg in `BUSINESS_CONFIG.branches.list`:
   ```js
   { store: 'GENTS Apeldoorn', branchId: '22', kind: 'retail' }
   ```
3. Commit + deploy → automatisch zichtbaar in alle modals/dashboards.

### "We willen ook @gentsherenmode.nl als ontvanger toelaten"

In `lib/business-config.js`:
```js
allowedDomainRegex: /^[a-z0-9._%+-]+@(gents|gentsherenmode)\.nl$/i,
allowedDomainLabel: '@gents.nl of @gentsherenmode.nl',
```

### "Rapportage-mailen mag voortaan naar max 25 ontvangers"

- **Tijdelijk**: env-var `MAIL_MAX_RECIPIENTS=25` in Vercel
- **Permanent**: `maxRecipientsPerSchedule: 25` in business-config.js

### "WK Poule punten-schaal wijzigen: knock-outs dubbel"

In `BUSINESS_CONFIG.wkPouleScoring`:
```js
pointsExact: 10,
pointsToto: 5,
pointsSaldo: 3,
// + nieuw veld:
knockoutMultiplier: 2
```
En in `lib/wk-poule-scoring.js` de `scoreMatchPrediction` aanpassen om
deze multiplier toe te passen voor `match.round === 'knockout'`.

### "Voorraad-cache loopt te vaak achter"

In `BUSINESS_CONFIG.cache.srsStockSnapshotMs`: verlaag van `30 * 60_000`
(30 min) naar bv. `10 * 60_000` (10 min). Trade-off: meer SRS-calls
maar verser data.

### "Pickup-mail-cron mag dagelijks ipv ma-za"

Wijzig in `vercel.json`:
```json
{ "path": "/api/cron/pickup-mail-run", "schedule": "0 8 * * *" }
```
Of via Cron-beheer modal: zet schedule uit/aan zonder deploy.

---

## KPI-systeem — `lib/kpi-registry.js`

Sinds mei 2026 is er één centrale KPI-registry die alle eerder versnipperde
KPI-configs vervangt (klanten-targets, omnichannel-weights, impact-score
weights, supplychain-metrics). Eén plek, één UI, één schema.

### Hybrid model — wat is code, wat is config

| Onderdeel | Waar | Wie wijzigt |
|---|---|---|
| KPI-definitie (key, label, unit, scope, direction) | `lib/kpi-registry.js` → `DEFAULT_KPIS` | Developer |
| Berekenings-logica (fetcher per KPI) | `lib/kpi-sources/<key>.js` | Developer |
| Aan/uit per KPI | Admin-UI → "KPI-beheer" | Admin |
| Drempel-waardes (warn/danger) | Admin-UI → "Registry" tab | Admin |
| Targets per maand+winkel | Admin-UI → "Targets" tab | Admin |
| Rapport-binding | Admin-UI → "Registry" tab (inReports) | Admin |

### Een nieuwe KPI toevoegen (recept)

1. **Definieer in code** — voeg entry toe aan `DEFAULT_KPIS` in `lib/kpi-registry.js`:
   ```js
   {
     key: 'mijn_nieuwe_kpi',
     label: 'Mijn nieuwe KPI',
     description: 'Korte uitleg voor admin-UI tooltip',
     category: 'service',          // financieel|volume|customer|service|kwaliteit|composite
     unit: 'pct',                  // eur|count|pct|days|minutes|score
     direction: 'higher-better',   // of 'lower-better'
     scope: 'per-store',           // 'per-store' of 'global'
     period: 'week',               // natuurlijke periode
     icon: 'check-circle',         // svgIcon-key
     source: { type: 'function', fetcher: 'mijn-nieuwe-kpi' },
     thresholds: { warn: 90, danger: 80 },
     hasTarget: true,              // toont in Targets-tab
     inReports: ['region-weekly'], // welke rapportages standaard tonen
     enabledByDefault: true,
     tags: ['winkel']
   }
   ```

2. **Schrijf de fetcher** — maak `lib/kpi-sources/mijn-nieuwe-kpi.js`:
   ```js
   export default async function compute({ store, fromDate, toDate }) {
     // Hier fetch je uit SRS, Shopify, Blob, etc.
     const value = await /* jouw logica */ ;
     return {
       value,                       // number, of null bij geen data
       meta: { computedAt: new Date().toISOString() }
     };
   }
   ```

3. **Registreer in source-loader** — voeg toe aan `SOURCE_MAP` in
   `lib/kpi-sources/index.js`:
   ```js
   'mijn-nieuwe-kpi': () => import('./mijn-nieuwe-kpi.js'),
   ```

4. **Deploy.** Admin-UI pikt de nieuwe KPI automatisch op — geen UI-wijzigingen nodig.

### KPI-bron in code, rest in config

Waarom is de fetcher code? Een non-dev kan geen formules schrijven die
veilig + performant tegen SRS/Shopify praten. Dit voorkomt:
- SQL-injecties via UI-input
- N+1 query problemen
- Cache-omzeiling
- Verkeerde periode-aggregatie

Maar **alles eromheen** (welke winkels, welke targets, welke drempels,
in welke rapporten) kan veranderen zonder deploy.

### Storage

Eén blob bevat zowel registry-overrides als targets:

```
admin/kpi-config.json
{
  "overrides": {
    "sales_revenue": {
      "enabled": true,
      "thresholds": { "warn": 40000, "danger": 30000 },
      "label": "Omzet (eur)",
      "inReports": ["region-weekly", "omnichannel"]
    }
  },
  "targets": {
    "2026-05": {
      "GENTS Arnhem": { "sales_revenue": 50000, "customers_new": 80 },
      "GENTS Almere": { "sales_revenue": 65000 },
      "_default":     { "sales_revenue": 30000, "customers_new": 50 }
    }
  },
  "updatedAt": "2026-05-27T10:00:00Z",
  "updatedBy": "admin@gents.nl"
}
```

`_default` = fallback voor winkels zonder eigen target.

### API endpoints

| Endpoint | Wat | Methods |
|---|---|---|
| `/api/admin/kpis/registry` | KPI-definities + admin-overrides | GET, PATCH, DELETE |
| `/api/admin/kpis/targets` | Targets per maand+winkel | GET, POST, DELETE |
| `/api/admin/kpis/values` | Actuele waardes (matrix kpi×winkel) | GET |

Alle endpoints vereisen `Authorization: Bearer <ADMIN_TOKEN>`.

### Migratie van oude KPI-configs

Bestaande configs worden geleidelijk gemigreerd zonder breaking changes:

- **Klanten-targets** (`admin/customer-targets.json`) — wordt sprint 2 onder
  het KPI-systeem gehangen. Tot dan blijft `/api/admin/customer-targets` werken.
- **Omnichannel weights** (`lib/business-config.js`) — wordt sprint 2 als
  composite-KPI binnengehaald.
- **Supplychain-metrics-config** — kan blijven; is conceptueel hetzelfde
  pattern (registry + blob-overrides) maar voor 1 specifiek dashboard.

### Veelvoorkomende KPI-recepten

**Target voor 1 winkel voor mei 2026 instellen:**
1. Open admin-UI → "KPI-beheer" → "Targets" tab
2. Kies maand mei 2026
3. Vul cell in voor die winkel × KPI
4. Toets "Bewaar rij"

**Drempel-waardes aanpassen (warn/danger):**
1. Open admin-UI → "KPI-beheer" → "Registry" tab
2. Vul warn/danger in voor de KPI
3. Toets "Opslaan"

Effect is direct — alle rapporten + dashboards lezen de nieuwe drempels
binnen 60 seconden (server-cache).

**KPI uitschakelen (verschijnt niet meer in rapporten):**
1. Registry-tab → toggle "Actief" uit
2. Opslaan

De KPI blijft in code bestaan maar wordt niet meer berekend of getoond.

---

## Wat NIET hierin hoort

- **Algoritmes & schema-versies** — die zijn implementatie, niet config.
- **Per-user-overrides** — die in user-permissions of user-profile.
- **Secrets** — die exclusief in Vercel env-vars (nooit in code).
- **Vertrouwelijke business-data** — die in Vercel Blob via admin-modals.

---

## Aanverwante docs

- `ARCHITECTURE.md` — high-level systeem-diagram (TODO sprint 2)
- `GLOSSARY.md` — domein-jargon uitgelegd (TODO sprint 2)
- `RUNBOOKS.md` — wat te doen als X faalt (TODO sprint 2)
- `ONBOARDING.md` — stap-voor-stap eerste week (TODO sprint 2)
