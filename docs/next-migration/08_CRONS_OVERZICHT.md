# GENTS — Cron-overzicht (wat doet elke cron)

> Geannoteerde versie van `07_CRONS_INVENTORY.md`: per cron wat hij doet + wanneer.
> Gebruik dit om te beslissen wat je opnieuw inplant in het nieuwe systeem en in
> welke volgorde. Schedules in cron-notatie (UTC) + in mensentaal.
>
> **Let op (gating):** sommige crons doen pas écht werk met een env-vlag aan —
> staat per regel vermeld met ⚠. Zet die mee over.

## Kritiek — voorraad & sync

| Cron | Wanneer | Wat het doet |
|---|---|---|
| `srs-voorraad-import` | 05:00, 11:00, 15:00 | Haalt voorraad + bin-locaties van de SRS-SFTP, schrijft de snapshot. **Bron** voor alle voorraad-dashboards, derving, magazijn-vs-winkel. |
| `shopify-stock-snapshot` | elke 20 min (06–22u) | Snapshot van de Shopify-magazijnvoorraad. **Bron** voor de bol-voorraadsync + realtime-lookups. |
| `srs-cache-refresh` | elke 10 min (06–22u, ma–za) | Ververst de SRS-datacache (o.a. open weborders) — houdt de winkelvloer-tools snel. |
| `srs-revenue-cache` | elke 2 uur (xx:30) | Cachet de SRS-omzetcijfers. |
| `srs-retail-import` | 05:20 | Importeert retail-tellers + kassaverkopen (voedt POAS + periode-ledger). |
| `stock-reconcile` | 05:30 | Reconciliatie magazijn ↔ winkel (verschillen signaleren). |
| `merchandiser-snapshot` | 05:40 | Bouwt de merchandiser-data (herverdeling / misgrijpen / doorverkoop). |
| `shopify-products-refresh` | 03:00 | Ververst de Shopify-productcache (titel, beeld, SRSERP-metafields). |
| `shopify-offline-sync` | 03:30 | Synct offline (winkel-)aankopen naar de Shopify-klantprofielen. |
| `srs-historic-backfill` | 01:00 | Vult ontbrekende historische SRS-data aan. |

## Kritiek — bol.com (overselling-risico bij stilstand)

| Cron | Wanneer | Wat het doet |
|---|---|---|
| `bol-stock` | elk uur (xx:30) | Zet de bol-voorraad gelijk aan magazijn − veiligheidsmarge. ⚠ vereist `BOL_STOCK_AUTO≠0` + gekoppelde bol. |
| `bol-stock?map=1&_=mapRefresh` | 05:40 | Ververst de offer-map (EAN → offerId) die `bol-stock` gebruikt. |
| `bol-orders` | elk uur (xx:00) | Bewaakt openstaande bol-orders + verzend-deadlines (niet-leverbaar signaleren). |
| `bol-srs-sync` | elk uur (xx:20) | Synct bol-orders door naar SRS. |
| `bol-shipment-sync` | elk uur (xx:40) | Synct verzendingen / track&trace terug naar bol. |
| `bol-returns` | 04:20 | Haalt bol-retouren op + retouranalyse (advies "niet meer verkopen"). |
| `bol-content` | 04:25 | Werkt bol-listings/content bij (titels, attributen, maat). |
| `bol-insights` | 06:30 | Haalt bol-prestaties / insights op. |

## Mails & automations

| Cron | Wanneer | Wat het doet |
|---|---|---|
| `welkom-mail` | elk uur (xx:15) | Stuurt welkomstmails naar nieuwe klanten. |
| `pak-mail` | 07:45 | Pak-automation (mail na pak-aankoop). |
| `customer-mail-run?mode=weekly` | ma 08:30 | Wekelijks klantenrapport per winkel. |
| `customer-mail-run?mode=monthly` | 2e vd maand 09:00 | Maandelijks klantenrapport. |
| `weborder-mail-run` | 08:00 | Weborder-meldingen naar de winkels. |
| `drager-mail-run` | 08:10 | Drager-/verplaatsing-mails. |
| `pickup-mail-run` | 08:00 (ma–za) | Afhaalorder-mails naar klant. |
| `voucher-reminders` | 08:00 | Herinneringen voor (bijna verlopen) vouchers. |
| `daily-loyalty-vouchers` | 06:00 | Zet gespaarde punten om in vouchers + mailt ze. ⚠ vereist `LOYALTY_VOUCHER_CRON_LIVE=true`. |
| `birthday-notifications` | 07:00 | Verjaardags-notificaties. |
| `automations?id=birthday` | 08:00 | Verjaardag-automation (mail/aanbod). |
| `automations?id=winback` | 09:30 | Winback-automation (slapende klanten). |
| `automations?id=replenishment` | 10:00 | Replenishment-automation (herhaalaankoop). |
| `automations?id=custom` | 10:30 | Custom (zelf-gedefinieerde) automations. |
| `automation-new-collection` | 09:20 | Nieuwe-collectie-automation. |
| `marketing-advisor-mail` | 1e vd maand 07:00 | Maandelijkse marketing-advies-mail. |
| `region-manager-weekly-report` | 08:00 | Regio-manager weekrapport (logica bepaalt de dag). |
| `region-manager-weekly-drager-report` | 08:15 | Regio-manager drager-weekrapport. |
| `taken-reminders` | 06:30 | Herinneringen openstaande taken (takenplanner). |

