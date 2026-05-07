export function parseShopifyTags(value) {
  return String(value || '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function mergeShopifyTags(currentTags = [], tagsToAdd = []) {
  const byLowercase = new Map();

  [...currentTags, ...tagsToAdd].forEach((tag) => {
    const cleanTag = String(tag || '').trim();
    if (cleanTag) byLowercase.set(cleanTag.toLowerCase(), cleanTag);
  });

  return Array.from(byLowercase.values());
}

export async function addTagsToShopifyOrder({ order, tags = [], shopifyRequest }) {
  if (!order?.id) throw new Error('Shopify order id ontbreekt voor tag update.');
  if (typeof shopifyRequest !== 'function') throw new Error('Shopify request helper ontbreekt voor tag update.');

  const currentTags = parseShopifyTags(order.tags);
  const nextTags = mergeShopifyTags(currentTags, tags);

  if (nextTags.length === currentTags.length) {
    return { success: true, skipped: true, tags: currentTags };
  }

  const updated = await shopifyRequest(`/orders/${order.id}.json`, {
    method: 'PUT',
    body: JSON.stringify({
      order: {
        id: order.id,
        tags: nextTags.join(', ')
      }
    })
  });

  return { success: true, tags: nextTags, order: updated.order || updated };
}
