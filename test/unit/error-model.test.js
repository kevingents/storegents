import test from 'node:test';
import assert from 'node:assert/strict';
import { mapUpstreamError } from '../../lib/api-error.js';

test('mapUpstreamError produces uniform payload', () => {
  const out = mapUpstreamError({ endpoint: '/api/x', source: 'shopify_admin_api', error: new Error('timeout') });
  assert.equal(out.success, false);
  assert.equal(out.retryable, true);
  assert.match(out.message, /bron niet beschikbaar/);
});
