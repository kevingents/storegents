function normalizeMoney(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? amount : 0;
}

export function extractGiftCardUsages(order) {
  const usages = [];

  const directGiftCards = Array.isArray(order.gift_cards) ? order.gift_cards : [];
  directGiftCards.forEach((giftCard) => {
    usages.push({
      source: 'gift_cards',
      giftCardId: giftCard.id || giftCard.admin_graphql_api_id || giftCard.gift_card_id || '',
      lastCharacters: giftCard.last_characters || giftCard.lastCharacters || '',
      amount: normalizeMoney(giftCard.amount || giftCard.initial_value || giftCard.balance),
      raw: giftCard
    });
  });

  const transactions = Array.isArray(order.transactions) ? order.transactions : [];
  transactions
    .filter((transaction) => String(transaction.gateway || '').toLowerCase().includes('gift'))
    .forEach((transaction) => {
      usages.push({
        source: 'transactions',
        giftCardId: transaction.payment_details?.gift_card_id || transaction.receipt?.gift_card_id || '',
        lastCharacters:
          transaction.payment_details?.gift_card_last_digits ||
          transaction.payment_details?.gift_card_last_characters ||
          transaction.receipt?.gift_card_last_digits ||
          transaction.receipt?.gift_card_last_characters ||
          '',
        amount: normalizeMoney(transaction.amount),
        raw: transaction
      });
    });

  const paymentGatewayNames = Array.isArray(order.payment_gateway_names) ? order.payment_gateway_names : [];
  const usedGiftCardGateway = paymentGatewayNames.some((name) => String(name || '').toLowerCase().includes('gift'));

  if (!usages.length && usedGiftCardGateway) {
    usages.push({
      source: 'payment_gateway_names',
      giftCardId: '',
      lastCharacters: '',
      amount: 0,
      raw: { payment_gateway_names: paymentGatewayNames }
    });
  }

  return usages;
}
