/**
 * KPI-source: conversion_rate — % Shopify-sessies dat resulteert in een order.
 *
 * STATUS: pending — vereist Shopify Analytics-scope (read_analytics).
 *
 * Implementatieplan wanneer scope beschikbaar is:
 *   1. ShopifyQL query via /admin/api/{ver}/graphql.json:
 *      {
 *        shopifyqlQuery(query: """
 *          FROM sessions
 *          SHOW count
 *          WHERE created_at >= '{fromDate}' AND created_at <= '{toDate}'
 *          GROUP BY day
 *        """) { ... }
 *      }
 *   2. Aparte query voor orders count.
 *   3. value = (orders / sessions) × 100
 *
 * Tijdelijke fallback: orders/day uit ShopifyQL FROM orders (geen sessies-
 * scope nodig), waarmee we de KPI als 'orders per dag' kunnen tonen zonder
 * conversion. Dit is informatief maar niet de echte conversie.
 *
 * Scope = 'global' — store-parameter wordt genegeerd.
 */
export default async function compute({ fromDate, toDate } = {}) {
  return {
    value: null,
    meta: {
      status: 'not-implemented',
      hint: 'Vereist Shopify read_analytics scope + ShopifyQL queries voor sessions + orders.',
      fromDate,
      toDate,
      enableSteps: [
        '1. App permissions in Shopify Admin → Add read_analytics scope',
        '2. Re-authorise + nieuwe access_token',
        '3. Implement ShopifyQL query in lib/shopify-analytics-client.js',
        '4. Update deze fetcher: orders ÷ sessions × 100'
      ]
    }
  };
}