## Rapporten & snapshots

| Cron | Wanneer | Wat het doet |
|---|---|---|
| `report-snapshots` | 03:00 | Bouwt de dagelijkse rapport-snapshots. |
| `run-report-schedules` | elke 15 min | Voert geplande rapportages uit + verstuurt ze (rapport-scheduler). |
| `overdue-snapshot` | 07:45 | Snapshot van te-late orders. |
| `store-insights-builder` | 03:00 | Bouwt de winkel-inzichten. |
| `top-customers-snapshot` | 05:00 | Top-klanten per winkel. |
| `google-reviews-snapshot` | 04:00 | Haalt Google-reviews op (per winkel). |
| `monthly-omnichannel-winner` | 1e vd maand 08:00 | Bepaalt de maandelijkse omnichannel-winnaar. |
| `supplychain-daily-metrics` | 04:30 | Dagelijkse supplychain-KPI-snapshot. |

## Monitoring & alerts

| Cron | Wanneer | Wat het doet |
|---|---|---|
| `system-health-monitor` | elke 5 min | Bewaakt de systeem-gezondheid (endpoints/integraties). |
| `new-order-watcher` | elke 5 min | Detecteert nieuwe orders → triggert alerts. |
| `alert-rules-eval` | elk uur | Evalueert de slimme alert-regels (stock-threshold / event / schedule). |
| `kpi-alerts` | 07:00 | Controleert KPI-drempels + verstuurt alerts. |
| `retail-anomaly-check` | 05:50 | Retail-anomalie-detectie (afwijkende cijfers). |
| `srs-unavailable-hourly` | elk uur (xx:20) | Checkt niet-leverbare SRS-orderregels. |
| `srs-unavailable-lost-found-check` | ma+di 06:30 | Lost-&-found check op niet-leverbaar. |
| `srs-cancellations-nightly` | elk uur (xx:15) | Detecteert SRS-annuleringen en maakt de refund/cancel-werkregels aan. |

## Content / marketing / AI

| Cron | Wanneer | Wat het doet |
|---|---|---|
| `content-new-product-check` | 03:30 | Spoort nieuwe producten zonder content op. |
| `content-calendar-tips` | 06:15 | Genereert content-kalender-tips (weer/seizoen/verkoop/AI). |
| `beeldbank-classify` | 06:30 | AI-classificatie van beeldbank-afbeeldingen (vision). |
| `product-audit` | 03:40 | Product-audit (kwaliteit/volledigheid). |
| `seo-audit` | 03:55 | On-page SEO-audit van de producten. |
| `ai-visibility` | 04:05 | AI-vindbaarheid-scan (readiness + test-queries). |
| `spotler-metrics-refresh` | 05:45 | Ververst Spotler e-mailmarketing-metrics. |
| `spotler-audience-sync` | 05:50 | Synct het Spotler-publiek. |
| `resend-audience-sync` | 05:55 | Volledige Resend-audience-sync. |
| `resend-audience-sync?inc=1` | elke 2 uur | Incrementele Resend-audience-sync. |
| `sync-shopify-points` | 06:00 | Schrijft spaarpunten naar de Shopify-klant-metafields. |
| `sync-google-opening-hours` | 02:00 | Synct openingstijden naar Google Business Profile. |
| `gala-crawl` | ma 06:40 | Crawlt gala-/evenementen (Instagram) voor de kalender. |

## Overig

| Cron | Wanneer | Wat het doet |
|---|---|---|
| `reserveringen-expire` | 06:00 | Ruimt verlopen reserveringen op. |
| `students-vereniging-rebuild` | 03:00 | Herbouwt de studenten-/vereniging-data. |

---

**Totaal: 68 crons.** Auth: elke handler checkt `CRON_SECRET` (Vercel stuurt
`Authorization: Bearer <CRON_SECRET>` mee). Drijf je ze straks vanuit een externe
scheduler, stuur dan diezelfde header mee. De exacte JSON om in te plannen staat in
`07_CRONS_INVENTORY.md`.
