// /api/users  (admins only: finance@ / chayut.j@)
//   POST ?view=peak-hook&type=quotation|invoice → PEAK webhook (x-api-key = PEAK_WEBHOOK_KEY)
//   GET ?view=health → data health (admins + accounting); ?view=health-cron → daily Chat digest (Vercel cron)
//   GET   → everyone who has signed in, with their role
//   PATCH { email, role?: sales|lead|operation|op|collector|admin, extra?: [perm], team?: 'b2b' | 'b2c' | 'both', classItems?: { G014: code } } → change a user's access
//   PATCH { action: 'classes', group, mode: segment|seller|off, segments?: { B2B: item } } → how a PEAK classification group is picked
const { checkOrigin, sendError } = require('../lib/session');
const users = require('../lib/users');

// Classification groups from PEAK + how the app picks each one. Without the PEAK API the rules still show,
// with the items the rules name (and the old Sales Performance list in Lists!K for sellers).
async function classView(list) {
  const cr = require('../lib/classrules');
  const rules = await cr.load(list);
  let groups, live = true, error = '';
  try { groups = await cr.peakGroups(); }
  catch (e) {
    live = false; error = String(e.message).slice(0, 160);
    const perf = await require('../lib/hub').readSalesPerf().catch(() => []);
    groups = Object.keys(rules).map((code) => ({ code, name: code === 'G014' ? 'Sales Performance' : code, items: code === 'G014' ? perf : [...new Set([...Object.values(rules[code].segments), ...Object.values(rules[code].users)])].map((c) => ({ code: c, name: c })) }));
  }
  groups = groups.map((g) => ({ ...g, mode: (rules[g.code] || {}).mode || 'off', segments: (rules[g.code] || {}).segments || {} }));
  return { rules, groups, live, error, segments: cr.SEGMENTS };
}

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
      const list = await users.list();
      const classes = await classView(list);
      for (const u of list) u.classItems = Object.fromEntries(Object.entries(classes.rules).filter(([, r]) => r.mode === 'seller').map(([g, r]) => [g, r.users[u.email.toLowerCase()] || '']));
      return res.status(200).json({ ok: true, users: list, classes: { live: classes.live, error: classes.error, groups: classes.groups, segments: classes.segments }, chat: require('../lib/notify').configured(), roles: users.ROLES.map((r) => ({ id: r, label: users.ROLE_LABEL[r], perms: users.ROLE_PERMS[r] })), perms: users.PERMS });
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
      if (b.action === 'classes') {
        await require('../lib/classrules').saveGroup(String(b.group || ''), { mode: b.mode, segments: b.segments }, await users.list(), me.email);
        return res.status(200).json({ ok: true });
      }
      if (b.classItems && typeof b.classItems === 'object') {
        await require('../lib/classrules').saveUser(String(b.email || '').toLowerCase(), b.classItems, await users.list(), me.email);
      }
      const access = { role: b.role, team: b.team, extra: b.extra };
      if (Object.values(access).some((v) => v !== undefined)) await users.setRole(me, b.email, access);
      return res.status(200).json({ ok: true });
    }
    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    sendError(res, e);
  }
};
