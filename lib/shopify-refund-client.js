function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'ja'].includes(String(value).toLowerCase());
}

function getShopifyConfig() {
  const shop = process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || '';
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || '';
  const version = process.env.SHOPIFY_API_VERSION || '2025-01';
  if (!shop || !token) throw new Error('SHOPIFY_STORE_DOMAIN en/of SHOPIFY_ADMIN_ACCESS_TOKEN ontbreken.');
  return { shop: shop.replace(/^https?:\/\//, '').replace(/\/$/, ''), token, version };
}

async function shopifyFetch(path, options = {}) {
  const { shop, token, version } = getShopifyConfig();
  const response = await fetch(`https://${shop}/admin/api/${version}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_error) { data = { message: text }; }
  if (!response.ok) throw new Error(data.errors || data.message || `Shopify fout ${response.status}`);
  return data;
}

export async function findShopifyOrderByName(orderNr) {
  const clean = String(orderNr || '').trim().replace(/^#/, '');
  const data = await shopifyFetch(`/orders.json?name=%23${encodeURIComponent(clean)}&status=any&limit=1`, { method: 'GET' });
  return data.orders?.[0] || null;
}

export async function refundShopifyCancellation({ cancellation }) {
  const liveEnabled = boolEnv('SHOPIFY_REFUND_LIVE_ENABLED', false);
  const maxAmount = Number(process.env.MAX_AUTO_REFUND_AMOUNT || 250);
  const amount = Number(cancellation.amount || 0);

  if (!liveEnabled) {
    return {
      success: true,
      dryRun: true,
      message: 'Dry-run: Shopify refund niet live uitgevoerd. Zet SHOPIFY_REFUND_LIVE_ENABLED=true om live refunds toe te staan.'
    };
  }

  if (amount > maxAmount) {
    throw new Error(`Refundbedrag ${amount} is hoger dan MAX_AUTO_REFUND_AMOUNT ${maxAmount}. Handmatige controle vereist.`);
  }

  const order = await findShopifyOrderByName(cancellation.orderNr);
  if (!order) throw new Error('Shopify order niet gevonden voor refund.');

  // Bewust veilig: deze client bereidt nog geen geldtransactie voor zolang SRS live annuleren niet definitief is.
  // Na bevestiging van de exacte SRS actie kan hier Shopify refundCreate/refunds.json worden ingevuld.
  return {
    success: true,
    dryRun: true,
    shopifyOrderId: order.id,
    message: 'Shopify order gevonden. Refund staat nog in veilige dry-run totdat SRS live annulering definitief is getest.'
  };
}
