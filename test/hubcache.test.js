const test = require('node:test');
const assert = require('node:assert');

// Stub the Google client: count the calls that reach "Google".
test('sheet reads: shared for GET requests, fresh for writes, retried on 429', async () => {
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'x@y'; process.env.GOOGLE_PRIVATE_KEY = 'k'; process.env.HUB_SHEET_ID = 'sheet';
  const prevMode = process.env.HUB_MODE; delete process.env.HUB_MODE;
  require('google-auth-library'); const mod = require.cache[require.resolve('google-auth-library')];
  const calls = []; let fail429 = 0;
  const orig = mod.exports;
  const Stub = class { async request(o) { calls.push(`${o.method} ${decodeURIComponent(o.url.split('/sheet')[1])}`); if (fail429 > 0) { fail429--; const e = new Error('Quota exceeded'); e.response = { status: 429 }; throw e; } await new Promise((r) => setTimeout(r, 5)); return { data: { values: [['a@globish.co.th', 'A']], valueRanges: [] } }; } };
  mod.exports = { JWT: Stub };
  delete require.cache[require.resolve('../lib/hub')];
  const hub = require('../lib/hub');
  const get = { method: 'GET', headers: {} };
  try {
    // six parallel calls of one page load → one read
    await hub.scope(get, () => Promise.all([1, 2, 3, 4, 5, 6].map(() => hub.readTable('Users'))));
    assert.equal(calls.length, 1, 'parallel GET reads share one call');
    await hub.scope(get, () => hub.readTable('Users'));
    assert.equal(calls.length, 1, 'a GET a moment later reuses it');
    // a request that changes data always reads fresh
    await hub.scope({ method: 'PATCH', headers: {} }, () => hub.readTable('Users'));
    assert.equal(calls.length, 2, 'PATCH reads fresh');
    // right after the user's own change the page asks for fresh data
    await hub.scope({ method: 'GET', headers: { 'x-fresh': '1' } }, () => hub.readTable('Users'));
    assert.equal(calls.length, 3, 'x-fresh reads fresh');
    // outside any request (cron, sync) → fresh
    await hub.readTable('Users');
    assert.equal(calls.length, 4);
    // 429 → waits and tries again
    fail429 = 1; const t = Date.now();
    const rows = await hub.scope({ method: 'POST', headers: {} }, () => hub.readTable('Users'));
    assert.equal(rows.length, 1); assert.equal(calls.length, 6); assert.ok(Date.now() - t >= 1900, 'waited before the retry');
  } finally { mod.exports = orig; if (prevMode) process.env.HUB_MODE = prevMode; delete require.cache[require.resolve('../lib/hub')]; }
});
