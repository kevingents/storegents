import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateImpactScore } from '../../lib/impact-score.js';

test('calculateImpactScore returns high priority for severe input', () => {
  const out = calculateImpactScore({ lateOrders: 4, lateDragers: 1, lateExchanges: 2, openUnavailable: 3, openIssues: 2, slaBucket: '>72h', revenueRisk: 5000 });
  assert.equal(out.priorityLevel, 'hoog');
  assert.ok(out.impactScore > 90);
});
