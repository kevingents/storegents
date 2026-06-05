/**
 * lib/shopify-dispute-handler.js
 *
 * Automatisch bewijs indienen bij Shopify Payments disputes/inquiries.
 *
 * Flow:
 *  1. Haal openstaande disputes op via ShopifyPaymentsDispute GraphQL
 *  2. Match per dispute op order-nummer → zoek de bijbehorende Returnista-retour
 *  3. Bouw evidence-tekst op uit Returnista-data:
 *     - Hoe terugbetaald (store credit = gift card code)
 *     - Of retour is ontvangen (status Arrived/Complete)
 *     - Retour-reden
 *     - Klant-gegevens
 *  4. Dien evidence in via disputeEvidenceUpdate (submit: true = definitief)
 *
 * Vereiste Shopify-scopes:
 *   read_shopify_payments_disputes + write_shopify_payments_disputes
 *
 * Env:
 *   SHOPIFY_STORE_DOMAIN
 *   SHOPIFY_ADMIN_ACCESS_TOKEN
 *   SHOPIFY_API_VERSION
 *   DISPUTE_SUBMIT   0/1 — default 0 (dry-run). Zet op '1' voor live indiening.
 */

const SHOPIFY_API_VERSION = process.env.SHOPIFY_ADMIN_API_VERSION || '2025-01';
const AUTO_SUBMIT = ['1', 'true', 'yes'].includes(String(process.env.DISPUTE_SUBMIT || '0').toLowerCase());

const clean = (v) => String(v == null ? '' : v).trim();

