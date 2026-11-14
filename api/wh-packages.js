// POST /api/wh-packages  (Accountant / Admin) { rows: [{ id, packageName, type, product, privateClass,
//   freeTalk, discussion, realwork, months, extras, status }] }
// GET → { count, updatedAt } of the current tab.
// Rebuilds the Revenue Hub "WHPackages" tab (only packages that are PEAK service codes): what each Whitehouse package includes, used to write the
// customer-readable line descriptions on QT/INV. Sent from /import-wh (handed over by the Whitehouse tab).
const { checkOrigin, sendError } = require('../lib/session');
const { requireUser } = require('../lib/users');
const hub = require('../lib/hub');

const MAX_ROWS = 20000;
function cleanRows(list) {
  const text = (v, n) => String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, n);
  const int = (v) => { const x = Math.floor(Number(v)); return Number.isFinite(x) && x >= 0 && x < 100000 ? x : 0; };
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    const id = text(x && x.id, 12);
    if (!/^\d{1,8}$/.test(id)) continue;
    out.push({
      id, packageName: text(x.packageName, 200), type: text(x.type, 20), product: text(x.product, 200),
      privateClass: int(x.privateClass), freeTalk: int(x.freeTalk), discussion: int(x.discussion), realwork: int(x.realwork),
      months: int(x.months), extras: text(x.extras, 40).replace(/[^A-Z+]/g, ''), status: text(x.status, 4),
    });
  }
  return out;
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      await requireUser(req, { perm: 'import' });
      const rows = await hub.readTable('WHPackages');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, count: rows.length, updatedAt: rows.reduce((m, r) => (r.updatedAt > m ? r.updatedAt : m), '') });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });
    checkOrigin(req);
    const user = await requireUser(req, { perm: 'import' });
    const b = req.body || {};
    if (!Array.isArray(b.rows) || !b.rows.length || b.rows.length > MAX_ROWS) return res.status(400).json({ error: `ต้องมี rows 1–${MAX_ROWS} แถว` });
    const now = hub.sheetDateTime();
    // All Whitehouse packages are kept: the QT form checks each Package ID in PEAK itself.
    const rows = cleanRows(b.rows).map((r) => ({ ...r, updatedAt: now }));
    if (!rows.length) return res.status(400).json({ error: 'ไม่มีแถวที่ใช้ได้' });
    await hub.replaceTable('WHPackages', rows);
    await hub.log('wh-import', 'wh_packages_replaced', 'Whitehouse', `${user.email} · ${rows.length} rows`);
    return res.status(200).json({ ok: true, written: rows.length });
  } catch (e) {
    return sendError(res, e);
  }
};

module.exports._test = { cleanRows };
