import test from 'node:test';
import assert from 'node:assert/strict';
import { canTransition } from '../../lib/admin-workqueue/store.js';

test('workflow transitions enforce linear flow', () => {
  assert.equal(canTransition('nieuw', 'in_behandeling'), true);
  assert.equal(canTransition('opgelost', 'in_behandeling'), false);
});
