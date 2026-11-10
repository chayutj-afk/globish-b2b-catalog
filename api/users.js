// /api/users  (admins only: finance@ / chayut.j@)
//   GET   → everyone who has signed in, with their role
//   PATCH { email, role: 'sales' | 'op' } → change a user's role
const { checkOrigin, sendError } = require('../lib/session');
const users = require('../lib/users');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const me = await users.requireUser(req);
    if (!me.admin) return res.status(403).json({ ok: false, error: 'เฉพาะผู้ดูแลสิทธิ์ (finance@ / chayut.j@)' });
    if (req.method === 'GET') return res.status(200).json({ ok: true, users: await users.list() });
    if (req.method === 'PATCH') {
      checkOrigin(req);
      const b = req.body || {};
      await users.setRole(me, b.email, b.role);
      return res.status(200).json({ ok: true });
    }
    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    sendError(res, e);
  }
};