function getShopifyCfg() {
  const domain = clean(process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const token = clean(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_API_TOKEN || '');
  if (!domain || !token) throw new Error('Shopify-credentials ontbreken.');
  return { domain: domain.includes('.myshopify.com') ? domain : `${domain}.myshopify.com`, token };
}

/* REST API helper — voor disputes (eenvoudiger + zeker werkend). */
async function shopifyRest(path, { method = 'GET', body } = {}) {
  const cfg = getShopifyCfg();
  const url = `https://${cfg.domain}/admin/api/${SHOPIFY_API_VERSION}${path}`;
  const opts = {
    method,
    headers: { 'X-Shopify-Access-Token': cfg.token, Accept: 'application/json', 'Content-Type': 'application/json' }
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Shopify REST ${resp.status} ${path}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

/* GraphQL helper — voor evidence-mutaties. */
async function shopifyGql(query, variables = {}) {
  const cfg = getShopifyCfg();
  const resp = await fetch(`https://${cfg.domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': cfg.token, Accept: 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Shopify GQL ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`);
  if (data.errors?.length) throw new Error(`Shopify GQL: ${data.errors.map((e) => e.message).join('; ')}`);
  return data.data || {};
}

/* ─── Disputes ophalen ──────────────────────────────────────────────────── */

/**
 * Haal alle openstaande disputes op die nog bewijs nodig hebben.
 * Status-filter: NEEDS_RESPONSE of UNDER_REVIEW (nog bewijs toevoegen).
 */
/**
 * Haal alle disputes op via Shopify REST API.
 * Eenvoudiger dan GraphQL en werkt met de standaard private-app credentials.
 * Filter: alleen disputes die nog een reactie nodig hebben.
 */
export async function fetchOpenDisputes({ limit = 50 } = {}) {
  /* Haal alle recente disputes op (REST heeft geen status-filter). */
  const data = await shopifyRest(`/shopify_payments/disputes.json?limit=${Math.min(limit, 50)}`);
  const all = Array.isArray(data.disputes) ? data.disputes : [];
  /* Filter client-side op actionable statussen. */
  const actionable = all.filter((d) =>
    ['needs_response', 'under_review'].includes((d.status || '').toLowerCase())
  );
  /* Normaliseer naar consistent shape voor de rest van de code. */
  return actionable.map((d) => ({
    id: String(d.id),                       /* REST geeft numeric ID */
    gid: `gid://shopify/ShopifyPaymentsDispute/${d.id}`, /* voor GQL mutaties */
    type: d.type,
    status: d.status,
    amount: { amount: d.amount, currencyCode: d.currency },
    evidenceDueBy: d.evidence_due_by,
    evidenceSentOn: d.evidence_sent_on,
    initiatedAt: d.initiated_at,
    reasonDetails: { reason: d.reason, networkReasonCode: d.network_reason_code },
    order: d.order_id ? {
      id: `gid://shopify/Order/${d.order_id}`,
      name: `#${d.order_id}`,   /* order-naam wordt apart opgehaald als nodig */
      orderId: d.order_id
    } : null,
    _restSource: true
  }));
}

/* ─── Returnista-bewijs opbouwen ────────────────────────────────────────── */

/**
 * Vind de Returnista return-request(s) die horen bij een Shopify-order.
 * Matcht op meerdere velden omdat Returnista purchaseOrderNumber (kort: '32460')
 * heeft maar de dispute het interne Shopify-ID ('13112189026677') doorgeeft.
 *
 * @param {string} orderName  Order-naam of intern Shopify-ID (bijv '#13112189026677')
 * @param {Array}  allReturnRequests  Genormaliseerde Returnista-records
 * @param {string} [shopifyOrderId]   Intern Shopify order ID (optioneel, voor exacte match)
 */
export async function findReturnistaRetourForOrder(orderName, allReturnRequests, shopifyOrderId) {
  const nr = clean(orderName).replace(/^#/, '').toLowerCase();
  const sid = clean(shopifyOrderId || '').toLowerCase();
  return (allReturnRequests || []).filter((r) => {
    /* Match op kort ordernummer (purchaseOrderNumber / shopifyOrderNr) */
    const rNr = clean(r.purchaseOrderNumber || r.orderNr || r.shopifyOrderNr || '').replace(/^#/, '').toLowerCase();
    /* Match op intern Shopify ID (shopifyOrderId in genormaliseerde data) */
    const rSid = clean(r.shopifyOrderId || '').toLowerCase();
    return (nr && rNr === nr) ||
           (sid && rSid === sid) ||
           (sid && rNr === sid) ||    /* veiligheidsnet: nr === sid format-mismatch */
           (nr && rSid === nr);       /* veiligheidsnet: omgekeerd */
  });
}

/* Vertaal Returnista requestedResolution + resolution naar leesbare tekst. */
function formatResolutionForEvidence(returnItem) {
  const requested = clean(returnItem.requestedResolution || returnItem.resolution || '');
  const resolutionStatus = clean(returnItem.resolutionStatus || returnItem.status || '');
  const isStoreCredit = /credit|gift|tegoed|voucher/i.test(requested);
  const isRefund = /refund|money|terugbetaling|original/i.test(requested);
  const isReceived = /arrive|received|complete|confirm/i.test(resolutionStatus);

  let text = '';
  if (isStoreCredit) {
    text = `De klant heeft bij het aanmaken van de retourneringaanvraag expliciet gekozen voor store credit (cadeaubon/tegoed) als terugbetalingsmethode. Er is geen geldterugboeking gedaan naar de oorspronkelijke betaalmethode — de klant heeft tegoed ontvangen dat bij een volgende bestelling ingewisseld kan worden.`;
  } else if (isRefund) {
    text = `De klant heeft gekozen voor terugbetaling via de oorspronkelijke betaalmethode. Status: ${resolutionStatus}.`;
  } else {
    text = `Retourbeslissing: ${requested}. Status: ${resolutionStatus}.`;
  }
  if (isReceived) {
    text += ` Het geretourneerde artikel is door ons magazijn ontvangen en verwerkt (status: ${resolutionStatus}).`;
  } else {
    text += ` Het retourpakket is nog onderweg of nog niet gescand in ons magazijn (status: ${resolutionStatus}).`;
  }
  return text;
}

/**
 * Bouw de volledige evidence-tekst op die we indienen bij de dispute.
 * Gebruikt Returnista-data als harde feitenbasis.
 */
export function buildEvidenceText({ dispute, returnItems, giftCardInfo = null }) {
  const order = dispute.order || {};
  const customerEmail = order.customer?.email || order.email || '';
  const orderName = order.name || '';
  const amount = dispute.amount?.amount || '';
  const currency = dispute.amount?.currencyCode || 'EUR';
  const disputeReason = dispute.reasonDetails?.reason || '';
  const dueBy = dispute.evidenceDueBy ? new Date(dispute.evidenceDueBy).toLocaleDateString('nl-NL') : 'onbekend';

  let evidence = `GENTS Herenmode — Reactie op dispute / inquiry\n`;
  evidence += `Order: ${orderName} | Bedrag: ${currency} ${amount} | Deadline: ${dueBy}\n`;
  evidence += `Dispute-reden opgegeven door bank: ${disputeReason}\n\n`;

  if (!returnItems || !returnItems.length) {
    /* Geen retour gevonden in Returnista — klant heeft wellicht nooit geretourneerd. */
    evidence += `Na uitgebreide controle van onze retourregistratie hebben wij geen retourverzoek gevonden voor order ${orderName} van klant ${customerEmail}.\n`;
    evidence += `De bestelling is volledig geleverd conform de overeenkomst. Wij verzoeken de bank de dispute af te wijzen.\n`;
  } else {
    evidence += `Retourinformatie uit ons retoursysteem (Returnista):\n\n`;
    for (const item of returnItems) {
      evidence += `Product: ${item.title || item.sku || '—'} (SKU: ${item.sku || '—'})\n`;
      evidence += `Retour aangemeld op: ${item.createdAt ? new Date(item.createdAt).toLocaleDateString('nl-NL') : '—'}\n`;
      evidence += `Status: ${item.status || '—'}\n`;
      evidence += `Gekozen terugbetalingsmethode door klant: ${item.requestedResolution || '—'}\n`;
      if (item.resolution) evidence += `Verwerkte beslissing: ${item.resolution}\n`;
      if (item.resolutionStatus) evidence += `Status beslissing: ${item.resolutionStatus}\n`;
      evidence += `Retour-reden opgegeven door klant: ${item.reason || '—'}\n`;
      evidence += `\n${formatResolutionForEvidence(item)}\n\n`;
    }
    /* Is er store credit gekozen? Leg dit extra uit voor de bank. */
    const hasCreditResolution = returnItems.some((r) => /credit|gift|tegoed|voucher/i.test(r.requestedResolution || r.resolution || ''));
    if (hasCreditResolution) {
      evidence += `BELANGRIJK: De klant heeft bij het retourproces ZELF gekozen voor store credit in plaats van geldterugboeking. `;
      evidence += `Dit is een actieve keuze gemaakt door de klant tijdens het invoeren van de retourverzoek. `;
      evidence += `Wij kunnen niet verantwoordelijk worden gehouden voor een dispute die voortkomt uit een door de klant zelf gemaakte keuze. `;
      if (giftCardInfo) {
        evidence += `De store credit is uitgegeven als Shopify gift card (code: ...${giftCardInfo.lastChars || '????'}, `;
        evidence += `waarde: ${giftCardInfo.balance?.currencyCode || 'EUR'} ${giftCardInfo.balance?.amount || '?'}). `;
        evidence += giftCardInfo.enabled
          ? `Deze gift card is op dit moment nog actief en inlosbaar.`
          : `Deze gift card is inmiddels uitgeschreven na de dispute-melding.`;
      }
      evidence += `\n\nWij verzoeken de bank de dispute af te wijzen omdat de klant al volledig is gecompenseerd conform de door de klant zelf gekozen methode.\n`;
    }
  }

  evidence += `\nGENTS Herenmode | klantenservice@gents.nl | www.gents.nl`;
  return evidence.trim();
}

/* ─── Evidence indienen ─────────────────────────────────────────────────── */

/**
 * Dien evidence in bij een Shopify dispute.
 * Shopify's disputeEvidenceUpdate accepteert het dispute-ID direct —
 * er is geen apart disputeEvidence-object dat je eerst moet ophalen.
 *
 * @param {string} disputeId   De ID van het ShopifyPaymentsDispute (gid://shopify/...)
 * @param {Object} input       Velden voor ShopifyPaymentsDisputeEvidenceUpdateInput
 * @param {boolean} submit     True = definitief indienen bij bank (onomkeerbaar!)
 */
export async function submitDisputeEvidence(disputeId, input, { submit = false } = {}) {
  const id = clean(disputeId);
  if (!id) throw new Error('disputeId verplicht.');

  /* `submit` is een top-level argument op de mutatie, NIET onderdeel van
     ShopifyPaymentsDisputeEvidenceUpdateInput. Aparte variabele meegeven. */
  const mutation = `#graphql
    mutation DisputeEvidenceUpdate($id: ID!, $input: ShopifyPaymentsDisputeEvidenceUpdateInput!, $submit: Boolean) {
      disputeEvidenceUpdate(id: $id, input: $input, submit: $submit) {
        disputeEvidence {
          id
          submitted
          uncategorizedText
          refundRefusalExplanation
          customerEmailAddress
          dispute { id status }
        }
        userErrors { field message }
      }
    }`;
  const data = await shopifyGql(mutation, { id, input, submit });
  const errs = data?.disputeEvidenceUpdate?.userErrors || [];
  if (errs.length) throw new Error(`Evidence update fout: ${errs.map((e) => e.message).join('; ')}`);
  return data?.disputeEvidenceUpdate?.disputeEvidence || null;
}

/* ─── Combined: auto-handle één dispute ────────────────────────────────── */

/**
 * Verwerk één dispute volledig automatisch:
 *   1. Haal Returnista-retouren op voor de bijbehorende order
 *   2. Bouw evidence-tekst
 *   3. Dien in (tenzij dryRun)
 *
 * @param {Object} dispute          ShopifyPaymentsDispute node
 * @param {Array} allReturnRequests Alle Returnista records (al opgehaald)
 * @param {Object} opts
 * @param {boolean} opts.dryRun     Default true (geen mutaties)
 * @param {boolean} opts.submit     Default false — even als dryRun=false: sla op maar dien nog niet in
 * @param {Object} opts.giftCardInfo Optioneel: gift card info voor extra bewijs
 */
export async function handleDispute(dispute, allReturnRequests, opts = {}) {
  const dryRun = opts.dryRun !== false;
  const submit = !dryRun && (opts.submit === true || AUTO_SUBMIT);

  const orderName = dispute.order?.name || '';
  /* orderId = intern Shopify ID dat Returnista opslaat als shopifyOrderId */
  const shopifyOrderId = clean(dispute.order?.orderId || dispute.order?.id?.replace('gid://shopify/Order/', '') || '');
  const customerEmail = dispute.order?.customer?.email || dispute.order?.email || '';

  /* Stap 1: zoek retour in Returnista — match op zowel ordernaam als intern ID. */
  const returnItems = await findReturnistaRetourForOrder(orderName, allReturnRequests, shopifyOrderId);

  /* Stap 2: bouw evidence-tekst. */
  const evidenceText = buildEvidenceText({ dispute, returnItems, giftCardInfo: opts.giftCardInfo });

  /* Evidence-input conform ShopifyPaymentsDisputeEvidenceUpdateInput. */
  const evidenceInput = {
    uncategorizedText: evidenceText,
    customerEmailAddress: customerEmail,
    refundRefusalExplanation: returnItems.some((r) => /credit|gift|tegoed/i.test(r.requestedResolution || ''))
      ? 'De klant heeft bij het retourproces zelf gekozen voor store credit (cadeaubon) in plaats van geldterugboeking. Er is geen directe refund gedaan omdat de klant expliciet voor een andere terugbetalingsvorm heeft gekozen.'
      : undefined
  };

  /* Gebruik het GID (GraphQL ID) voor de evidence-mutatie.
     REST geeft een numeric ID; we bouwen het GID zelf op. */
  const evidenceId = dispute.gid || `gid://shopify/ShopifyPaymentsDispute/${dispute.id}`;

  const result = {
    ok: true,
    dryRun,
    submit,
    disputeId: dispute.id,
    disputeStatus: dispute.status,
    orderName,
    customerEmail,
    returnItemsFound: returnItems.length,
    returnStatuses: returnItems.map((r) => r.status),
    requestedResolutions: returnItems.map((r) => r.requestedResolution || r.resolution),
    evidenceText,
    evidenceInput
  };

  if (dryRun) {
    result.message = `DRY-RUN: zou evidence indienen voor dispute ${dispute.id} (order ${orderName}).`;
    return result;
  }

  if (!evidenceId) {
    result.ok = false;
    result.message = `Geen dispute-ID beschikbaar — kan evidence niet indienen.`;
    return result;
  }

  try {
    const updated = await submitDisputeEvidence(evidenceId, evidenceInput, { submit });
    result.updatedEvidence = updated;
    result.submitted = updated?.submitted || false;
    result.message = submit
      ? `Evidence definitief ingediend bij bank voor dispute ${dispute.id}.`
      : `Evidence opgeslagen als concept (nog niet definitief ingediend) voor dispute ${dispute.id}.`;
  } catch (e) {
    result.ok = false;
    result.message = `Evidence-update faalde: ${e.message}`;
  }

  return result;
}

/* ─── Batch: alle openstaande disputes in 1 run ─────────────────────────── */

/**
 * Verwerk alle openstaande disputes. Vereist dat de Returnista-data al is
 * opgehaald (getReturnRequests) zodat we niet per dispute een API-call doen.
 *
 * @param {Array} allReturnRequests  Van getReturnRequests()
 * @param {Object} opts
 * @param {boolean} opts.dryRun
 * @param {boolean} opts.submit
 * @param {number}  opts.maxDisputes
 */
export async function handleAllOpenDisputes(allReturnRequests, opts = {}) {
  const dryRun = opts.dryRun !== false;
  const maxDisputes = Number(opts.maxDisputes || 50);

  const disputes = await fetchOpenDisputes({ limit: maxDisputes });
  if (!disputes.length) {
    return { ok: true, processed: 0, message: 'Geen openstaande disputes gevonden.' };
  }

  const results = [];
  let successCount = 0, failCount = 0;

  for (const dispute of disputes) {
    try {
      const r = await handleDispute(dispute, allReturnRequests, { ...opts, dryRun });
      results.push(r);
      if (r.ok) successCount += 1;
      else failCount += 1;
    } catch (e) {
      failCount += 1;
      results.push({ ok: false, disputeId: dispute.id, message: e.message });
    }
  }

  return {
    ok: true,
    dryRun,
    totalDisputes: disputes.length,
    processed: results.length,
    success: successCount,
    failed: failCount,
    results
  };
}
