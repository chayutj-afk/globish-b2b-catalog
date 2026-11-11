// /api/users  (admins only: finance@ / chayut.j@)
//   GET   → everyone who has signed in, with their role
//   PATCH { email, role?: 'sales' | 'op', team?: 'b2b' | 'b2c' | 'both', salesPerf?: G014 code } → change a user's access
const { checkOrigin, sendError } = require('../lib/session');
const users = require('../lib/users');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const me = await users.requireUser(req);
    if (!me.admin) return res.status(403).json({ ok: false, error: 'เฉพาะผู้ดูแลสิทธิ์ (finance@ / chayut.j@)' });
    if (req.method === 'GET') {
      const [list, salesPerf] = await Promise.all([users.list(), require('../lib/hub').readSalesPerf()]);
      return res.status(200).json({ ok: true, users: list, salesPerf, chat: require('../lib/notify').configured() });
    }
    if (req.method === 'PATCH') {
      checkOrigin(req);
      const b = req.body || {};
      if (b.action === 'test_chat') {
        const r = await require('../lib/notify').send(`✅ ทดสอบการแจ้งเตือนจาก Globish Sales Desk โดย ${me.name || me.email}`);
        return res.status(200).json({ ok: true, chat: r });
      }
      await users.setRole(me, b.email, { role: b.role, team: b.team, salesPerf: b.salesPerf });
      return res.status(200).json({ ok: true });
    }
    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    sendError(res, e);
  }
};
