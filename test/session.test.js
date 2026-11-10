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

test('admins are chayut.j@ and finance@ by default; everyone else starts as sales', () => {
  assert.equal(s.isAdmin('chayut.j@globish.co.th'), true);
  assert.equal(s.isAdmin('Finance@globish.co.th'), true);
  assert.equal(s.roleFor('finance@globish.co.th'), 'op');
  assert.equal(s.roleFor('someone@globish.co.th'), 'sales');
});

test('roles from the Users tab: default sales, admins fixed, only admins can change roles', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  process.env.HUB_MODE = 'mock';
  process.env.HUB_MOCK_FILE = path.join(os.tmpdir(), `users-test-${process.pid}.json`);
  fs.writeFileSync(process.env.HUB_MOCK_FILE, '{}');
  const users = require('../lib/users');
  await users.touch('new.sales@globish.co.th', 'New');
  assert.equal(await users.roleOf('new.sales@globish.co.th'), 'sales');
  const admin = { email: 'finance@globish.co.th', admin: true };
  await users.setRole(admin, 'new.sales@globish.co.th', 'op');
  assert.equal(await users.roleOf('new.sales@globish.co.th'), 'op');
  await assert.rejects(users.setRole({ email: 'x@globish.co.th', admin: false }, 'new.sales@globish.co.th', 'sales'), /ผู้ดูแลสิทธิ์/);
  await assert.rejects(users.setRole(admin, 'chayut.j@globish.co.th', 'sales'), /เปลี่ยนไม่ได้/);
  await assert.rejects(users.setRole(admin, 'nobody@globish.co.th', 'op'), /ไม่พบ/);
  await users.touch('new.sales@globish.co.th', 'New Name'); // re-login keeps the role
  assert.equal(await users.roleOf('new.sales@globish.co.th'), 'op');
  assert.equal((await users.list()).length, 1);
  fs.unlinkSync(process.env.HUB_MOCK_FILE);
});

test('middleware verifier accepts Node-signed cookies', async () => {
  const { verifySession } = await import('../middleware.js');
  const token = s.sign({ email: 'a@globish.co.th', name: 'A', role: 'sales', exp: Date.now() + 1e6 });
  assert.equal((await verifySession(token, process.env.AUTH_SECRET, 'globish.co.th')).email, 'a@globish.co.th');
  assert.equal(await verifySession(token + 'x', process.env.AUTH_SECRET, 'globish.co.th'), null);
});
