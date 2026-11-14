// /api/users  (admins only: finance@ / chayut.j@)
//   POST ?view=peak-hook&type=quotation|invoice → PEAK webhook (x-api-key = PEAK_WEBHOOK_KEY)
//   GET ?view=health → data health (admins + accounting); ?view=health-cron → daily Chat digest (Vercel cron)
//   GET   → everyone who has signed in, with their role
//   PATCH { email, role?: sales|lead|operation|op|collector|admin, extra?: [perm], team?: 'b2b' | 'b2c' | 'both', salesPerf?: G014 code } → change a user's access
const { checkOrigin, sendError } = require('../lib/session');
const users = require('../lib/users');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const view = new URL(req.url, 'http://x').searchParams.get('view');
    // Daily data-health digest to Google Chat (Vercel cron, see vercel.json). Vercel sends
    // "Authorization: Bearer $CRON_SECRET" when CRON_SECRET is set on the project.
    if (view === 'health-cron') {
      const secret = process.env.CRON_SECRET;
      if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ ok: false });
      const health = require('../lib/health');
      const h = await health.collect();
      const text = health.digest(h);
      const sent = text ? await require('../lib/notify').send(text) : { ok: true, skipped: 'all ok' };
      return res.status(200).json({ ok: true, bad: h.bad, warn: h.warn, sent });
    }
    // PEAK webhook (no login; checked by its x-api-key header). See lib/peakhook.js.
    if (view === 'peak-hook') return await require('../lib/peakhook').handle(req, res);
    const me = await users.requireUser(req);

    if (view === 'health') {
      if (!users.can(me, 'users') && !users.can(me, 'approve')) return res.status(403).json({ ok: false, error: 'เฉพาะผู้ดูแลหรือฝ่ายบัญชี' });
      return res.status(200).json({ ok: true, ...(await require('../lib/health').collect()) });
    }
    if (!users.can(me, 'users')) return res.status(403).json({ ok: false, error: 'เฉพาะผู้ดูแลสิทธิ์' });
    if (req.method === 'GET') {
      const [list, salesPerf] = await Promise.all([users.list(), require('../lib/hub').readSalesPerf()]);
      return res.status(200).json({ ok: true, users: list, salesPerf, chat: require('../lib/notify').configured(), roles: users.ROLES.map((r) => ({ id: r, label: users.ROLE_LABEL[r], perms: users.ROLE_PERMS[r] })), perms: users.PERMS });
    }
    if (req.method === 'PATCH') {
      checkOrigin(req);
      const b = req.body || {};
      if (b.action === 'test_chat') {
        const r = await require('../lib/notify').send(`✅ ทดสอบการแจ้งเตือนจาก Globish Sales Desk โดย ${me.name || me.email}`);
        return res.status(200).json({ ok: true, chat: r });
      }
      if (b.action === 'test_peak') {
        const r = await require('../lib/peak').testConnection(String(b.taxId || '').replace(/\D/g, '').slice(0, 13));
        await require('../lib/hub').log('catalog', 'peak_test', '', `${me.email} · ${r.ok ? 'ok' : r.error}`).catch(() => {});
        return res.status(200).json({ ok: true, peak: r });
      }
      await users.setRole(me, b.email, { role: b.role, team: b.team, salesPerf: b.salesPerf, extra: b.extra });
      return res.status(200).json({ ok: true });
    }
    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    sendError(res, e);
  }
};
