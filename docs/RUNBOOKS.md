# GENTS Portal — Incident Runbooks

> Voor wie dit leest: jij staat op support-duty, hoofdkantoor belt dat
> iets stuk is, en jij moet binnen 15 minuten weten waar te kijken.
> Elk runbook heeft hetzelfde format: **Symptoom → Diagnose → Fix → Prevention**.

## Quick links

1. [📭 Pickup-mail komt niet aan bij klant](#1-pickup-mail-komt-niet-aan)
2. [📊 Omzet-cijfers kloppen niet](#2-omzet-cijfers-kloppen-niet)
3. [🔍 Voorraad-zoek vindt artikel niet](#3-voorraad-zoek-vindt-artikel-niet)
4. [🔐 Medewerker kan niet inloggen](#4-medewerker-kan-niet-inloggen)
5. [⚠️ SRS-down: alle voorraad/klant-data weg](#5-srs-down)
6. [🚦 Shopify rate-limit (THROTTLED)](#6-shopify-rate-limit)
7. [⏰ Cron-job niet gedraaid](#7-cron-job-niet-gedraaid)
8. [📨 Mail naar @gents.nl bounct](#8-mail-bounct)
9. [🚀 Vercel deploy faalt of site down](#9-vercel-deploy-faalt)
10. [📋 Voorraad-correctie blijft "pending"](#10-voorraad-correctie-pending)

---

## 1. Pickup-mail komt niet aan

### Symptoom
Klant belt: "ik heb een mail beloofd gekregen dat mijn order klaar staat
maar ik heb niets ontvangen." OF medewerker meldt "kunnen klanten niet
laten weten."

### Diagnose (in volgorde)

1. **Check Mail log** (admin → Communicatie → Mail log)
   - Zoek op klant-mailadres of order-nummer
   - Status `sent` = ok, `error` = fout in Resend, `dry_run` = cron stond uit
   - Klik op de rij voor error-detail

2. **Check Cron-beheer** (admin → Beheer → Cron-beheer)
   - Zoek `/api/cron/pickup-mail-run`
   - Status AAN? Laatste run < 24u geleden? Geen error?

3. **Check Winkel-emails** (admin → Communicatie → Winkel-emails)
   - Heeft de betreffende winkel een geldig mailadres? Leeg = fallback naar env-var.

### Fix

| Diagnose | Actie |
|---|---|
| Cron stond UIT | Klik AAN + "Nu draaien" |
| Resend status 4xx/5xx | Check `RESEND_API_KEY` in Vercel env-vars, eventueel rotate |
| Bounce in Resend webhook | Klant heeft een fout mailadres opgegeven — handmatig contacteren |
| Winkel-email leeg + fallback `SUPPORT_EMAIL` ook leeg | Vul winkel-email in via admin-modal |
| Order is niet in SRS-open-weborders | Datapush van Shopify naar SRS gefaald — handmatig in SRS aanmaken |

### Prevention
- Resend webhook (`/api/webhooks/resend-events`) logt bounces automatisch
- Bekijk **mail-log error-trend** weekly — als bouncerate stijgt, klanten
  gebruiken oude mailadressen (data quality issue)

---

## 2. Omzet-cijfers kloppen niet

### Symptoom
"De omzet die ik op het dashboard zie matcht niet met SRS."

### Diagnose

1. **Welke pagina toont fout cijfer?**
   - Dashboard (today-stats) vs. Omzet-detail (revenue-srs) → vergelijk
   - Beide horen hetzelfde te tonen voor "vandaag"

2. **Check SRS-data direct**
   - SOAP-call werkt? `/api/admin/system-health` toont SRS-status
   - GetTransactions retourneert data? Test via debug-endpoint

3. **Check filter-logica**
   - Pure POS = `receiptNr` + GEEN `orderNr` → winkel-omzet
   - Pickup = `receiptNr` + `orderNr` → webshop-omzet (telt NIET voor winkel)
   - Cancel/Refund = negatieve `charged` per item → aftrek bruto

### Fix

| Diagnose | Actie |
|---|---|
| SRS retourneert minder bonnen dan winkel verwacht | SRS-cache `srs/revenue-cache.json` mogelijk stale — wacht op volgende cron-run (elke 2u) of trigger handmatig |
| Webshop-getal te hoog | Check of `gents-offline` tag-filter werkt — offline-orders mogen niet 2× tellen |
| Retouren niet zichtbaar | Negatieve `tx.total` regels — `aggregate()` splitst in `grossRevenue` + `refundedRevenue`. Bekijk JSON-response van /api/admin/revenue-srs |
| Verschil dashboard vs. detail-pagina | Beide endpoints aangepast (zie [recente commits]) — verifieer dat ze dezelfde aggregate gebruiken |

### Prevention
- Periodiek reconciliëren met SRS-reports
- Bewaar `excludedWeborderCount` als diagnose-veld in response

---

## 3. Voorraad-zoek vindt artikel niet

### Symptoom
Medewerker zoekt op artikelcode (bv. `00002039`) en krijgt 0 resultaten,
ondanks dat artikel wel op voorraad ligt.

### Diagnose

1. **Wat staat in Shopify?**
   - Open product in Shopify admin
   - Heeft het metafield `artikel_id` of `rve_artikelnummer` gevuld?
   - Of staat de code in een ANDER metafield (custom namespace)?

2. **Wat staat in SRS-snapshot?**
   - Open `srs/branch-stock-snapshot-*.json` in Vercel Blob (admin tool)
   - Bevat het `articleNumber: '00002039'`?

3. **Wat retourneert de search-endpoint?**
   ```
   curl "https://storegents.vercel.app/api/store/article-search?q=00002039&withStock=1"
   ```
   - Score 100/95 = exact match via SRS-metafield
   - Score 70 = endsWith barcode match
   - 0 results = mismatch tussen SRS-snapshot articleNumber en Shopify metafield

### Fix

| Diagnose | Actie |
|---|---|
| Shopify productcache stale (laatste refresh > 24u) | Klik "Cache verversen" in Voorraad-zoek modal (admin-only knop) — wacht 30-60s |
| Shopify metafield ontbreekt | Voeg toe in Shopify admin → product → metafields → `srserp.artikel_id` = `00002039` |
| Code in andere namespace dan SRSERP | Onze cache leest sinds recent ÁLLE namespaces — refresh cache |
| SRS-snapshot mist artikel | Snapshot-cron faalde voor die branch — wacht volgende run of trigger handmatig |

### Prevention
- Periodiek `products-cache.json` size monitoren (hoogte = healthy)
- Snapshot-cron logging in `audit/cron-log.json` checken

---

## 4. Medewerker kan niet inloggen

### Symptoom
"Mijn pincode werkt niet" of "ik blijf op de inlog-pagina."

### Diagnose

1. **Welk type user?**
   - Winkel-medewerker: personnelNumber + pincode
   - Office-user: email + wachtwoord + 2FA-code

2. **Personnel-flow**
   - SRS GetPersonnel retourneert deze medewerker? (admin → Gebruikers → personeel-zoek)
   - Pincode-veld in SRS gevuld?
   - Sessie-timeout: 12 uur — daarna opnieuw inloggen

3. **Office-user-flow**
   - Invite-mail verlopen (2 dagen TTL)?
   - 2FA-code verlopen (5 min TTL)?
   - Account `disabled`?

### Fix

| Diagnose | Actie |
|---|---|
| Personnel niet in SRS | HR moet medewerker activeren in SRS |
| Pincode niet ingesteld | SRS-admin moet pincode setten |
| Office-user invite verlopen | Admin → Gebruikers → "Resend invite" |
| 2FA niet ontvangen | Check mail-log, eventueel admin manueel reset |
| Account disabled | Admin → Gebruikers → re-enable |
| localStorage corrupt | User logt uit + cookies clearen + opnieuw inloggen |

### Prevention
- Mail-bounce-monitoring (Resend webhook) detecteert verkeerd mailadres
- Invite TTL via `INVITE_TTL_MS` env-var verlengbaar in crisis

---

## 5. SRS-down

### Symptoom
Alle voorraad/klant/omzet-data toont "—" of error. Dashboard half leeg.

### Diagnose

1. **Test SRS direct**
   - `curl` test naar SRS SOAP-endpoint (zie env-var `SRS_SOAP_URL`)
   - Of via Vercel: `/api/admin/system-health` toont SRS-pingstatus

2. **Vercel kant**
   - Vercel-functies tonen timeouts? (Vercel dashboard → Functions tab)
   - Andere endpoints (Shopify-only) werken nog wel?

### Fix

| Diagnose | Actie |
|---|---|
| SRS-server unreachable | Geen actie van onze kant mogelijk — wacht op SRS-vendor / Bel SRS-support |
| SRS rate-limit (slechts 1 call tegelijk) | Tijdelijk SRS-clients sequencen ipv parallel — code-change |
| Vercel-functie timeout (10s default) | Verhoog `maxDuration` in vercel.json voor die endpoint |
| Cred's verlopen | Check `SRS_USERNAME` + `SRS_PASSWORD` in Vercel env-vars |

### Tijdelijke maatregelen tijdens outage
- Zet pickup-mail-cron UIT zodat geen lege mails worden verstuurd
- Toon banner in portal: "SRS-systeem tijdelijk niet bereikbaar"
- Frontend fallback: gebruik laatst-bekende blob-snapshot voor read-only views

### Prevention
- Snapshots in Vercel Blob zijn de fallback: alle "vandaag's" data komt
  uit cache zodat een 30min-outage onzichtbaar blijft
- Health-check cron (`/api/admin/system-health`) elke uur

---

## 6. Shopify rate-limit

### Symptoom
"Products cache leeg" of GraphQL-errors met `THROTTLED` / 429-status.

### Diagnose

1. **Welke endpoint?**
   - Products-refresh-cron? Hoogste GraphQL-cost.
   - Realtime article-search? Per-search ~50 punten.

2. **Hoeveel concurrent users?**
   - Vercel Functions tab toont parallelle invocaties

### Fix

| Diagnose | Actie |
|---|---|
| Products-cron faalt op THROTTLED | Verlaag `productsPerPage` in BUSINESS_CONFIG.shopifyPaging van 100 → 50 |
| Search-endpoint te veel calls | Verhoog cache-TTL `BUSINESS_CONFIG.cache.shopifyProductsMs` |
| Onverwacht hoog volume | Tijdelijk in-memory dedupe per query toevoegen (al deels gedaan in shopify-realtime-search) |
| Shopify-app-permissies onvoldoende | Verhoog tier in Shopify partner-dashboard (komt zelden voor) |

### Prevention
- Monitor Shopify-call-cost via `X-Shopify-Shop-Api-Call-Limit` header
- Cron's spreiden over uur (niet 100 jobs op exact 00:00)

---

## 7. Cron-job niet gedraaid

### Symptoom
"De maand-rapportage is niet binnengekomen" / "verjaardags-mail niet
verstuurd."

### Diagnose

1. **Cron-beheer modal** (admin → Beheer → Cron-beheer)
   - Status AAN of UIT?
   - Laatste run-tijdstempel + status
   - Error-message?

2. **Vercel Crons tab** (Vercel dashboard)
   - Werd de cron geïnvokeerd door Vercel?
   - HTTP-status van invoke?

### Fix

| Diagnose | Actie |
|---|---|
| Cron stond UIT (per ongeluk uitgezet) | Aanzetten via Cron-beheer + "Nu draaien" |
| Auth-faal: 401 | Check `CRON_SECRET` in Vercel env-vars |
| Endpoint timeout > 10s | Vercel Hobby/Pro limiet — verhoog maxDuration of split werk |
| Logica-fout in cron | Bekijk error in `audit/cron-log.json` |
| Vercel-platform-issue | Zelden — check vercel.com/status |

### Prevention
- Alle crons via `trackedCron()` wrapper → automatic logging
- Wekelijks `audit/cron-log.json` review op error-trends

---

## 8. Mail bounct

### Symptoom
"Mijn collega @gents.nl krijgt geen rapportages."

### Diagnose

1. **Mail-log filteren op error** — admin → Communicatie → Mail log → status=error
2. **Resend dashboard** check bounce-detail
3. **DNS check** — SPF/DKIM op @gents.nl correct?

### Fix

| Diagnose | Actie |
|---|---|
| Verkeerd geschreven mailadres | Update in betreffende admin-modal |
| Hard-bounce (mailbox bestaat niet) | Verwijder uit recipients |
| Soft-bounce (full mailbox) | Wacht 24u en retry |
| SPF-fail | DNS-record `v=spf1 include:_spf.resend.com ~all` toevoegen aan @gents.nl |
| DKIM-fail | Resend dashboard → Domain → re-verify |

### Prevention
- Resend bounce-webhook (`/api/webhooks/resend-events`) markeert recipients
- Whitelist-domain controle (`isAllowedMailRecipient` in business-config)

---

## 9. Vercel deploy faalt

### Symptoom
Push naar main, maar deploy mislukt OF site toont 500-error op alle endpoints.

### Diagnose

1. **Vercel dashboard** → Deployments → laatste deploy logs
2. **Build-error** vs **Runtime-error**?

### Fix

| Diagnose | Actie |
|---|---|
| Build-error: missing dependency | `npm install` lokaal, commit `package-lock.json` |
| Build-error: invalid JSON in vercel.json | JSON syntax fixen |
| Runtime: env-var missing | Vercel dashboard → Settings → Environment Variables → toevoegen |
| Runtime: blob-permission | Check `BLOB_READ_WRITE_TOKEN` (auto-gegeven, soms regenereren) |
| Function exceeds limit | Splits endpoint in kleinere functies |

### Rollback
- Vercel dashboard → Deployments → vorige deploy → "Promote to Production"
- Onmiddellijk live, geen rebuild

### Prevention
- Test branches via preview-deployments
- `node --check` lokaal voor commit

---

## 10. Voorraad-correctie pending

### Symptoom
"Mijn aanvraag staat al 3 dagen op pending en niemand reageert."

### Diagnose

1. **Admin voorraad-correcties pagina**
   - Status `pending`?
   - Wie heeft 'm toegewezen gekregen?
2. **Mail-log** — is HQ wel genotificeerd?

### Fix

| Diagnose | Actie |
|---|---|
| HQ niet genotificeerd | Mail-cron stond uit / faalde — fix cron + manuele notificatie |
| HQ-medewerker met vakantie | Reassign via admin |
| Aanvraag is invalid (alle 0 = geen wijziging) | Markeer als rejected + winkel laten weten |
| HQ heeft 't gemist | Eskaleer naar regional manager |

### Prevention
- Slack/Teams-webhook bij nieuwe pending aanvragen
- KPI "open aanvragen > 3 dagen" op admin-dashboard

---

## Generieke debug-tips

### Lokaal reproduceren?
**Niet trivaal** — portal draait op Shopify-theme + Vercel.
- Frontend: `shopify theme dev --store=gents-production`
- Backend: `vercel dev` (vereist Vercel CLI + env-vars in `.env.local`)

### Logs bekijken
- **Vercel Functions logs**: realtime in Vercel dashboard
- **Browser DevTools**: alle JS-errors via Console
- **Audit-logs**: `audit/cron-log.json`, `audit/permissions-audit.json`,
  `mail-events/*.json` in Vercel Blob

### Snel een env-var wijzigen
1. Vercel dashboard → Settings → Environment Variables
2. Edit waarde
3. **Belangrijk**: redeploy nodig (auto-trigger via webhook of via "Redeploy")

### Cache invalidate force
- In-memory caches: gewoon serverless function opnieuw warm laten worden
  (Vercel cold-start = 1-5s)
- Blob-caches: via admin-UI (productcache, leaderboard, etc.) of via Cron-beheer "Nu draaien"

---

## Aanverwante docs

- [`CONFIGURATION.md`](CONFIGURATION.md) — Welke knoppen kun je draaien
- [`GLOSSARY.md`](GLOSSARY.md) — Domein-jargon
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — Systeem-overzicht
- `ONBOARDING.md` — Eerste week dev guide (TODO)
