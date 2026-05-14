# storegents
winkels gents

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
