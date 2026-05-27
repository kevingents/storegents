/**
 * KPI-source: customers_with_bon — nieuwe klanten met bon-koppeling.
 *
 * Status: stub. Wire-up: filter customers-new resultaat op aanwezigheid van
 * gekoppelde transactie (transactionId/bonNr in SRS-customer-payload).
 */
export default async function compute() {
  return { value: null, meta: { status: 'not-implemented' } };
}
