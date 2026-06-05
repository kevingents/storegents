/**
 * lib/shopify-refund-from-credit.js
 *
 * Customer-service automatisering: een klant heeft via Returnista voor
 * "store credit" gekozen (Shopify gift card) maar wil alsnog cash refund.
 *
 * De flow per inquiry:
 *   1. Resolve klant + order + gift card uit Shopify
 *   2. Safety-checks (order leeftijd, balance, refund-eligibility)
 *   3. Disable de gift card (balance → 0 via giftCardDeactivate)
 *   4. Maak een refund-transactie tegen de oorspronkelijke betaalmethode
 *   5. Returnt resultaat-rapport voor logging in customer-inquiries-store
 *
 * Gebruikt Shopify Admin GraphQL API (2024-10+). Vereist scopes:
 *   read_customers, read_orders, write_gift_cards, write_orders, write_refunds
 *
 * Veiligheids-defaults (override via env):
 *   MAX_AUTO_REFUND_EUR   = 250 (boven dit bedrag is admin-bevestiging vereist)
 *   MAX_ORDER_AGE_DAYS    = 100 (Shopify weigert refund > 100 dagen oude orders)
 *   MIN_GIFT_CARD_AGE_HOURS = 0 (geen min)
 */

const SHOPIFY_API_VERSION = process.env.SHOPIFY_ADMIN_API_VERSION || '2025-01';
const MAX_AUTO_REFUND_EUR = Number(process.env.STORE_CREDIT_MAX_AUTO_REFUND_EUR || 250);
const MAX_ORDER_AGE_DAYS = Number(process.env.STORE_CREDIT_MAX_ORDER_AGE_DAYS || 100);

const clean = (v) => String(v == null ? '' : v).trim();

function getShopifyConfig() {
  const domain = clean(process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const token = clean(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_API_TOKEN || '');
  if (!domain || !token) throw new Error('Shopify-credentials ontbreken (SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_ACCESS_TOKEN).');
  const fullDomain = domain.includes('.myshopify.com') ? domain : `${domain}.myshopify.com`;
  return { domain: fullDomain, token, version: SHOPIFY_API_VERSION };
}

async function gql(query, variables = {}, { timeoutMs = 25000 } = {}) {
  const cfg = getShopifyConfig();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`https://${cfg.domain}/admin/api/${cfg.version}/graphql.json`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': cfg.token,
        Accept: 'application/json'
      },
      body: JSON.stringify({ query, variables })
    });
    const text = await resp.text();
    let data = {};
    try { data = JSON.parse(text); } catch { /* leave empty */ }
    if (!resp.ok) throw new Error(`Shopify GraphQL ${resp.status}: ${text.slice(0, 300)}`);
    if (Array.isArray(data.errors) && data.errors.length) {
      throw new Error(`Shopify GraphQL fout: ${data.errors.map((e) => e.message).join('; ')}`);
    }
    return data.data || {};
  } finally { clearTimeout(timer); }
}

/* ─── Lookups ──────────────────────────────────────────────────────────── */

/**
 * Vind een order op naam (#1234 of 1234). Returnt id, name, total, datums,
 * transacties die refund-eligible zijn, en custom-shop-side info.
 */
