// /api/contacts?taxId=0105555555554&branch=00000
//   GET → PEAK contacts with that tax ID, from the Revenue Hub "PeakContacts" tab.
//   The 13-digit tax ID + branch is the customer key; the form uses this to fill the
//   PEAK contact code and company name.
//
// POST /api/contacts  (Operation only) { rows: [{taxId, branch, code, name, type}], source }
//   Rebuilds the PeakContacts tab from a PEAK contact export (parsed in the browser on
//   /import-contacts). Keeps only rows with a 13-digit tax ID.

const { checkOrigin, sendError } = require('../lib/session');
const { requireUser } = require('../lib/users');
const { normBranch } = require('../lib/taxid');
const hub = require('../lib/hub');

let cache = null; // { at, rows } per instance, 60 s
async function contacts() {
  if (cache && Date.now() - cache.at < 60e3) return cache.rows;
  const rows = await hub.readTable('PeakContacts');
  cache = { at: Date.now(), rows };
  return rows;
}

function match(rows, taxId, branch) {
  const digits = (s) => String(s || '').replace(/\D/g, '');
  const all = rows
    .filter((r) => digits(r.taxId) === taxId)
    .map((r) => ({ code: r.code, name: r.name, branch: normBranch(r.branch) || '00000' }));
  const sameBranch = branch ? all.filter((r) => r.branch === branch) : all;
  return { matches: sameBranch, otherBranches: all.filter((r) => !sameBranch.includes(r)) };
}

const MAX_ROWS = 20000;
function cleanRows(list) {
  const text = (v, n) => String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, n);
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    const taxId = String((x && x.taxId) || '').replace(/\D/g, '');
    if (taxId.length !== 13) continue;
    const code = text(x.code, 20);
    if (!code) continue;
    out.push({ taxId, branch: normBranch(x.branch) || '00000', code, name: text(x.name, 200), type: text(x.type, 40) });
  }
  return out;
}

async function importRows(req, res) {
  checkOrigin(req);
  const user = await requireUser(req, { role: 'op' });
  const b = req.body || {};
  if (!Array.isArray(b.rows) || b.rows.length > MAX_ROWS) return res.status(400).json({ error: `ต้องมี rows ไม่เกิน ${MAX_ROWS} แถว` });
  const now = hub.sheetDateTime();
  const source = String(b.source || 'PEAK export').slice(0, 120);
  const rows = cleanRows(b.rows).map((r) => ({ ...r, source, updatedAt: now }));
  await hub.replaceTable('PeakContacts', rows);
  cache = null;
  await hub.log('contacts-import', 'peak_contacts_replaced', source, `${user.email} · ${rows.length} rows`);
  return res.status(200).json({ ok: true, written: rows.length });
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'POST') return await importRows(req, res);
    if (req.method !== 'GET') return res.status(405).json({ error: 'GET or POST only' });
    await requireUser(req);
    const url = new URL(req.url, 'http://x');
    const taxId = String(url.searchParams.get('taxId') || '').replace(/\D/g, '');
    if (!/^\d{13}$/.test(taxId)) return res.status(400).json({ error: 'ต้องเป็นเลข 13 หลัก' });
    const branch = url.searchParams.get('branch') ? normBranch(url.searchParams.get('branch')) : '';
    if (branch === null) return res.status(400).json({ error: 'สาขาต้องเป็น 5 หลัก' });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(match(await contacts(), taxId, branch));
  } catch (e) {
    return sendError(res, e);
  }
};

module.exports._test = { match, cleanRows };
