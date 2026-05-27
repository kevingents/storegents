# storegents — GENTS Portal Backend

Vercel API-backend voor de GENTS Herenmode medewerker-portal. Praat met:

- **Shopify** (orders, producten, klanten, refunds) via GraphQL Admin API
- **SRS ERP** (voorraad, kassa-bonnen, klanten, weborders) via SOAP
- **Vercel Blob** voor configuratie + caches + audit-logs
- **Resend** voor outbound mail
- **Google Places** voor reviews
- **Sendcloud** voor verzendlabels

Frontend ligt in zuster-repo [shopifystore](../shopifystore).

## Voor nieuwe ontwikkelaars — begin hier

| Document | Wat staat erin |
|---|---|
| 📘 [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) | Welke knoppen kun je draaien zonder developer — env-vars, business-config, admin-UI |
| 📗 `docs/ARCHITECTURE.md` | High-level systeem-diagram en data-flow (TODO) |
| 📕 `docs/GLOSSARY.md` | SRS, RVE, weborder, drager, supplychain — wat betekent alles (TODO) |
| 📙 `docs/RUNBOOKS.md` | Top incidenten: pickup-mail faalt, voorraad onjuist, etc. (TODO) |
| 📓 `docs/ONBOARDING.md` | Stap-voor-stap eerste week voor nieuwe dev (TODO) |

**Centrale config-bestand**: alle bedrijfsregels die je zonder code-deploy
zou willen wijzigen, staan in [`lib/business-config.js`](lib/business-config.js).

## Admin workflow API (MVP)
Nieuwe endpoints:
- `PATCH /api/admin/workqueue/:storeId`
- `POST /api/admin/workqueue/:storeId/follow-up`
- `POST /api/admin/ux-events`
- `GET /api/admin/metrics/ux`
- `GET /api/admin/reports/catalog`
- `GET /api/store/actions/today`

`GET /api/admin/dashboard/location-overview` is uitgebreid met workflowvelden (`workflowStatus`, `lastHandledBy`), SLA/impactvelden (`slaBucket`, `estimatedRevenueRisk`, `affectedCustomers`, `impactScore`, `priorityLevel`, `advice`) en CTA-links (`actions`).

Error model voor nieuwe admin endpoints:
`{ success:false, message, source, endpoint, retryable, details }`.
