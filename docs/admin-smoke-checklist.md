# Admin smoke checklist (Fase 4)

## Onbeschikbare orderregels
- [ ] Lijst laden zonder errors
- [ ] Snelfilters (vandaag/7d/maand) werken
- [ ] Retry bulk: refund-only
- [ ] Retry bulk: srs-only
- [ ] Per regel: verwerken/refund retry/srs retry
- [ ] Foutmelding toont 'wat nu' hint

## Rapportage
- [ ] Dashboard laadt met KPI's
- [ ] Laatst bijgewerkt timestamp verandert
- [ ] Cronstatus tabel toont data of nette empty state

## Weborders
- [ ] Open weborders overzicht laadt
- [ ] Overdue rapport opent zonder 500
- [ ] Geen dubbele/tegenstrijdige totalen

## Cancellations
- [ ] Report endpoint reageert
- [ ] Process endpoint geeft duidelijke success/failure
- [ ] Late orders/open exchange zichtbaar en consistent

## Auth
- [ ] Met ADMIN_TOKEN gezet: zonder token 401
- [ ] Met ADMIN_TOKEN leeg (dev): endpoints toegankelijk

## Support shortcuts
- [ ] Debug endpoint bereikbaar voor unavailable
- [ ] Error hints verwijzen naar juiste vervolgactie
