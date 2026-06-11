/**
 * lib/cron-jobs.js
 *
 * Centrale schedule voor alle cron-jobs, aangestuurd door één dispatcher
 * (api/cron/dispatch.js) i.p.v. 68 losse Vercel-cron-regels. Zo blijven we ruim
 * onder Vercel's cron-limiet en is de planning hier op één plek bewerkbaar.
 *
 * Elke job: { path, schedule, enabled? }
 *   - path     : het cron-endpoint (incl. eventuele query-params)
 *   - schedule : standaard 5-velds cron-expressie, geëvalueerd in UTC
 *                (identiek aan hoe Vercel native crons draaien)
 *   - enabled  : optioneel; zet op false om een job tijdelijk uit te zetten
 *                ZONDER 'm te verwijderen (geen redeploy-semantiek nodig).
 *
 * LET OP: system-health-monitor staat BEWUST niet in deze lijst — die draait als
 * losse native cron (zie vercel.json), zodat de waakhond niet afhangt van de
 * dispatcher die hij juist moet bewaken.
 *
 * Toekomst: deze lijst kan naar een blob + Instellingen-kaart, zodat schedules
 * en aan/uit zonder redeploy te beheren zijn (huisregel: config in de tool).
 */
export const CRON_JOBS = [
  // ── Reminders / operationele mails ──────────────────────────────────────
  { path: "/api/cron/taken-reminders", schedule: "30 6 * * *" },
  { path: "/api/cron/voucher-reminders", schedule: "0 8 * * *" },
  { path: "/api/cron/overdue-snapshot", schedule: "45 7 * * *" },
  { path: "/api/cron/pickup-mail-run", schedule: "0 8 * * 1-6" },
  { path: "/api/cron/weborder-mail-run", schedule: "0 8 * * *" },
  { path: "/api/cron/drager-mail-run", schedule: "10 8 * * *" },

  // ── Rapporten / KPI ─────────────────────────────────────────────────────
  { path: "/api/cron/report-snapshots", schedule: "0 3 * * *" },
  { path: "/api/cron/run-report-schedules", schedule: "0,15,30,45 * * * *" },
  { path: "/api/cron/daily-loyalty-vouchers", schedule: "0 6 * * *" },
  { path: "/api/cron/region-manager-weekly-report", schedule: "0 8 * * *" },
  { path: "/api/cron/region-manager-weekly-drager-report", schedule: "15 8 * * *" },
  { path: "/api/cron/monthly-omnichannel-winner", schedule: "0 8 1 * *" },
  { path: "/api/cron/customer-mail-run?mode=weekly", schedule: "30 8 * * 1" },
  { path: "/api/cron/customer-mail-run?mode=monthly", schedule: "0 9 2 * *" },
  { path: "/api/cron/kpi-alerts", schedule: "0 7 * * *" },
  { path: "/api/cron/supplychain-daily-metrics", schedule: "30 4 * * *" },

  // ── Klant-automations (mail) ────────────────────────────────────────────
  { path: "/api/cron/birthday-notifications", schedule: "0 7 * * *" },
  { path: "/api/cron/automations?id=birthday", schedule: "0 8 * * *" },
  { path: "/api/cron/automations?id=winback", schedule: "30 9 * * *" },
  { path: "/api/cron/automations?id=replenishment", schedule: "0 10 * * *" },
  { path: "/api/cron/automations?id=custom", schedule: "30 10 * * *" },
  { path: "/api/cron/welkom-mail", schedule: "15 * * * *" },
  { path: "/api/cron/pak-mail", schedule: "45 7 * * *" },

  // ── Syncs / data-import ─────────────────────────────────────────────────
  { path: "/api/cron/sync-shopify-points", schedule: "0 6 * * *" },
  { path: "/api/cron/sync-google-opening-hours", schedule: "0 2 * * *" },
  { path: "/api/cron/srs-cancellations-nightly", schedule: "15 * * * *" },
  { path: "/api/cron/srs-unavailable-hourly", schedule: "20 * * * *" },
  { path: "/api/cron/srs-revenue-cache", schedule: "30 */2 * * *" },
  { path: "/api/cron/srs-unavailable-lost-found-check", schedule: "30 6 * * 1,2" },
  { path: "/api/cron/srs-cache-refresh", schedule: "*/10 6-22 * * 1-6" },
  { path: "/api/cron/srs-historic-backfill", schedule: "0 1 * * *" },
  { path: "/api/cron/srs-voorraad-import", schedule: "0 5,11,15 * * *" },
  { path: "/api/cron/srs-retail-import", schedule: "20 5 * * *" },
  { path: "/api/cron/shopify-stock-snapshot", schedule: "*/20 6-22 * * *" },
  { path: "/api/cron/shopify-offline-sync", schedule: "30 3 * * *" },
  { path: "/api/cron/shopify-products-refresh", schedule: "0 3 * * *" },
  { path: "/api/cron/resend-audience-sync", schedule: "55 5 * * *" },
  { path: "/api/cron/resend-audience-sync?inc=1", schedule: "0 */2 * * *" },

  // ── Bol.com ─────────────────────────────────────────────────────────────
  { path: "/api/cron/bol-orders", schedule: "0 * * * *" },
  { path: "/api/cron/bol-srs-sync", schedule: "20 * * * *" },
  { path: "/api/cron/bol-stock", schedule: "30 * * * *" },
  { path: "/api/cron/bol-shipment-sync", schedule: "40 * * * *" },
  { path: "/api/cron/bol-returns", schedule: "20 4 * * *" },
  { path: "/api/cron/bol-content", schedule: "25 4 * * *" },
  { path: "/api/cron/bol-stock?map=1&_=mapRefresh", schedule: "40 5 * * *" },
  { path: "/api/cron/bol-insights", schedule: "30 6 * * *" },

  // ── Voorraad / operationeel ─────────────────────────────────────────────
  { path: "/api/cron/new-order-watcher", schedule: "*/5 * * * *" },
  { path: "/api/cron/merchandiser-snapshot", schedule: "40 5 * * *" },
  { path: "/api/cron/stock-reconcile", schedule: "30 5 * * *" },
  { path: "/api/cron/retail-anomaly-check", schedule: "50 5 * * *" },
  { path: "/api/cron/reserveringen-expire", schedule: "0 6 * * *" },
  { path: "/api/cron/top-customers-snapshot", schedule: "0 5 * * *" },

  // ── Content / marketing ─────────────────────────────────────────────────
  { path: "/api/cron/store-insights-builder", schedule: "0 3 * * *" },
  { path: "/api/cron/students-vereniging-rebuild", schedule: "0 3 * * *" },
  { path: "/api/cron/content-new-product-check", schedule: "30 3 * * *" },
  { path: "/api/cron/content-calendar-tips", schedule: "15 6 * * *" },
  { path: "/api/cron/automation-new-collection", schedule: "20 9 * * *" },
  { path: "/api/cron/google-reviews-snapshot", schedule: "0 4 * * *" },
  { path: "/api/cron/spotler-metrics-refresh", schedule: "45 5 * * *" },
  { path: "/api/cron/spotler-audience-sync", schedule: "50 5 * * *" },
  { path: "/api/cron/gala-crawl", schedule: "40 6 * * 1" },
  { path: "/api/cron/beeldbank-classify", schedule: "30 6 * * *" },
  { path: "/api/cron/product-audit", schedule: "40 3 * * *" },
  { path: "/api/cron/seo-audit", schedule: "55 3 * * *" },
  { path: "/api/cron/ai-visibility", schedule: "5 4 * * *" },
  { path: "/api/cron/marketing-advisor-mail", schedule: "0 7 1 * *" },

  // ── Alerts ──────────────────────────────────────────────────────────────
  { path: "/api/cron/alert-rules-eval", schedule: "0 * * * *" },
];
