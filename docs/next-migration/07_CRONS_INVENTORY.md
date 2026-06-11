# GENTS — Cron-inventaris (overzetten naar de andere portal)

> Snapshot van álle 68 crons die in `storegents/vercel.json` stonden vóór ze
> werden uitgezet. Deze lijst is de bron om ze elders opnieuw in te plannen.
> Datum uitgezet: zie git-historie van `vercel.json` (commit "stop alle crons").

## BELANGRIJK — Vercel-crons draaien alleen binnen hun eigen project

De cron-**logica** zit in `storegents` (`api/cron/*.js`). Vercel-crons kunnen
**alleen paden in hun eigen deployment** aanroepen (relatieve paden, geen externe
URL's). Je kunt ze dus **niet** vanuit een ander Vercel-project (`storeportal_next`)
laten draaien door ze in díe `vercel.json` te zetten — dat zou de Next-endpoints
aanroepen, niet deze handlers.

Drie geldige opties om ze "elders" te draaien:

1. **Laat de cron-handlers in `storegents`** en plan ze daar (terugzetten = git
   revert van de "stop alle crons"-commit). Eenvoudigst.
2. **Externe scheduler** (cron-job.org, GitHub Actions, EasyCron) die de
   storegents-endpoints aanroept:
   `GET https://storegents.vercel.app/api/cron/<naam>` met header
   `Authorization: Bearer <CRON_SECRET>`. (De handlers checken `CRON_SECRET`.)
3. **Verplaats de handler-code** mee naar het nieuwe project en plan daar — alleen
   zinvol voor crons die puur frontend/portal-data raken.

> Tip: zet niet alles tegelijk weer aan. Begin met de **kritieke** groep
> (voorraad + bol) zodra de nieuwe locatie klaar is; de rest kan gefaseerd.

---

## Prioriteit bij herbouwen

**Kritiek — voorraad & sync (stilstand = stale dashboards / overselling-risico):**
`srs-voorraad-import` (3×/dag), `shopify-stock-snapshot` (elke 20 min),
`srs-cache-refresh`, `srs-revenue-cache`, `stock-reconcile`,
`shopify-products-refresh`, `shopify-offline-sync`, `srs-retail-import`,
`merchandiser-snapshot`.

**Kritiek — bol.com (overselling-risico):**
`bol-stock` (elk uur + map-refresh), `bol-orders`, `bol-srs-sync`,
`bol-shipment-sync`, `bol-returns`, `bol-content`, `bol-insights`.

**Mails & automations:**
`welkom-mail`, `pak-mail`, `customer-mail-run` (weekly/monthly),
`weborder-mail-run`, `drager-mail-run`, `pickup-mail-run`, `voucher-reminders`,
`daily-loyalty-vouchers`, `birthday-notifications`, `automations` (birthday/
winback/replenishment/custom), `automation-new-collection`,
`marketing-advisor-mail`, `region-manager-weekly-report(+drager)`,
`taken-reminders`.

**Rapporten & snapshots:**
`report-snapshots`, `run-report-schedules`, `overdue-snapshot`,
`store-insights-builder`, `top-customers-snapshot`, `google-reviews-snapshot`,
`monthly-omnichannel-winner`, `supplychain-daily-metrics`, `srs-historic-backfill`.

**Monitoring & alerts:**
`system-health-monitor` (5 min), `new-order-watcher` (5 min), `kpi-alerts`,
`alert-rules-eval`, `retail-anomaly-check`, `srs-unavailable-hourly`,
`srs-unavailable-lost-found-check`.

**Content / marketing / AI:**
`content-new-product-check`, `content-calendar-tips`, `beeldbank-classify`,
`product-audit`, `seo-audit`, `ai-visibility`, `spotler-metrics-refresh`,
`spotler-audience-sync`, `resend-audience-sync` (+inc), `sync-shopify-points`,
`sync-google-opening-hours`, `gala-crawl`.

**Overig:** `reserveringen-expire`, `students-vereniging-rebuild`.

---

## Volledige lijst (kant-en-klaar — plak terug in een `vercel.json` `crons`-array)

```json
{
  "crons": [
    { "path": "/api/cron/report-snapshots", "schedule": "0 3 * * *" },
    { "path": "/api/cron/taken-reminders", "schedule": "30 6 * * *" },
    { "path": "/api/cron/run-report-schedules", "schedule": "0,15,30,45 * * * *" },
    { "path": "/api/cron/voucher-reminders", "schedule": "0 8 * * *" },
    { "path": "/api/cron/pickup-mail-run", "schedule": "0 8 * * 1-6" },
    { "path": "/api/cron/daily-loyalty-vouchers", "schedule": "0 6 * * *" },
    { "path": "/api/cron/sync-shopify-points", "schedule": "0 6 * * *" },
    { "path": "/api/cron/sync-google-opening-hours", "schedule": "0 2 * * *" },
    { "path": "/api/cron/srs-cancellations-nightly", "schedule": "15 * * * *" },
    { "path": "/api/cron/srs-unavailable-hourly", "schedule": "20 * * * *" },
    { "path": "/api/cron/srs-revenue-cache", "schedule": "30 */2 * * *" },
    { "path": "/api/cron/overdue-snapshot", "schedule": "45 7 * * *" },
    { "path": "/api/cron/weborder-mail-run", "schedule": "0 8 * * *" },
    { "path": "/api/cron/drager-mail-run", "schedule": "10 8 * * *" },
    { "path": "/api/cron/srs-unavailable-lost-found-check", "schedule": "30 6 * * 1,2" },
    { "path": "/api/cron/birthday-notifications", "schedule": "0 7 * * *" },
    { "path": "/api/cron/region-manager-weekly-report", "schedule": "0 8 * * *" },
    { "path": "/api/cron/region-manager-weekly-drager-report", "schedule": "15 8 * * *" },
    { "path": "/api/cron/srs-cache-refresh", "schedule": "*/10 6-22 * * 1-6" },
    { "path": "/api/cron/srs-historic-backfill", "schedule": "0 1 * * *" },
    { "path": "/api/cron/system-health-monitor", "schedule": "*/5 * * * *" },
    { "path": "/api/cron/new-order-watcher", "schedule": "*/5 * * * *" },
    { "path": "/api/cron/store-insights-builder", "schedule": "0 3 * * *" },
    { "path": "/api/cron/shopify-stock-snapshot", "schedule": "*/20 6-22 * * *" },
    { "path": "/api/cron/monthly-omnichannel-winner", "schedule": "0 8 1 * *" },
    { "path": "/api/cron/google-reviews-snapshot", "schedule": "0 4 * * *" },
    { "path": "/api/cron/reserveringen-expire", "schedule": "0 6 * * *" },
    { "path": "/api/cron/students-vereniging-rebuild", "schedule": "0 3 * * *" },
    { "path": "/api/cron/shopify-offline-sync", "schedule": "30 3 * * *" },
    { "path": "/api/cron/customer-mail-run?mode=weekly", "schedule": "30 8 * * 1" },
    { "path": "/api/cron/customer-mail-run?mode=monthly", "schedule": "0 9 2 * *" },
    { "path": "/api/cron/shopify-products-refresh", "schedule": "0 3 * * *" },
    { "path": "/api/cron/content-new-product-check", "schedule": "30 3 * * *" },
    { "path": "/api/cron/content-calendar-tips", "schedule": "15 6 * * *" },
    { "path": "/api/cron/spotler-metrics-refresh", "schedule": "45 5 * * *" },
    { "path": "/api/cron/spotler-audience-sync", "schedule": "50 5 * * *" },
    { "path": "/api/cron/resend-audience-sync", "schedule": "55 5 * * *" },
    { "path": "/api/cron/resend-audience-sync?inc=1", "schedule": "0 */2 * * *" },
    { "path": "/api/cron/automation-new-collection", "schedule": "20 9 * * *" },
    { "path": "/api/cron/automations?id=birthday", "schedule": "0 8 * * *" },
    { "path": "/api/cron/automations?id=winback", "schedule": "30 9 * * *" },
    { "path": "/api/cron/automations?id=replenishment", "schedule": "0 10 * * *" },
    { "path": "/api/cron/automations?id=custom", "schedule": "30 10 * * *" },
    { "path": "/api/cron/kpi-alerts", "schedule": "0 7 * * *" },
    { "path": "/api/cron/srs-voorraad-import", "schedule": "0 5,11,15 * * *" },
    { "path": "/api/cron/srs-retail-import", "schedule": "20 5 * * *" },
    { "path": "/api/cron/merchandiser-snapshot", "schedule": "40 5 * * *" },
    { "path": "/api/cron/retail-anomaly-check", "schedule": "50 5 * * *" },
    { "path": "/api/cron/gala-crawl", "schedule": "40 6 * * 1" },
    { "path": "/api/cron/beeldbank-classify", "schedule": "30 6 * * *" },
    { "path": "/api/cron/supplychain-daily-metrics", "schedule": "30 4 * * *" },
    { "path": "/api/cron/top-customers-snapshot", "schedule": "0 5 * * *" },
    { "path": "/api/cron/product-audit", "schedule": "40 3 * * *" },
    { "path": "/api/cron/stock-reconcile", "schedule": "30 5 * * *" },
    { "path": "/api/cron/seo-audit", "schedule": "55 3 * * *" },
    { "path": "/api/cron/ai-visibility", "schedule": "5 4 * * *" },
    { "path": "/api/cron/alert-rules-eval", "schedule": "0 * * * *" },
    { "path": "/api/cron/bol-returns", "schedule": "20 4 * * *" },
    { "path": "/api/cron/bol-content", "schedule": "25 4 * * *" },
    { "path": "/api/cron/bol-stock?map=1&_=mapRefresh", "schedule": "40 5 * * *" },
    { "path": "/api/cron/bol-stock", "schedule": "30 * * * *" },
    { "path": "/api/cron/bol-insights", "schedule": "30 6 * * *" },
    { "path": "/api/cron/welkom-mail", "schedule": "15 * * * *" },
    { "path": "/api/cron/pak-mail", "schedule": "45 7 * * *" },
    { "path": "/api/cron/bol-orders", "schedule": "0 * * * *" },
    { "path": "/api/cron/bol-srs-sync", "schedule": "20 * * * *" },
    { "path": "/api/cron/marketing-advisor-mail", "schedule": "0 7 1 * *" },
    { "path": "/api/cron/bol-shipment-sync", "schedule": "40 * * * *" }
  ]
}
```

## Terugzetten (op `storegents`)

`git revert <hash van de "stop alle crons"-commit>` en pushen — Vercel plant alles
dan weer in zoals het was. Of plak de array hierboven terug in `vercel.json`.
