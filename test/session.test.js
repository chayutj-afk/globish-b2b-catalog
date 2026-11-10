const test = require('node:test');
const assert = require('node:assert');
process.env.AUTH_SECRET = 'x'.repeat(40);
process.env.OPS_EMAILS = 'ops@globish.co.th';
const s = require('../lib/session');

test('cookie round-trips and rejects tampering', () => {
  const { header } = s.issue('Sales@globish.co.th', 'Sales');
  const token = decodeURIComponent(header.split(';')[0].split('=')[1]);
  const p = s.verify(token);
  assert.equal(p.email, 'sales@globish.co.th');
  assert.equal(p.role, 'sales');
  assert.equal(s.verify(token.slice(0, -2) + 'aa'), null);
  const [b64, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ email: 'x@globish.co.th', exp: Date.now() + 1e6 })).toString('base64url') + '.' + sig;
  assert.equal(s.verify(forged), null);
});

test('other domains and expired sessions are refused', () => {
  assert.equal(s.verify(s.sign({ email: 'a@gmail.com', exp: Date.now() + 1e6 })), null);
  assert.equal(s.verify(s.sign({ email: 'a@globish.co.th', exp: Date.now() - 1 })), null);
});

test('operation role comes from env', () => {
  assert.equal(s.roleFor('ops@globish.co.th'), 'op');
  assert.equal(s.roleFor('chayut.j@globish.co.th'), 'op');
  assert.equal(s.roleFor('someone@globish.co.th'), 'sales');
});

test('middleware verifier accepts Node-signed cookies', async () => {
  const { verifySession } = await import('../middleware.js');
  const token = s.sign({ email: 'a@globish.co.th', name: 'A', role: 'sales', exp: Date.now() + 1e6 });
  assert.equal((await verifySession(token, process.env.AUTH_SECRET, 'globish.co.th')).email, 'a@globish.co.th');
  assert.equal(await verifySession(token + 'x', process.env.AUTH_SECRET, 'globish.co.th'), null);
});
