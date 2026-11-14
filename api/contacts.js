// /api/contacts?taxId=0105555555554&branch=00000
//   GET → PEAK contacts with that tax ID, straight from PEAK (the only source of customers).
//   The 13-digit tax ID + branch is the customer key; the form uses this to fill the PEAK
//   contact code and company name. matches = that branch (or every branch when none is given),
//   otherBranches = the rest. No PEAK API (PEAK_MODE off / PEAK down) → 503, the form lets Sales
//   type the branch and accounting checks on approval.

const { sendError } = require('../lib/session');
const { requireUser } = require('../lib/users');
const { normBranch } = require('../lib/taxid');
const peak = require('../lib/peak');

function split(all, branch) {
  const matches = branch ? all.filter((c) => c.branch === branch) : all;
  return { matches, otherBranches: all.filter((c) => !matches.includes(c)) };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
    await requireUser(req);
    const url = new URL(req.url, 'http://x');
    const taxId = String(url.searchParams.get('taxId') || '').replace(/\D/g, '');
    if (!/^\d{13}$/.test(taxId)) return res.status(400).json({ error: 'ต้องเป็นเลข 13 หลัก' });
    const branch = url.searchParams.get('branch') ? normBranch(url.searchParams.get('branch')) : '';
    if (branch === null) return res.status(400).json({ error: 'สาขาต้องเป็น 5 หลัก' });
    res.setHeader('Cache-Control', 'no-store');
    if (peak.mode() === 'off') return res.status(503).json({ error: 'ยังไม่ได้เปิดการเชื่อมต่อ PEAK API ค้นหาลูกค้าไม่ได้' });
    let all;
    try { all = (await peak.findContacts(taxId)).map((c) => ({ code: c.code, name: c.name, branch: c.branchCode || '00000' })); }
    catch (e) { return res.status(503).json({ error: `ค้นหาลูกค้าใน PEAK ไม่ได้ตอนนี้ (${String(e.message).slice(0, 120)})` }); }
    return res.status(200).json({ ...split(all, branch), source: 'peak' });
  } catch (e) {
    sendError(res, e);
  }
};

module.exports._test = { split };
