// GET /api/services?code=3822 → the PEAK service for a Whitehouse Package ID or PEAK service code.
//   { ok, found, code, name, group, inactive }  — the form shows the PEAK name (read-only), so the
//   name on the QT always comes from PEAK, not from what sales typed.

const { sendError } = require('../lib/session');
const { requireUser } = require('../lib/users');
const hub = require('../lib/hub');

let cache = null; // { at, map } per instance, 5 min
async function services() {
  if (cache && Date.now() - cache.at < 300e3) return cache.map;
  cache = { at: Date.now(), map: await hub.readServices() };
  return cache.map;
}

function lookup(map, code) {
  const c = String(code || '').trim().toUpperCase();
  const s = map.get(c);
  if (!s) return { found: false, code: c };
  return { found: true, code: s.code, name: s.name, group: s.group, inactive: s.proposal.startsWith('ปิดใช้งาน') };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });
    await requireUser(req);
    const code = new URL(req.url, 'http://x').searchParams.get('code') || '';
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(code)) return res.status(400).json({ ok: false, error: 'รหัสไม่ถูกต้อง' });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, ...lookup(await services(), code) });
  } catch (e) {
    return sendError(res, e);
  }
};

module.exports.services = services;
module.exports._test = { lookup };
