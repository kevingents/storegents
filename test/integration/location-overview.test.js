import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../../api/admin/dashboard/location-overview.js';

test('location overview returns enriched payload', async () => {
  process.env.ALLOW_EMPTY_UPSTREAM = '1';
  const req = { method: 'GET', headers: { 'x-admin-token': process.env.ADMIN_TOKEN || '12345' }, query: {}, url: '/api/admin/dashboard/location-overview' };
  let code = 0; let payload;
  const res = { setHeader() {}, status(v) { code = v; return this; }, json(v) { payload = v; return this; }, end() {} };
  await handler(req, res);
  assert.equal(code, 200);
  assert.ok(payload.scoreConfig);
  assert.ok(Array.isArray(payload.rows));
  if (payload.rows.length) {
    assert.ok('workflowStatus' in payload.rows[0]);
    assert.ok('actions' in payload.rows[0]);
  }
});
