function getShopifyConfig() {
  const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN || process.env.SHOPIFY_STORE_DOMAIN || '';
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN || '';
  const apiVersion = process.env.SHOPIFY_API_VERSION || '2026-01';

  if (!shopDomain || !token) {
    throw new Error('SHOPIFY_SHOP_DOMAIN en/of SHOPIFY_ADMIN_ACCESS_TOKEN ontbreken.');
  }

  return {
    endpoint: `https://${shopDomain.replace(/^https?:\/\//, '')}/admin/api/${apiVersion}/graphql.json`,
    token
  };
}

async function shopifyGraphql(query, variables = {}) {
  const { endpoint, token } = getShopifyConfig();

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token
    },
    body: JSON.stringify({ query, variables })
  });

  const data = await response.json();

  if (!response.ok || data.errors) {
    throw new Error(data.errors?.[0]?.message || `Shopify fout: ${response.status}`);
  }

  return data.data;
}

export async function findShopifyCustomerByEmail(email) {
  if (!email) return null;

  const data = await shopifyGraphql(
    `query FindCustomer($query: String!) {
      customers(first: 1, query: $query) {
        nodes { id email firstName lastName displayName }
      }
    }`,
    { query: `email:${email}` }
  );

  return data.customers?.nodes?.[0] || null;
}

export async function createShopifyGiftCard({ code, amount, currencyCode = 'EUR', expiresOn, note, customerEmail }) {
  const customer = customerEmail ? await findShopifyCustomerByEmail(customerEmail) : null;

  const input = {
    initialValue: {
      amount: String(amount || '0.00'),
      currencyCode
    },
    code,
    note: note || 'SRS voucher aangemaakt via winkelportaal'
  };

  if (expiresOn) input.expiresOn = expiresOn;
  if (customer?.id) input.customerId = customer.id;

  const data = await shopifyGraphql(
    `mutation GiftCardCreate($input: GiftCardCreateInput!) {
      giftCardCreate(input: $input) {
        giftCard {
          id
          maskedCode
          lastCharacters
          initialValue { amount currencyCode }
          balance { amount currencyCode }
          expiresOn
          enabled
        }
        userErrors { field message }
      }
    }`,
    { input }
  );

  const errors = data.giftCardCreate?.userErrors || [];
  if (errors.length) throw new Error(errors.map((error) => error.message).join(', '));

  return { giftCard: data.giftCardCreate.giftCard, customer };
}


export async function deactivateShopifyGiftCard(giftCardId) {
  if (!giftCardId) {
    throw new Error('Shopify gift card ID ontbreekt.');
  }

  const data = await shopifyGraphql(
    `mutation GiftCardDeactivate($id: ID!) {
      giftCardDeactivate(id: $id) {
        giftCard {
          id
          deactivatedAt
          enabled
        }
        userErrors {
          field
          message
          code
        }
      }
    }`,
    { id: giftCardId }
  );

  const errors = data.giftCardDeactivate?.userErrors || [];

  if (errors.length) {
    throw new Error(errors.map((error) => error.message).join(', '));
  }

  return data.giftCardDeactivate.giftCard;
}