export async function lookupOrderByName(orderName) {
  const name = clean(orderName).replace(/^#/, '');
  if (!name) return null;
  const query = `#graphql
    query OrderByName($q: String!) {
      orders(first: 5, query: $q) {
        edges { node {
          id
          name
          processedAt
          createdAt
          displayFinancialStatus
          totalPriceSet { presentmentMoney { amount currencyCode } }
          currentTotalPriceSet { presentmentMoney { amount currencyCode } }
          customer { id email firstName lastName }
          transactions {
            id
            kind
            status
            gateway
            amountSet { presentmentMoney { amount currencyCode } }
            parentTransaction { id }
          }
          refunds {
            id
            createdAt
            totalRefundedSet { presentmentMoney { amount currencyCode } }
          }
        } }
      }
    }`;
  const data = await gql(query, { q: `name:#${name} OR name:${name}` });
  const edges = data?.orders?.edges || [];
  return edges[0]?.node || null;
}

/**
 * Zoek gift cards van een klant (email). Voor MVP filteren we op recent
 * uitgegeven (Returnista-creatie gebruikt meestal 90 dagen geldigheid).
 * Returnt array van { id, lastChars, balance, currency, enabled, createdAt }.
 */
export async function findGiftCardsForCustomer(email) {
  const e = clean(email).toLowerCase();
  if (!e) return [];
  /* Customer lookup eerst om de customer.id te krijgen, dan giftCards via
     query-filter. */
  const custQuery = `#graphql
    query CustByEmail($q: String!) {
      customers(first: 1, query: $q) {
        edges { node { id email firstName lastName } }
      }
    }`;
  const custData = await gql(custQuery, { q: `email:${e}` });
  const customer = custData?.customers?.edges?.[0]?.node || null;
  if (!customer) return [];

  /* Gift cards: query="customer_id:..." werkt in Shopify Admin search. */
  const numericCustId = String(customer.id).replace('gid://shopify/Customer/', '');
  const gcQuery = `#graphql
    query GcByCust($q: String!) {
      giftCards(first: 25, query: $q) {
        edges { node {
          id
          lastCharacters
          maskedCode
          enabled
          createdAt
          expiresOn
          initialValue { amount currencyCode }
          balance { amount currencyCode }
          note
          customer { id email }
        } }
      }
    }`;
  const data = await gql(gcQuery, { q: `customer_id:${numericCustId}` });
  const cards = (data?.giftCards?.edges || []).map((edge) => edge.node);
  return { customer, cards };
}

/* ─── Mutations ────────────────────────────────────────────────────────── */

/**
 * Disable een gift card (balance → 0). Shopify ondersteunt 2 manieren:
 *   - giftCardDeactivate (oudere) - markeert kaart als disabled
 *   - giftCardCreditOff (nieuwer 2024-04+) - bookt een credit-off voor het volle saldo
 *
 * Voor MVP gebruiken we giftCardDeactivate (universeel beschikbaar). De
 * kaart blijft bestaan maar balance kan niet meer worden ingewisseld.
 */
export async function disableGiftCard(giftCardId) {
  const id = clean(giftCardId);
  if (!id) throw new Error('giftCardId verplicht.');
  const mutation = `#graphql
    mutation Deactivate($id: ID!) {
      giftCardDeactivate(input: { id: $id }) {
        giftCard { id enabled balance { amount currencyCode } }
        userErrors { field message }
      }
    }`;
  const data = await gql(mutation, { id });
  const errs = data?.giftCardDeactivate?.userErrors || [];
  if (errs.length) throw new Error(`Gift card disable faalde: ${errs.map((e) => e.message).join('; ')}`);
  return data?.giftCardDeactivate?.giftCard || null;
}

/**
 * Bouw een refund voor 1 order met een specifiek bedrag, terug naar de
 * oorspronkelijke betaalmethode. Voor MVP: full-monetary refund zonder
 * line-items (transactie-only). De klant ontvangt automatisch een mail
 * tenzij notify=false.
 */
export async function createRefundForOrder(orderId, amount, { currencyCode = 'EUR', notify = true, note = '' } = {}) {
  const id = clean(orderId);
  if (!id) throw new Error('orderId verplicht.');
  const eur = Number(amount);
  if (!Number.isFinite(eur) || eur <= 0) throw new Error('Bedrag verplicht en > 0.');

  /* Stap 1: vind een refund-eligible parent-transaction (sale/capture). */
  const txData = await gql(`#graphql
    query OrderTx($id: ID!) {
      order(id: $id) {
        id
        transactions {
          id kind status gateway
          amountSet { presentmentMoney { amount currencyCode } }
          parentTransaction { id }
        }
      }
    }`, { id });
  const txs = txData?.order?.transactions || [];
  /* Pak laatste succesvolle SALE/CAPTURE als parent voor de refund. */
  const refundable = txs.filter((t) => (t.kind === 'sale' || t.kind === 'capture') && t.status === 'success');
  if (!refundable.length) throw new Error('Geen refund-eligible transactie gevonden op deze order.');
  const parent = refundable[refundable.length - 1];
  const gateway = clean(parent.gateway);

  /* Stap 2: voer de refund uit via refundCreate. */
  const mutation = `#graphql
    mutation Refund($input: RefundInput!) {
      refundCreate(input: $input) {
        refund {
          id
          createdAt
          totalRefundedSet { presentmentMoney { amount currencyCode } }
        }
        userErrors { field message }
      }
    }`;
  const input = {
    orderId: id,
    notify,
    note: clean(note) || 'Cash refund i.p.v. store credit (op verzoek van klant).',
    transactions: [{
      orderId: id,
      parentId: parent.id,
      amount: eur.toFixed(2),
      gateway,
      kind: 'REFUND'
    }]
  };
  const data = await gql(mutation, { input });
  const errs = data?.refundCreate?.userErrors || [];
  if (errs.length) throw new Error(`Refund faalde: ${errs.map((e) => e.message).join('; ')}`);
  return data?.refundCreate?.refund || null;
}

/* ─── Combined flow ────────────────────────────────────────────────────── */

/**
 * Volledige flow: store credit → cash refund.
 *
 * @param {Object} opts
 * @param {string} opts.email          Klant-email (verplicht)
 * @param {string} [opts.orderName]    Order-nummer (#1234) — sterk aanbevolen
 * @param {string} [opts.giftCardId]   Specifieke gift card; default = laatste actieve
 * @param {boolean} [opts.dryRun=true] Default DRY-RUN — geen Shopify-mutaties
 * @param {boolean} [opts.allowAutoLarge=false] Override MAX_AUTO_REFUND_EUR
 * @param {string} [opts.resolvedBy]   Admin-id voor logging
 */
export async function processStoreCreditToCashRefund(opts = {}) {
  const email = clean(opts.email).toLowerCase();
  if (!email) throw new Error('email verplicht.');
  const dryRun = opts.dryRun !== false;

  /* Stap 1: vind klant + gift cards. */
  const lookup = await findGiftCardsForCustomer(email);
  if (!lookup || !lookup.customer) {
    return { ok: false, reason: `Geen Shopify-klant gevonden voor ${email}.` };
  }
  const allCards = lookup.cards || [];
  if (!allCards.length) {
    return { ok: false, reason: `Geen gift cards gevonden voor ${email}.` };
  }

  /* Filter: alleen enabled cards met balance > 0. */
  const activeCards = allCards.filter((gc) => gc.enabled && Number(gc.balance?.amount || 0) > 0);
  if (!activeCards.length) {
    return { ok: false, reason: 'Alle gift cards van deze klant zijn al gebruikt of disabled.' };
  }

  /* Pak de specifieke card of de laatste actieve. */
  let targetCard;
  if (opts.giftCardId) {
    targetCard = activeCards.find((gc) => gc.id === opts.giftCardId);
    if (!targetCard) return { ok: false, reason: `Gift card ${opts.giftCardId} niet gevonden of niet actief.` };
  } else {
    targetCard = activeCards.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  }
  const refundAmount = Number(targetCard.balance?.amount || 0);
  const currency = clean(targetCard.balance?.currencyCode) || 'EUR';

  /* Stap 2: vind de gerelateerde order (voor refund-transaction). */
  let order = null;
  if (opts.orderName) {
    order = await lookupOrderByName(opts.orderName);
    if (!order) return { ok: false, reason: `Order ${opts.orderName} niet gevonden in Shopify.` };
  } else {
    return {
      ok: false,
      reason: 'orderName verplicht — refund moet aan een specifieke order gekoppeld zijn voor terugboeking.',
      requiresInput: ['orderName']
    };
  }

  /* Stap 3: safety-checks. */
  const checks = [];
  /* (a) Order leeftijd. */
  const orderAgeDays = order.processedAt ? (Date.now() - new Date(order.processedAt).getTime()) / (24 * 3600 * 1000) : null;
  if (orderAgeDays !== null && orderAgeDays > MAX_ORDER_AGE_DAYS) {
    checks.push({ failed: true, reason: `Order is ${Math.round(orderAgeDays)} dagen oud (>${MAX_ORDER_AGE_DAYS}) — Shopify weigert refund.` });
  } else {
    checks.push({ ok: true, msg: `Order leeftijd ${Math.round(orderAgeDays || 0)}d (limit ${MAX_ORDER_AGE_DAYS}d).` });
  }
  /* (b) Email match — voorkom verwarring tussen klanten. */
  if (clean(order.customer?.email).toLowerCase() !== email) {
    checks.push({ failed: true, reason: `Order-email (${order.customer?.email}) komt niet overeen met ${email}.` });
  } else {
    checks.push({ ok: true, msg: `Klant-email klopt.` });
  }
  /* (c) Max auto-refund bedrag. */
  if (refundAmount > MAX_AUTO_REFUND_EUR && !opts.allowAutoLarge) {
    checks.push({ failed: true, reason: `Bedrag €${refundAmount.toFixed(2)} > drempel €${MAX_AUTO_REFUND_EUR} — admin-bevestiging vereist (allowAutoLarge=true).` });
  } else {
    checks.push({ ok: true, msg: `Bedrag €${refundAmount.toFixed(2)} binnen auto-grens.` });
  }
  /* (d) Refund-eligible transactie. */
  const refundable = (order.transactions || []).filter((t) => (t.kind === 'sale' || t.kind === 'capture') && t.status === 'success');
  if (!refundable.length) {
    checks.push({ failed: true, reason: 'Geen refund-eligible sale/capture transactie op deze order.' });
  } else {
    checks.push({ ok: true, msg: `Refund-eligible: ${refundable[refundable.length - 1].gateway}.` });
  }

  const failures = checks.filter((c) => c.failed);
  if (failures.length) {
    return {
      ok: false,
      reason: `Safety-check(s) gefaald: ${failures.map((f) => f.reason).join(' · ')}`,
      checks,
      preview: {
        customer: lookup.customer,
        giftCard: { id: targetCard.id, lastChars: targetCard.lastCharacters, balance: targetCard.balance },
        order: { id: order.id, name: order.name, total: order.totalPriceSet?.presentmentMoney }
      }
    };
  }

  /* Stap 4: dry-run preview of echte uitvoer. */
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      message: `DRY-RUN — zou €${refundAmount.toFixed(2)} terugboeken naar ${order.transactions[refundable.length - 1]?.gateway} en gift card ${targetCard.lastCharacters} disablen.`,
      preview: {
        customer: lookup.customer,
        order: { id: order.id, name: order.name, total: order.totalPriceSet?.presentmentMoney },
        giftCard: { id: targetCard.id, lastChars: targetCard.lastCharacters, balance: targetCard.balance },
        refundAmount,
        currency
      },
      checks
    };
  }

  /* Stap 5: echte uitvoer. Volgorde: refund eerst (= belangrijkste financiële
     actie), gift card disable daarna (= cleanup). Bij failure tijdens disable
     krijgen we wel een refund maar de gift card blijft staan — bewust risico
     (klant heeft sowieso z'n geld). */
  const result = { ok: true, refund: null, giftCardDisable: null };
  try {
    result.refund = await createRefundForOrder(order.id, refundAmount, {
      currencyCode: currency,
      notify: true,
      note: `Klant verzocht cash refund i.p.v. store credit (was: gift card ${targetCard.lastCharacters}). Inquiry door ${opts.resolvedBy || 'admin'}.`
    });
  } catch (e) {
    return { ok: false, reason: `Refund-mutatie faalde: ${e.message}`, checks };
  }
  try {
    result.giftCardDisable = await disableGiftCard(targetCard.id);
  } catch (e) {
    result.giftCardDisableError = e.message;
    /* Niet ok-false: refund is gelukt, gift card moet handmatig in admin. */
  }
  return {
    ...result,
    summary: {
      refundedAmount: refundAmount,
      currency,
      orderName: order.name,
      giftCardId: targetCard.id,
      giftCardLastChars: targetCard.lastCharacters,
      customerEmail: lookup.customer.email
    },
    checks
  };
}
