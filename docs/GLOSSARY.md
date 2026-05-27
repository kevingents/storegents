# GENTS Portal — Woordenlijst

> Voor wie dit leest: opvolger of nieuwe developer die het GENTS-jargon
> tegenkomt in code, modal-namen, of UI-teksten. Termen zijn alfabetisch
> per thema gegroepeerd.
>
> Vuistregel: kom je een term tegen die je niet snapt, voeg 'm hier toe.

## Inhoudsopgave

- [🏢 Bedrijfs-termen (GENTS-specifiek)](#bedrijfs-termen)
- [🏪 Winkels & rollen](#winkels--rollen)
- [📦 Order-types & flows](#order-types--flows)
- [👤 Klant & medewerker](#klant--medewerker)
- [🔌 Systemen & integraties](#systemen--integraties)
- [💻 Technische termen](#technische-termen)
- [📋 Status-codes & enums](#status-codes--enums)
- [📝 Afkortingen](#afkortingen)

---

## 🏢 Bedrijfs-termen

| Term | Betekenis |
|---|---|
| **GENTS Herenmode** | Het bedrijf — Nederlandse herenmode-keten met ~19 winkels. |
| **GENTS Administratie** | Het hoofdkantoor (HQ). Virtuele "winkel" in de portal met admin-context — heeft per definitie toegang tot alle data. |
| **GENTS Magazijn** | Centraal voorraad-hub (branchId `99`, soms ook `97`). Geen retail. Wordt door alle winkels gebruikt voor stock-transfers. |
| **GENTS Showroom** | Speciale winkel (branchId `700`) waar klanten artikelen kunnen passen die normaal niet in winkel liggen. Geen verkoop, alleen presentatie. |
| **GENTS Brandstores** | Holdingsnaam / hoogste niveau in de structuur. Niet een fysieke winkel. |
| **Vereniging deal** | Korting/aanbieding voor leden van studentenverenigingen. Vereist juiste kassa-instructies om geldig te zijn. Beheerd via Suitconcer + vereniging-store. |
| **Suitconcer** | Apart concept binnen GENTS voor (vereniging-) maatkleding. Eigen voorraad-flow + admin-modals (sc-voorraad, sc-artikelen, sc-uniek-aanbod, sc-orders). |
| **Supplychain** | Inkoop/distributie-afdeling. Heeft eigen dashboard met leverancier-KPI's, voorraad-correcties, niet-leverbaar-analyses. |
| **Trofeekast** | Omnichannel-winnaar dashboard. Maandelijks winnen winkels op basis van scoring-formule (zie business-config.js omnichannelScoring). |
| **WK Poule** | Voetbal-voorspellingen-spel voor medewerkers, georganiseerd rond elk WK (huidige editie: 2026). Eigen tab in portal met inschrijven, leaderboard, prijzen. |

---

## 🏪 Winkels & rollen

| Term | Betekenis |
|---|---|
| **Winkel / Filiaal** | Een fysieke GENTS-vestiging. Lijst staat in `BUSINESS_CONFIG.branches`. |
| **Branch / branchId** | SRS-numerieke ID per winkel (bv. Amsterdam = `5`, Magazijn = `99`). Bron-of-truth voor alle SRS-koppelingen. |
| **Store-name** | Mens-leesbare naam (bv. "GENTS Amsterdam"). Wat in UI getoond wordt. |
| **Retail-store** | Fysieke verkoopwinkel waar klanten kopen. `kind: 'retail'` in config. |
| **Warehouse / Magazijn** | Centraal hub. Eigen branchId. Telt mee voor totaal-voorraad maar niet voor verkoop-KPI's. |
| **Showroom** | Branch zonder verkoop, alleen pasruimte. Telt mee als voorraad-locatie. |
| **Region / regio** | Geografische groepering van winkels (Noord/Zuid/Midden), gebruikt voor regio-managers + region-report. |
| **RES-filiaal** | Virtuele branch waar gereserveerde voorraad geboekt staat tot ophalen. Per fysieke winkel heeft SRS een eigen RES-filiaal. |
| **Region manager** | Office-user met permissie over meerdere winkels in zijn/haar regio. |

---

## 📦 Order-types & flows

| Term | Betekenis |
|---|---|
| **Weborder** | Order via webshop (Shopify). Wordt door SRS afgehandeld voor fulfilment + voorraad. |
| **POS-bon / Kassa-bon** | Aankoop direct aan de kassa (in winkel). Heeft `receiptNr` en GEEN `orderNr` in SRS. |
| **Pickup** | Weborder die de klant in winkel komt afhalen. Heeft zowel `receiptNr` als `orderNr` in SRS — telt voor webshop-omzet, niet winkel-omzet. |
| **Drager** | Verzendpakket (typisch DHL). 1 drager kan 1+ weborders bevatten. Heeft eigen deadline (48u standaard). |
| **Uitwisseling** | Transfer van artikelen tussen 2 winkels (bv. Amsterdam stuurt Maastricht een specifieke maat). Standaard 5-7 werkdagen deadline. |
| **Reservering** | Klant houdt artikel apart voor X dagen (default 7). Voorraad gaat tijdelijk naar het RES-filiaal van die winkel. |
| **Niet-leverbaar** | Order-regel die SRS niet kan vervullen (voorraad-fout, beschadigd, etc.). Workflow: Shopify-refund → SRS-cancel → eventueel misbruik-check. |
| **Refund** | Terugbetaling via Shopify. Klant krijgt geld terug, voorraad blijft "weg". |
| **Cancel** | Annulering vóór fulfilment. Heeft eigen flow in SRS. |
| **Voorraad-correctie** | Aanvraag van winkel om SRS-voorraad aan te passen (telling klopt niet). Workflow: aanvraag → HQ-goedkeuring → SRS-update. |
| **Voucher** | Cadeaubon. Loyalty-programma geeft ze automatisch uit; ook handmatig aan kassa. |
| **Loyalty** | Punten-systeem voor herhaal-klanten. Punten leiden tot vouchers. |
| **Klantinschrijving** | Registratie van een klantprofiel in SRS (naam, e-mail, geboortedatum). Vereist voor vouchers + verjaardags-mails. |

---

## 👤 Klant & medewerker

| Term | Betekenis |
|---|---|
| **Klant / Customer** | Eindklant die kleding koopt. Identifier: SRS `customerId` (numeriek) of e-mail. |
| **Personnel / Medewerker** | Winkel-medewerker. Logt in met personnelNumber + pincode. Sessie via personnel-session-store. |
| **Office user** | Hoofdkantoor-medewerker. Logt in met email + 2FA. Heeft permissions over meerdere winkels + admin-modals. |
| **Personnel session** | Login-sessie van een winkelmedewerker. Standaard 12 uur geldig. |
| **2FA** | Two-factor auth voor office-users. 5-min-geldige code via mail. |
| **Invite** | E-mail-link waarmee een nieuwe office-user zijn account activeert. 2 dagen geldig. |
| **Allowed stores** | Per-user lijst van winkels waarin hij/zij mag werken. Override op standaard rol-permissies. |
| **Permissions / Rechten** | Granulaire access-controls (bv. `page.admin-mail-log`, `action.refund-order`). Per-rol defaults + per-user overrides. |
| **Role** | Rol-categorie (admin, manager, medewerker). Bepaalt default permissies. Override via role-permissions-store. |
| **Department / Afdeling** | (Legacy) Was eerst rol-gebaseerd, nu vervangen door permissions. Afdelingen-pagina wordt gedeprecaat. |

---

## 🔌 Systemen & integraties

| Term | Betekenis |
|---|---|
| **SRS** | Het ERP-systeem (Store Retail Suite). Bron-of-truth voor: voorraad, klanten, weborders, kassa-bonnen. Praat via SOAP (langzaam, ~20s timeout). |
| **Shopify** | Webshop-platform. Bron voor: weborder-aanmaak, product-catalogus, refunds. GraphQL Admin API. |
| **Shopify metafields** | Custom velden op producten/varianten (bv. `artikel_id`, `rve_artikelnummer`). De link tussen Shopify en SRS loopt via metafields. |
| **SRSERP namespace** | Metafield-namespace voor SRS-koppeling. Sinds recent leest cache ook andere namespaces voor breder matching. |
| **Vercel Blob** | Persistent JSON-storage. Alle config-overrides, audit-logs, en caches staan hier. Pad-conventie: `config/*.json` voor admin-instellingen, `srs/*.json` voor cache-snapshots, `audit/*.json` voor logs. |
| **Resend** | Mail-provider. Alle outbound mail (pickup-herinnering, rapportages, support-tickets) loopt hierdoor. |
| **Sendcloud** | Verzendlabel-provider (DHL, Bpost, etc.). Genereert tracking-codes + labels. |
| **Google Places** | Reviews-bron per winkel. Scores + recente reviews. |
| **Google Business Profile** | Uitgebreide reviews-data (incl. reply-mogelijkheid). |
| **DHL hub / depot** | Verzamelpunt waar DHL pakketten ophaalt per winkel. Beheerd via admin-dhl-hubs modal. |
| **Returnista** | Externe retour-provider. Klant scant QR-code, brengt naar pickup-point. |

---

## 💻 Technische termen

| Term | Betekenis |
|---|---|
| **SOAP** | XML-based RPC. SRS gebruikt dit (legacy). Verbose, langzaam, foutgevoelig. |
| **GraphQL** | Moderne query-taal. Shopify gebruikt dit. Snel, type-safe, paging via cursors. |
| **Snapshot** | Periodieke export van SRS-data naar Blob-cache. Bv. branch-stock-snapshot draait elke 30 min. |
| **Cache TTL** | Hoe lang een gecachete waarde "vers" wordt geacht (Time To Live). Centraal in `BUSINESS_CONFIG.cache`. |
| **Cron / Vercel Cron** | Geplande taak op Vercel. Config in `vercel.json`. Standaard frequenties: dagelijks (`0 8 * * *`), 15-min (`0,15,30,45 * * * *`). |
| **Webhook** | Inkomende notificatie van externe systeem (bv. Resend bounce, Shopify order-paid). Wij hebben er weinig — meeste polling. |
| **Tracked cron** | Cron met auto-tracking in `cron-log-store`. Status + duur + error per run zichtbaar in admin. |
| **Rate-limit** | Externe API beperkt aantal calls/sec. Shopify GraphQL: 1000 punten/request, ~50ms recovery. SRS SOAP: 1 call tegelijk. |
| **Idempotency** | Operatie kan zonder schade meerdere keren uitgevoerd. Voor mail-cron belangrijk: niet 2× dezelfde mail. |
| **Modal** | Pop-up venster in de portal (overgrote meerderheid van functies zit in modals, niet pages). Geïdentificeerd via `data-modal="xxx"`. |
| **MODAL_LOADERS** | Mapping in v6.js: modal-naam → loader-functie. Wordt aangeroepen zodra modal opent. |
| **Permission-driven UI** | Element heeft `data-perm="page.xxx"`; verschijnt alleen als gebruiker die permissie heeft. |
| **Bible** | Interne design-guide (premium Shopify Admin / Linear / Notion style). Tokens: navy `#071B3A`, blue `#2563EB`, radius `16px`, spacing `8/16/24`. |

---

## 📋 Status-codes & enums

| Term | Betekenis |
|---|---|
| **Stock-correction status** | `pending` → `approved` / `rejected` → `completed`. |
| **Match status (WK Poule)** | `scheduled` → `live` → `finished`. Triggert scoring zodra finished. |
| **Reservering status** | `open` → `opgehaald` / `verlopen` / `opgeheven`. |
| **Drager status** | `open` / `onderweg` / `geleverd` / `vermist` (na 48u). |
| **Facilitair status** | `open` / `in_behandeling` / `onderweg` / `geleverd` / `afgewezen`. |
| **Declaratie status** | `pending` / `approved` / `rejected` / `paid`. |
| **Schedule status (rapportages)** | `enabled` / `paused`. `lastRunStatus`: `ok` / `error`. |
| **Support-ticket status** | `open` / `in_progress` / `resolved`. |

---

## 📝 Afkortingen

| Afkorting | Betekenis |
|---|---|
| **HQ** | HoofdKwartier (= GENTS Administratie). |
| **POS** | Point of Sale (= kassa-systeem, draait op SRS). |
| **ERP** | Enterprise Resource Planning (= SRS). |
| **SKU** | Stock Keeping Unit (artikel-variant ID). |
| **EAN** | European Article Number (barcode, 13 cijfers). |
| **KPI** | Key Performance Indicator. |
| **SLA** | Service Level Agreement. |
| **TTL** | Time To Live (cache-duur). |
| **GDPR** | EU privacy-wet. Beïnvloedt: mail-events-retentie (90 dagen), klantdata-export rechten, role-permissions audit-log. |
| **UTC** | Coordinated Universal Time. Cron-schedules zijn UTC. NL = UTC+1 (winter) of UTC+2 (zomer). |
| **DHL** | Verzend-provider (NL). |
| **GBF** | Bedrijfsspecifieke productcode-prefix (bv. `GBFKM17-114` = oude SRS-code-stijl). |
| **RVE** | (SRS-veld) `rve_artikelnummer` — extra interne artikel-identifier. Niet altijd gevuld. |

---

## 📚 Code-paden om te onthouden

| Wat | Waar |
|---|---|
| Bedrijfsregels-config | `storegents/lib/business-config.js` |
| Portal-frontend | `shopifystore/sections/gents-portal-v6.liquid` + `assets/gents-portal-v6.js` |
| Modals | `shopifystore/snippets/gents-portal-v6-modals.liquid` |
| SRS SOAP-clients | `storegents/lib/srs-*.js` |
| Shopify GraphQL | `storegents/lib/shopify-*.js` |
| Mail-routing | `storegents/lib/gents-mailer.js` + `gents-mail-config.js` |
| Permissions | `storegents/lib/user-roles.js` (catalog) + `user-permissions-store.js` (per-user) |
| Cron-config | `storegents/vercel.json` + admin-cron-config modal |
| Audit-logs | `storegents/lib/cron-log-store.js`, `permissions-audit-store.js`, `mail-events-store.js` |

---

## Aanverwante docs

- [`CONFIGURATION.md`](CONFIGURATION.md) — Welke knoppen kun je draaien zonder developer
- `ARCHITECTURE.md` — Systeem-diagrammen + data-flows (TODO)
- `RUNBOOKS.md` — Top incidenten + fix-steps (TODO)
- `ONBOARDING.md` — Eerste week voor nieuwe dev (TODO)
