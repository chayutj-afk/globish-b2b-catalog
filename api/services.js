// GET /api/services?type=G012-00003 → PEAK service groups for that customer type (live from PEAK when the API is on).
// GET /api/services?code=3822 → the PEAK service for a Whitehouse Package ID or PEAK service code.
//   { ok, found, code, name, group, inactive }  — the form shows the PEAK name (read-only), so the
//   name on the QT always comes from PEAK, not from what sales typed.

const { sendError } = require('../lib/session');
const { requireUser } = require('../lib/users');
const hub = require('../lib/hub');
const { describeWh, describeKeyHS, heroName } = require('../lib/pricing');

let whCache = null; // { at, map } per instance, 5 min
async function whPackages() {
  if (whCache && Date.now() - whCache.at < 300e3) return whCache.map;
  whCache = { at: Date.now(), map: new Map((await hub.readTable('WHPackages')).map((x) => [String(x.id), x])) };
  return whCache.map;
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });
    await requireUser(req);
    res.setHeader('Cache-Control', 'no-store');
    // ?keyHS=… → the name and first line the QT will use for a customized package.
    const sp = new URL(req.url, 'http://x').searchParams;
    if (sp.get('keyHS')) {
      const k = String(sp.get('keyHS')).slice(0, 400), lang = sp.get('lang') === 'EN' ? 'EN' : 'TH';
      const name = heroName(k, lang);
      return res.status(200).json({ ok: true, name, heading: name ? describeKeyHS(k, { lang }).split('\n')[0] : '' });
    }
    // ?type=G012-00003 → the PEAK service groups that customer type picks from (e.g. B2S + Assessment).
    if (sp.get('type')) {
      const t = (await require('../lib/types').list()).find((x) => x.code === sp.get('type'));
      if (!t || !t.svcGroups.length) return res.status(200).json({ ok: true, groups: [] });
      const peak = require('../lib/peak');
      if (peak.mode() === 'off') return res.status(503).json({ ok: false, error: 'ยังไม่ได้เปิดการเชื่อมต่อ PEAK API' });
      return res.status(200).json({ ok: true, source: 'peak', groups: await peak.servicesForGroups(t.svcGroups) });
    }
    const code = new URL(req.url, 'http://x').searchParams.get('code') || '';
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(code)) return res.status(400).json({ ok: false, error: 'รหัสไม่ถูกต้อง' });
    res.setHeader('Cache-Control', 'no-store');
    // The code is checked in PEAK itself; the name always comes from PEAK.
    const peak = require('../lib/peak');
    if (peak.mode() === 'off') return res.status(503).json({ ok: false, error: 'ยังไม่ได้เปิดการเชื่อมต่อ PEAK API' });
    const s2 = await peak.getServiceByCode(code);
    const out = s2 ? { found: true, code: s2.code, name: s2.name, inactive: false, source: 'peak' } : { found: false, code: code.toUpperCase(), source: 'peak' };
    // Preview of the line text the QT will carry (from the WHPackages tab) so sales see it before sending.
    if (out.found) {
      try {
        const wh = (await whPackages()).get(out.code.replace(/_.*$/, ''));
        const lang = new URL(req.url, 'http://x').searchParams.get('lang') === 'EN' ? 'EN' : 'TH';
        if (wh) { out.preview = describeWh(wh, { lang, title: out.name, code: out.code }); }
      } catch (e) { console.error('WHPackages read failed', e); }
    }
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return sendError(res, e);
  }
};

