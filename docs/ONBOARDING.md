# GENTS Portal — Onboarding voor nieuwe ontwikkelaars

> Welkom! Dit document neemt je aan de hand mee door je **eerste week**
> op het GENTS Portal-project. Aan het einde van de week kun je
> zelfstandig een feature bouwen en deployen.

## TL;DR — Begin hier

Lees op deze volgorde, ~2 uur totaal:
1. [`GLOSSARY.md`](GLOSSARY.md) — om het jargon te leren
2. [`ARCHITECTURE.md`](ARCHITECTURE.md) — om systeem te begrijpen
3. [`CONFIGURATION.md`](CONFIGURATION.md) — om te weten wat configureerbaar is
4. [`RUNBOOKS.md`](RUNBOOKS.md) — voor wanneer iets stuk gaat

Dan terug naar dit doc voor de week-planning.

---

## 📅 Week-overzicht

| Dag | Focus | Output |
|---|---|---|
| **Dag 1** | Setup + leesweek | Lokaal kunnen testen + 4 docs gelezen |
| **Dag 2** | Walkthrough als gebruiker | Begrijpt 3 belangrijkste flows |
| **Dag 3** | Eerste PR — kleine wijziging | Eigen commit + deploy in productie |
| **Dag 4** | Backend deep-dive | Snapt 1 endpoint volledig |
| **Dag 5** | Eerste feature | Eigen modal/endpoint live |

---

## Dag 1 — Setup

### 1.1 Toegang regelen
- [ ] GitHub-toegang tot `kevingents/storegents` (backend, Vercel API)
- [ ] GitHub-toegang tot `kevingents/shopifystore` (frontend, Shopify-theme)
- [ ] Vercel team-toegang (storegents project)
- [ ] Shopify partner-account toegang (theme-deploy)
- [ ] Admin-login portal — vraag bestaande admin om je office-user account aan te maken
- [ ] Resend dashboard-toegang (voor mail-troubleshooting)

### 1.2 Lokale setup

```bash
# Repos clonen
git clone https://github.com/kevingents/storegents.git
git clone https://github.com/kevingents/shopifystore.git

# Backend lokaal
cd storegents
npm install
# Plus Vercel CLI:
npm i -g vercel
vercel link   # selecteer storegents project

# Env-vars trekken:
vercel env pull .env.local

# Dev-server:
vercel dev    # draait op localhost:3000

# Frontend lokaal
cd ../shopifystore
npm i -g @shopify/cli @shopify/theme
shopify auth login --store=gents-production.myshopify.com
shopify theme dev   # opent localhost-preview
```

⚠️ **Waarschuwing**: lokaal de portal helemaal end-to-end testen is
lastig omdat Shopify-theme remote draait. Veel devs werken via
**preview-deployments** (push naar branch → Vercel maakt preview-URL
→ test daar).

### 1.3 Lees-rooster

Doe op deze volgorde, ~2 uur totaal:

1. [`GLOSSARY.md`](GLOSSARY.md) — 30 min. Markeer termen waar je
   "nooit van gehoord" zegt en kom er later op terug.
2. [`ARCHITECTURE.md`](ARCHITECTURE.md) — 30 min. Print het systeem-diagram
   uit en pin het op je monitor.
3. [`CONFIGURATION.md`](CONFIGURATION.md) — 30 min.
4. [`RUNBOOKS.md`](RUNBOOKS.md) — 30 min, snel scannen.

---

## Dag 2 — Walkthrough als gebruiker

