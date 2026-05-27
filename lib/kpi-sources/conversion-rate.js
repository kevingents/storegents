/**
 * KPI-source: conversion_rate — % Shopify-sessies dat resulteert in order.
 *
 * STATUS: stub. Wire-up gids:
 *   - Shopify Analytics API geeft sessions per dag.
 *   - Orders/dag uit Shopify GraphQL Admin API (zie lib/shopify-products-cache.js patroon).
 *   - Conversie = orders / sessions × 100.
 *
 * Scope = 'global' (online), dus store-parameter is hier niet relevant.
 */
export default async function compute(/* ctx */) {
  return { value: null, meta: { status: 'not-implemented', hint: 'Implement via Shopify Analytics API + GraphQL orders' } };
}
