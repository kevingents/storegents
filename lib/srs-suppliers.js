/**
 * lib/srs-suppliers.js
 *
 * SRS heeft (in de webservices die wij gebruiken) geen los "GetSuppliers".
 * De PurchaseOrders-respons bevat wél per order een Supplier{Id,Name}. We leiden
 * de bekende leveranciers daarom af uit de PO-historie over een ruim venster en
 * dedupliceren op SRS-id (fallback: naam).
 *
 * Gebruikt voor: leverancier-picker vullen + eenmalig importeren naar de lokale
 * leveranciers-store (zodat je e-mail/contactgegevens kunt toevoegen).
 */

import { getPurchaseOrders } from './srs-purchase-orders-client.js';

const clean = (v) => String(v == null ? '' : v).trim();

/**
 * @param {Object} [opts]
 * @param {number} [opts.days=365]  hoe ver terug we PO's scannen voor leveranciers
 * @returns {Promise<{success, count, suppliers:[{id,name,orders,lastOrderDate}]}>}
 */
export async function getSrsSuppliersFromHistory({ days = 365 } = {}) {
  const result = await getPurchaseOrders({ days, status: 'all' });
  const byKey = new Map();
  for (const order of result.orders || []) {
    const id = clean(order.supplier?.id);
    const name = clean(order.supplier?.name);
    if (!id && !name) continue;
    const key = id || name.toLowerCase();
    const prev = byKey.get(key) || { id, name, orders: 0, lastOrderDate: '' };
    prev.orders += 1;
    if (name && !prev.name) prev.name = name;
    if (id && !prev.id) prev.id = id;
    const od = clean(order.orderDate);
    if (od && od > prev.lastOrderDate) prev.lastOrderDate = od;
    byKey.set(key, prev);
  }
  const suppliers = Array.from(byKey.values())
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'nl'));
  return { success: true, days, count: suppliers.length, suppliers };
}
