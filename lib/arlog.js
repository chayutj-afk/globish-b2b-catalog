// Work log for the debt page: who logged a follow-up, changed a commit date or recorded money in.
// Read only. Follow-ups come from the FollowUps tab (it has the note and the commit date the customer gave);
// everything else from SyncLog, joined to the Invoices tab for the customer and the amount.
const hub = require('./hub');
const { stamp } = require('./history');

const num = (v) => { const n = Number(String(v || '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
const up = (s) => String(s || '').trim().toUpperCase();
// FollowUps imported from the old sheet may carry a date without a time.
const when = (s) => stamp(s) || stamp(String(s || '').trim().slice(0, 10) + ' 00:00');
const FIELD = { commitDate: 'วันนัดจ่าย', paidDate: 'วันที่เงินเข้า', paidAmount: 'ยอดรับเงิน', paymentMethod: 'วิธีชำระ', rtNo: 'เลขใบเสร็จ', rtDate: 'วันที่ใบเสร็จ', delayReason: 'เหตุที่จ่ายช้า', whtRate: 'หัก ณ ที่จ่าย', docStatus: 'สถานะเอกสาร', note: 'หมายเหตุ', commitAtPaid: '', followStatus: '', nextActionDate: '' };

// type: follow | paid | commit | notice | reject | rt | edit | owner
function build({ log, fus, invs, pays, users }) {
  const names = new Map(users.map((u) => [String(u.email).toLowerCase(), u.name || String(u.email).split('@')[0]]));
  const roles = new Map(users.map((u) => [String(u.email).toLowerCase(), u.role]));
  const roleByName = new Map(users.map((u) => [String(u.name || '').toLowerCase(), u.role]));
  const ROLE = { op: 'บัญชี', admin: 'Admin', collector: 'ตามหนี้', lead: 'หัวหน้าเซล' };
  const inv = new Map(invs.map((r) => [up(r.ivNo), r]));
  const payOf = new Map(pays.map((p) => [up(p.noticeId), p]));
  const out = [];
  const add = (at, type, label, ivNo, by, role, o = {}) => {
    const ts = when(at); if (!ts) return;
    const r = inv.get(up(ivNo)) || {};
    out.push({ at: String(at).trim(), ts, type, label, ivNo, company: r.company || o.company || '', segment: r.segment || '', by, role, ...o });
  };
  for (const f of fus) {
    add(f.loggedAt, 'follow', 'บันทึกการติดตาม', f.ivNo, f.by || '-', ROLE[roleByName.get(String(f.by || '').toLowerCase())] || '',
      { channel: f.channel, result: f.result, note: f.note, commitDate: f.commitDate, next: f.nextActionDate });
  }
  for (const l of log) {
    const d = String(l.detail || '');
    const m = /^([^\s·]+@[^\s·]+)(?:\s·\s([\s\S]*))?$/.exec(d);
    const email = m ? m[1].toLowerCase() : '', rest = m ? (m[2] || '') : d;
    const by = email ? (names.get(email) || email.split('@')[0]) : 'ระบบ', role = email ? (ROLE[roles.get(email)] || 'Sales') : 'อัตโนมัติ';
    const row = inv.get(up(l.reference)) || {};
    if (l.event === 'ar_update') {
      const fields = rest.split(',').map((x) => x.trim()).filter(Boolean);
      if (fields.includes('paidDate')) add(l.at, 'paid', 'บันทึกรับเงิน', l.reference, by, role, { amount: num(row.paidAmount), paidDate: row.paidDate, method: row.paymentMethod });
      else if (fields.length === 1 && fields[0] === 'commitDate') add(l.at, 'commit', 'แก้วันนัดจ่าย', l.reference, by, role, { commitDate: row.commitDate });
      else add(l.at, 'edit', 'แก้ข้อมูล INV', l.reference, by, role, { note: fields.map((x) => (x in FIELD ? FIELD[x] : x)).filter(Boolean).join(', ') });
    } else if (l.event === 'ar_partial') {
      add(l.at, 'paid', 'บันทึกรับเงินบางส่วน', l.reference, by, role, { amount: num(rest.split(' · ')[0]), note: rest.split(' · ').slice(1).join(' · ') });
    } else if (l.event === 'pay_confirm' || l.event === 'pay_reject' || l.event === 'pay_notice') {
      const p = payOf.get(up(l.reference)) || {};
      const iv = p.ivNo || (rest.split(' · ')[0] || '');
      if (l.event === 'pay_confirm') add(l.at, 'paid', /บางส่วน/.test(rest) ? 'ยืนยันรับเงินบางส่วน (เซลแจ้ง)' : 'ยืนยันรับเงิน (เซลแจ้ง)', iv, by, role, { amount: num(p.amount), paidDate: p.paidDate, method: p.paymentMethod, company: p.company });
      else if (l.event === 'pay_reject') add(l.at, 'reject', 'ตีกลับแจ้งรับเงิน', iv, by, role, { note: rest, amount: num(p.amount), company: p.company });
      else add(l.at, 'notice', 'เซลแจ้งว่าลูกค้าจ่ายแล้ว', iv, by, role, { amount: num(p.amount), paidDate: p.paidDate, company: p.company });
    } else if (l.event === 'ar_owner') add(l.at, 'owner', 'เปลี่ยนเซลเจ้าของ', l.reference, by, role, { note: rest });
    else if (l.event === 'rt_live_draft' || l.event === 'rt_from_inv') add(l.at, 'rt', l.event === 'rt_live_draft' ? 'สร้างใบเสร็จ Draft' : 'ออกใบเสร็จแล้ว', l.reference, by, role, { note: rest });
    else if (l.source === 'peak-webhook' && /^invoice_/.test(l.event) && /^paid/.test(d)) add(l.at, 'paid', 'รับเงินครบใน PEAK', l.reference, 'PEAK', 'แจ้งอัตโนมัติ', { amount: num(row.paidAmount), paidDate: row.paidDate, method: row.paymentMethod });
  }
  out.sort((a, b) => b.ts - a.ts);
  return { entries: out };
}

async function load() {
  const c = { cache: 30e3 };
  const [log, fus, invs, pays, users] = await Promise.all(['SyncLog', 'FollowUps', 'Invoices', 'PaymentNotices', 'Users'].map((t) => hub.readTable(t, c)));
  return build({ log, fus, invs, pays, users });
}

module.exports = { build, load };
