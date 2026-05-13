# Admin Flow Matrix (Sprint 1)

Doel: dubbele/kapotte routes zichtbaar maken en 1 owner per flow afspreken.

## 1) Niet-leverbaar orderregels

| Scherm/Flow | Endpoint(s) | Doel | Owner | Status | Opmerking |
|---|---|---|---|---|---|
| Niet leverbaar verwerken modal | `GET /api/admin/unavailable-order-lines` | Open regels laden/syncen | Backend Ops | Actief | Gebruikt store/status/order filters. |
| Niet leverbaar verwerken modal | `POST /api/admin/unavailable-order-lines/process` | Refund + SRS cancel uitvoeren | Backend Ops | Actief | Partial/207 mogelijk. Retry-flow nog uitbreiden. |
| Niet leverbaar rapportage modal | `GET /api/admin/unavailable-order-lines/dashboard` | KPI's, stores/artikelen, cron-overzicht | Backend Ops | Actief | Basis aanwezig; observability uitbreiden. |
| Debug/historie | `GET /api/admin/unavailable-order-lines/debug` | Technische diagnose per order/line | Backend Ops | Actief | Voor support/debug. |

## 2) Open weborders

| Scherm/Flow | Endpoint(s) | Doel | Owner | Status | Opmerking |
|---|---|---|---|---|---|
| Open weborders overzicht | `GET /api/weborders/overview` | Open weborders tonen | Fulfillment | Actief | Mogelijke overlap met admin overdue. |
| Admin overdue rapport | `GET /api/admin/weborders/overdue-report` | Achterstallige weborders | Fulfillment + BI | Actief | Kans op dubbele waarheid met overview. |
| Status/health | `GET /api/weborders/health` | Bronstatus check | Platform | Actief | Goed voor diagnosestap. |

## 3) Order cancellations / exchanges

| Scherm/Flow | Endpoint(s) | Doel | Owner | Status | Opmerking |
|---|---|---|---|---|---|
| Rapportage | `GET /api/admin/order-cancellations/report` | Overzicht + status | Backend Ops | Actief | Kans op overlap met unavailable. |
| Verwerking | `POST /api/admin/order-cancellations/process` | Afhandelen acties | Backend Ops | Actief | Controleren op idempotency/retry. |
| Sync | `/api/admin/order-cancellations/sync-*` | Data sync uit SRS | Backend Ops | Actief | Meerdere varianten; consolideren gewenst. |

## 4) Vouchers & klanteninschrijvingen

| Scherm/Flow | Endpoint(s) | Doel | Owner | Status | Opmerking |
|---|---|---|---|---|---|
| Voucher rapportage | `GET /api/admin/vouchers/report` | Inzage runs/logs | Marketing Ops | Actief | |
| Voucher generatie | `POST /api/admin/vouchers/generate`, `POST /api/admin/vouchers/bulk-generate` | Uitgifte vouchers | Marketing Ops | Actief | Dubbele flow, heldere keuze nodig. |
| Loyalty run | `POST /api/admin/vouchers/loyalty-run` | Geplande/handmatige run | Marketing Ops | Actief | |
| Klant weekrapport | `GET /api/admin/customers/weekly-report` | Klantinschrijvingen / metrics | CRM Ops | Actief | |

## 5) Cron observability (huidig)

| Scherm/Flow | Endpoint(s) | Doel | Owner | Status | Opmerking |
|---|---|---|---|---|---|
| Cron log | `GET /api/admin/cron-log` | Recente cron-uitvoer | Platform | Actief | Centrale ingang. |
| Mail automation status | `GET /api/admin/mail-automations/status` | Mailcron status | Platform | Actief | |
| System health | `GET /api/admin/system-health` | Basale runtime checks | Platform | Actief | |

## 6) Uitgeschakeld (bewust)

| Flow | Endpoint(s) | Reden | Status |
|---|---|---|---|
| Dragers API | `/api/srs/dragers*` | SRS koppeling nog niet stabiel | Uitgeschakeld (410) |
| Dragers cron | `/api/cron/drager-mail-run`, `/api/cron/region-manager-weekly-drager-report` | SRS koppeling nog niet stabiel | Uitgeschakeld (410) |

## Gevonden risico's (Sprint 1 output)

1. **Dubbele bron rondom weborders**: `weborders/overview` vs `admin/weborders/overdue-report`.
2. **Overlap cancellation vs unavailable**: twee verwerkingstromen voor vergelijkbare operationele problemen.
3. **Meerdere sync-varianten** bij cancellations (`sync-srs`, `sync-srs-orders`, `sync-srs-all`) vergroten beheerlast.

## Voorstel Sprint 2 (direct vervolg)

1. 1 bron van waarheid voor weborders (backend service) + 1 admin flow.
2. Retry playbook in unavailable UI: *alleen refund*, *alleen SRS cancel*, *handmatig afgehandeld + reden*.
3. Cron diagnosepaneel: laatste run, duur, succesratio, failed rows, retry count.
