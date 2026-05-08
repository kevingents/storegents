# Niet leverbaar workflow - Shopify theme code

Deze map bevat de finale Shopify-code voor de werkende niet-leverbaar workflow.

## Backend status
De volgende backendfixes staan in main:
- samengestelde regel-id matching
- Shopify bedrag gebruiken als SRS bedrag 0 is
- debug endpoint voor orderregelmatching
- debugfilter op ordernummer

## Shopify bestanden
Plaats deze bestanden in het Shopify theme:

- `shopify/snippets/gents-niet-leverbaar-modal.liquid` naar `snippets/gents-niet-leverbaar-modal.liquid`
- `shopify/snippets/gents-niet-leverbaar-report-modal.liquid` naar `snippets/gents-niet-leverbaar-report-modal.liquid`
- `shopify/assets/gents-niet-leverbaar-admin.js` naar `assets/gents-niet-leverbaar-admin.js`

## Hoofdsection
Laat de bestaande render staan:

```liquid
{% render 'gents-niet-leverbaar-modal', stores_html: stores_html %}
```

Voeg daaronder toe:

```liquid
{% render 'gents-niet-leverbaar-report-modal', stores_html: stores_html %}
```

Zorg dat deze asset geladen wordt:

```liquid
<script src="{{ 'gents-niet-leverbaar-admin.js' | asset_url }}" defer></script>
```

## Twee admin knoppen
Gebruik twee losse knoppen:

```liquid
<button class="admin-action-card is-urgent" type="button" data-modal-open="admin-unavailable-order-lines">
  <span class="portal-icon">x</span>
  <span>
    <strong>Niet leverbaar verwerken</strong>
    <small>Openstaande regels verwerken: Shopify terugbetaling en SRS Cancel.</small>
  </span>
</button>

<button class="admin-action-card" type="button" data-modal-open="admin-unavailable-report">
  <span class="portal-icon">EUR</span>
  <span>
    <strong>Niet leverbaar rapportage</strong>
    <small>Schade per winkel, verwerkt bedrag en cronstatus.</small>
  </span>
</button>
```

## Testflow
1. Open `Niet leverbaar verwerken`.
2. Vul ordernummer in, bijvoorbeeld `32125`.
3. Klik `Order zoeken in SRS`.
4. Controleer bedrag en Shopify match indien nodig via debug endpoint.
5. Verwerk eerst een enkele regel.
6. Open `Niet leverbaar rapportage` en klik `Rapportage vernieuwen`.