Log in als **office-user** in productie (https://gents-production.myshopify.com/portal)
en doorloop minstens deze 3 flows:

### 2.1 Klant-flow
- Open **Voorraad opzoeken** modal — zoek "pak blauw"
- Open **Klantinschrijving** modal — vul fake klant in (en cancel)
- Open **Reservering maken** modal — bekijk de flow (niet submitten)

### 2.2 Order-flow
- Open **Pickup** modal — bekijk wat HQ ziet
- Open **Open weborders** modal
- Open **Retour & terugbetaling** — bekijk refund-knop

### 2.3 Admin-flow
- Open **Admin → Communicatie → Mail log** — zie hoe events eruit zien
- Open **Admin → Beheer → Cron-beheer** — zie alle geplande taken
- Open **Admin → Voorraad-correcties** — bekijk pending aanvragen

**Doelen**:
- Wie is het primaire publiek (winkel-medewerker vs. office-user)?
- Welke modals worden DAGELIJKS gebruikt vs. zeldzaam?
- Welke flow heeft de meeste stappen?

Schrijf 5 vragen op die overblijven. Vraag ze aan een collega.

---

## Dag 3 — Eerste PR

Doel: 1 kleine wijziging committen + deploy preview testen.

### 3.1 Kies een eenvoudige issue
Goede starters:
- Een tekst-typo in een modal
- Een ontbrekend `data-perm` attribuut
- Een betere `placeholder` of `label`
- Een ontbrekende key in `GLOSSARY.md` die je tijdens dag 1 tegenkwam

### 3.2 Workflow

```bash
# Branch aanmaken
cd shopifystore   # of storegents
git checkout -b fix/jouw-naam-typo

# Wijziging maken in de juiste file
# Bewerk via VS Code, niet Notepad — vanwege regelnummers + grep

# Test lokaal via syntax-check
node --check assets/gents-portal-v6.js   # frontend
# of
node --check api/admin/foobar.js          # backend

# Commit met goede message (kijk recente commits voor de stijl)
git add ...
git commit -m "fix: ..."
git push origin fix/jouw-naam-typo

# Open PR via GitHub web
```

### 3.3 Commit-message-stijl

Bekijk recente commits voor het patroon, maar TL;DR:

```
type: korte oneliner

Optionele toelichting in 2-5 zinnen wat WAAROM dit nodig is.
Beschrijf de business-context, niet wat de diff doet.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

`type`: `fix:` / `feat:` / `design:` / `docs:` / `refactor:` / `chore:`

### 3.4 Deploy preview testen
- Na push krijgt Vercel automatisch een preview-URL
- Klik 'm in de PR-comment
- Test je wijziging — als alles goed: merge naar main

---

## Dag 4 — Backend deep-dive

Doel: 1 endpoint volledig begrijpen.

### 4.1 Kies een endpoint
Tip: kies iets dat je tijdens dag 2 hebt zien gebruiken. Bv.:
- `api/admin/today-stats.js` — dashboard-data
- `api/store/article-search.js` — voorraad-zoek
- `api/wk-poule/submit.js` — WK poule invul

### 4.2 Lees het volledig

Stappen:
1. Wat doet het endpoint (top-comment)?
2. Welke libs importeert het? Open elk en kijk wat ze doen.
3. Welke auth-laag? CORS, admin-token, cron-secret?
4. Wat retourneert het? Test via curl:
   ```bash
   curl https://storegents.vercel.app/api/.../...
   ```
5. Welke andere endpoints/crons schrijven naar dezelfde Blob-pad?

### 4.3 Diep: SOAP-call analyseren

Open `lib/srs-customers-client.js` of een andere SRS-client.
- Hoe wordt de XML-envelope opgebouwd?
- Welke namespaces?
- Hoe wordt response geparset?
- Wat gebeurt bij error?

Begrijp het patroon — alle SRS-clients zijn hetzelfde.

### 4.4 Patroon: Blob-store

Open `lib/json-blob-store.js` — slechts ~30 regels. Snap hoe
`readJsonBlob` / `writeJsonBlob` werken.

Open een `*-store.js` lib (bv. `report-schedules-store.js`) — zie
hoe CRUD-functies dit gebruiken.

---

## Dag 5 — Eerste feature

Doel: eigen modal of endpoint live.

### 5.1 Kies iets klein maar zinnigs

Goede starters:
- Een nieuwe admin-modal (bv. "Database-stats overzicht")
- Een nieuwe rapportage (gebruik bestaande report-export-framework)
- Refactor 1 hardcoded waarde naar `business-config.js`

### 5.2 Checklist nieuwe feature

- [ ] Modal-HTML in `snippets/gents-portal-v6-modals.liquid` (gebruik
      bestaande v6-mt-* helpers voor consistentie)
- [ ] Loader-functie in `gents-portal-v6.js` (kopieer patroon van
      bestaande loader, bv. `loadAdminMailLogModal`)
- [ ] Registreer in `MODAL_LOADERS` dispatch-object (2 plekken!)
- [ ] Nav-link in `sections/gents-portal-v6.liquid` met juiste `data-perm`
- [ ] Permission-key in `storegents/lib/user-roles.js` PERMISSIONS array
- [ ] Backend endpoint in `api/admin/...` of `api/store/...`
- [ ] Documentatie in `docs/CONFIGURATION.md` als er knoppen bij komen
- [ ] Commit + push + test preview-deploy
- [ ] Merge naar main + verifieer in productie

---

## 🚨 Waar NIET zomaar aan komen

### Production-data zonder dubbele check
- SRS write-actions (cancel-order, create-customer): elke call is
  echt en onomkeerbaar. Begin altijd in dry-run mode.
- Mail-cron's: bij UIT-zetten en weer aan kunnen klanten dubbele mails
  krijgen. Pause via Cron-beheer ipv code-edit.

### `gents-portal-v6.js` aanraken op willekeurige plek
- Bestand is 30k+ regels. Wijziging op verkeerde plek = scope-issues.
- Gebruik `Grep` om context te zoeken voordat je edit.
- Test ALTIJD met `node --check` voor commit.

### Migration-scripts
- Folder `lib/*-migrate.js` bevat eenmalige scripts. Run die NOOIT
  in productie zonder volledige backup van Blob-state.

### Shopify-theme breaking changes
- 256KB-limiet op Liquid section-files. Bij overschrijden: niet kunnen
  uploaden. Bij grote toevoeging → in `snippet` plaatsen.

### Env-vars
- NOOIT in code committen. Pas alleen aan via Vercel-dashboard.
- Zet eerst in **preview**-environment, test, dan **production**.

---

## 🎯 Patronen om te leren

### Idempotente cron-jobs
Cron mag opnieuw draaien zonder schade. Gebruik watermarks (bv.
`mail-events-store` checkt of mail al verstuurd is voordat 2× sturen).

### Modal lifecycle
1. User klikt nav-link → `openModal('xxx')` in v6.js
2. Modal DOM al present (in modals-snippet)
3. `MODAL_LOADERS['xxx']()` wordt aangeroepen
4. Loader doet fetch → renders DOM
5. User sluit modal → state blijft, geen unmount

### Permission-driven UI
```html
<button data-perm="page.admin-cron-config" ...>...</button>
```
JS verbergt automatisch elementen waar user de perm niet heeft.
**Backend MOET zelf opnieuw check** — frontend permission is alleen UI.

### Hidden legacy `<select>` voor pill-filters
Soms heb je pill-filters in nieuwe UI, maar bestaande JS-handlers
verwachten een legacy `<select>`. Houden we beide en sync'en met
JS. Zie mail-log modal voor voorbeeld.

### Fallback-cascade voor zoek
```js
// Stap 1: snelle Shopify-search
let results = await fetchLive(q);
// Stap 2: cache met SRS-metafields (vangt 'POS-code' op)
if (!results.length && isSpecificCode) results = await fetchCache(q);
// Stap 3: SRS-snapshot direct (vangt SRS-only artikelen op)
if (!results.length && isNumeric) results = await fetchSnapshot(q);
```

Zie `searchArticleWithFallback` in v6.js voor het volledige patroon.

---

## ❓ Veelgestelde vragen

### Hoe deploy ik backend?
Push naar `main` → Vercel deployt automatisch. Voor preview: push naar
een branch + maak PR.

### Hoe deploy ik frontend (Shopify-theme)?
Via Shopify CLI: `shopify theme push --store=gents-production` (let op
welke theme actief is). Of via GitHub-actions als die zijn opgezet.

### Hoe test ik in productie zonder klanten te beïnvloeden?
- **Frontend**: dev-store of preview-theme + Cypress/handmatig
- **Backend**: dry-run flags in endpoints (bv. `?dry_run=1`),
  Resend `dryRun: true`
- **Cron**: handmatig triggeren via "Nu draaien" knop in Cron-beheer

### Wat als ik een wijziging maak waar niemand om gevraagd heeft?
Doe het via een **feature-flag** (zie `admin-feature-flags` modal).
Default UIT — alleen voor admin AAN — dan beslis je over rollout.

### Hoe debug ik production?
- Vercel Functions tab: real-time logs
- Browser console: alle JS-errors
- Audit-logs in Vercel Blob
- Mail-log in admin-modal

---

## 🛟 Hulp halen

- **Eerst** zoek in deze docs (GLOSSARY + RUNBOOKS dekken 80%)
- **Daarna** grep door codebase
- **Daarna** vraag in dev-Slack/Teams
- **Laatste redmiddel** open GitHub Issue

---

## Aanverwante docs

- [`CONFIGURATION.md`](CONFIGURATION.md)
- [`GLOSSARY.md`](GLOSSARY.md)
- [`ARCHITECTURE.md`](ARCHITECTURE.md)
- [`RUNBOOKS.md`](RUNBOOKS.md)
