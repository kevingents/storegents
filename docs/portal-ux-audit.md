# Portal UX / functie-audit (storegents)

Datum: 2026-05-14
Scope: bestanden aanwezig in `storegents` (backend + Shopify snippets voor niet-leverbaar).

## Inventarisatie frontend
- Shopify snippet modal **Niet leverbaar verwerken**: `shopify/snippets/gents-niet-leverbaar-modal.liquid`
- Shopify snippet modal **Niet leverbaar rapportage**: `shopify/snippets/gents-niet-leverbaar-report-modal.liquid`
- Frontend logica voor beide modals: `shopify/assets/gents-niet-leverbaar-admin.js`

## Koppeling knoppen → modal
- `data-modal-open="admin-unavailable-order-lines"` opent verwerken-modal.
- `data-modal-open="admin-unavailable-report"` opent rapportage-modal.
- Script luistert op deze selectors en triggert dataload (`loadRows`, `loadReport`).

## Endpoint-koppelingen
- Openstaande/processing regels: `GET /api/admin/unavailable-order-lines`
- Verwerking geselecteerde regels: `POST /api/admin/unavailable-order-lines/process`
- Dashboard rapportage: `GET /api/admin/unavailable-order-lines/dashboard`
- Cancellations rapportage: `GET /api/admin/order-cancellations/report`
- Open weborders (detail/te laat): `GET /api/srs/open-weborders`
- Locatie-overzicht admin: `GET /api/admin/dashboard/location-overview`

## Audit-resultaat per functie (beschikbare scope)
### Niet leverbaar verwerken
- UI: duidelijker grid + full-width + overflow-x voor tabel toegevoegd.
- States: loading/empty/error aanwezig in JS.
- Acties: individuele verwerking + bulk aanwezig.
- Mobiel: verbeterd met 1-koloms grid op smalle schermen.

### Niet leverbaar rapportage
- UI: filterbalk en rapportagetabellen responsive gemaakt.
- States: message + “nog niet vernieuwd” + lege tabelstate aanwezig.

### Geannuleerde orders / annuleringen
- Data: rapportage uitgebreid met `shopifyStatus`, `srsStatusResolved`, `refundStatusResolved`, `mismatch`, `actionNeeded`.
- Doel: mismatch Shopify↔SRS en open refund-acties expliciet zichtbaar.

## Bekende gaten buiten deze repo-scope
- Admin home / winkel home informatie-architectuur (kaarten, categorieën, sidebar flow) staat niet in deze repo.
- Functies zoals klantzoeken, reviews, omnichannel kaarten bestaan backend-side, maar de volledige portal-rendering zit vermoedelijk in `shopifystore` of ander frontend project.

## Aanbevolen vervolgstap
1. Zelfde audit uitvoeren in `shopifystore` voor volledige kaart- en dashboardstructuur.
2. Knoppenmatrix maken (kaart → modal/route → endpoint) en daar labels/categorieën op herstructureren.
3. Voor cancellations en return-insight: frontend tabellen kolommen expliciet tonen met filters voor mismatch/action needed.
