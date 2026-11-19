// Accounts receivable (replaces the "[B2B] Debt Follow Up Sheet").
// Invoices tab = one row per issued INV (A–Z inputs, AA–AN ARRAYFORMULAs, AO+ inputs).
// FollowUps tab = one row per collection contact (email / SMS / call / ...).
// The page computes due date, AR state and aging itself so it works in mock mode and right after a write,
// with the same rules as the sheet formulas.

const hub = require('./hub');

const VAT = 0.07;
// INVs issued before this day are the old book carried over from the Debt sheet (2023–2025). They are kept
// apart from the current receivables, the forecast and the checks: many are disputed or no longer active.
const CURRENT_FROM = Date.UTC(2026, 0, 1);
const DOC_STATUS = ['Active', 'Cancelled', 'Replaced'];
const PAY_METHODS = ['Bank Transfer', 'Cheque', 'Cash', 'Credit/Debit Card', 'Others'];
const CHANNELS = ['Email', 'SMS', 'Call', 'LINE', 'Vendor portal', 'Visit'];
// Legacy "สถานะการติดตาม" values, kept so collectors use the same words.
const LEGACY_CHECK = 'ตรวจสถานะกับ PEAK (ข้อมูลเก่า)';
const FOLLOW = ['ระบุวันจ่ายได้แล้ว', 'ติดต่อได้ ยังไม่มีกำหนดวันจ่ายชัดเจน', 'ติดต่อไม่ได้', 'รอเอกสาร / PO จากลูกค้า', 'Hold โครงการ', 'ยกเลิกเอกสาร'];
const DELAY = ['Process ช้า (บ.ใหญ่)', 'รอ PO', 'เอกสารไม่ครบ/แก้เอกสาร', 'ลืมจ่าย/ตกหล่น', 'ปัญหาการเงินลูกค้า', 'ไม่พอใจบริการ', 'อื่นๆ'];

const TH_MON = { 'ม.ค.': 1, 'ก.พ.': 2, 'มี.ค.': 3, 'เม.ย.': 4, 'พ.ค.': 5, 'มิ.ย.': 6, 'ก.ค.': 7, 'ส.ค.': 8, 'ก.ย.': 9, 'ต.ค.': 10, 'พ.ย.': 11, 'ธ.ค.': 12 };

// Date as UTC midnight ms. Accepts dd/mm/yyyy[ hh:mm], yyyy-mm-dd, "9 พ.ย. 2026", Buddhist years.
function parseDate(s) {
  s = String(s || '').trim();
  if (!s) return null;
  let d, m, y;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (r) [y, m, d] = [+r[1], +r[2], +r[3]];
  else if ((r = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s))) [d, m, y] = [+r[1], +r[2], +r[3]];
  else if ((r = /^(\d{1,2})\s+(\S+)\s+(\d{4})/.exec(s)) && TH_MON[r[2]]) [d, m, y] = [+r[1], TH_MON[r[2]], +r[3]];
  else return null;
  if (y < 100) y += 2000;
  if (y > 2400) y -= 543;
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  return Date.UTC(y, m - 1, d);
}
const DAY = 86400e3;
const fmt = (ms) => { if (ms === null || ms === undefined) return ''; const t = new Date(ms); const p = (x) => String(x).padStart(2, '0'); return `${p(t.getUTCDate())}/${p(t.getUTCMonth() + 1)}/${t.getUTCFullYear()}`; };
const todayMs = () => { const t = new Date(Date.now() + 7 * 3600e3); return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()); };
const num = (v) => { const n = Number(String(v ?? '').replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : 0; };
const rate = (v) => { const s = String(v ?? '').trim(); if (!s) return 0; const n = num(s); return s.includes('%') || n >= 1 ? n / 100 : n; };
// Week ends on Thursday (legacy cut-off).
const thu = (ms) => { if (ms === null) return null; const wd = new Date(ms).getUTCDay(); return ms + (((4 - wd) % 7) + 7) % 7 * DAY; };
// Cash week, the same as the Debt sheet's "Week Mapping": Friday to Thursday, cut at the month end.
// A week ends on the next Thursday or on the last day of the month, whichever comes first.
const weekEnd = (ms) => { if (ms === null || ms === undefined) return null; const d = new Date(ms); return Math.min(thu(ms), Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)); };
const weekStart = (end) => { const d = new Date(end); const back = ((d.getUTCDay() - 4 + 7) % 7) || 7; return Math.max(end - back * DAY + DAY, Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); };

// Withholding tax the customer deducts: the rate on an INV as a whole percent (0, 1, 2, 3, 5), and what
// should arrive in the bank at a given rate (pre-VAT + VAT - WHT on the pre-VAT amount).
const WHT_RATES = ['0', '1', '2', '3', '5'];
const whtPct = (r) => Math.round(rate(r.whtRate) * 100);
const expectedAt = (r, pct) => { const pre = num(r.preVat); return Math.round((pre + pre * VAT - pre * (Number(pct) || 0) / 100) * 100) / 100; };
// '' / undefined = not given (keep what the INV has). Returns null, or the percent as a string.
const whtIn = (v) => { const s = String(v ?? '').trim(); if (!s) return null; if (!WHT_RATES.includes(s)) { const e = new Error('เลือกหัก ณ ที่จ่าย (ไม่หัก / 1% / 2% / 3% / 5%)'); e.status = 400; throw e; } return s; };

// Adds the computed fields the page and the API need.
function enrich(r, today = todayMs()) {
  const issue = parseDate(r.issueDate);
  const term = num(r.creditTermDays);
  const due = issue === null ? null : issue + term * DAY;
  const pre = num(r.preVat);
  const expectedFull = Math.round((pre + pre * VAT - pre * rate(r.whtRate)) * 100) / 100;
  const paid = parseDate(r.paidDate);
  const closed = r.docStatus === 'Cancelled' || r.docStatus === 'Replaced';
  const state = closed ? 'Closed' : paid !== null ? 'Paid' : due !== null && today > due ? 'Overdue' : 'Outstanding';
  const daysOver = state === 'Overdue' ? Math.round((today - due) / DAY) : 0;
  const aging = state === 'Outstanding' ? 'Not due' : state !== 'Overdue' ? '' : daysOver <= 30 ? '1-30' : daysOver <= 60 ? '31-60' : daysOver <= 90 ? '61-90' : '90+';
  const commit = parseDate(r.commitDate);
  const open = state === 'Outstanding' || state === 'Overdue';
  // Paid in more than one round: money already confirmed on an INV that is still open. What is still owed
  // (expected) is the rest; expectedFull keeps the whole amount. Once the INV is closed, expected is the whole again.
  // (A receipt issued ahead / a cheque also leaves an amount on an open INV, with rtDate set: that is 'await cash', not a round.)
  const received = open && !r.rtDate ? Math.round(num(r.paidAmount) * 100) / 100 : 0;
  const expected = received > 0 ? Math.max(0, Math.round((expectedFull - received) * 100) / 100) : expectedFull;
  // The forecast date: the date the customer committed to, or the due date while there is none.
  const plan = commit !== null ? commit : due;
  // What the customer had promised before paying (the commit date itself moves to the paid date).
  const promised = state === 'Paid' ? parseDate(r.commitAtPaid || r.commitDate) : null;
  return {
    ...r,
    legacyCheck: open && r.followStatus === LEGACY_CHECK,
    // A receipt exists (issued ahead, or a cheque was collected) but the money has not reached the bank yet.
    awaitCash: open && !(received > 0) && !!(r.rtDate || r.rtNo),
    partial: received > 0, received, expectedFull,
    dueDate: fmt(due), expected, state, daysOverdue: daysOver, aging,
    cycleDays: paid !== null && issue !== null ? Math.round((paid - issue) / DAY) : '',
    forecastWeek: open ? fmt(weekEnd(plan)) : '',
    paidWeek: state === 'Paid' ? fmt(weekEnd(paid)) : '',
    old: issue !== null && issue < CURRENT_FROM,
    noCommit: open && commit === null,
    // Open and the forecast date has passed: the collector has to get a new date from the customer.
    needCommit: open && plan !== null && plan < today,
    promisedDate: state === 'Paid' ? fmt(promised) : '',
    paidVsCommit: promised !== null && paid !== null ? Math.round((paid - promised) / DAY) : '',
    issueMs: issue, dueMs: due, paidMs: paid, planMs: open ? weekEnd(plan) : null, paidWeekMs: state === 'Paid' ? weekEnd(paid) : null,
  };
}

// Money in: the commit date moves to the paid date, so the forecast and the cash-in fall in the same week.
// The date the customer had promised is kept in commitAtPaid (paid before or after the promise).
function onPaid(row, paidDate) { return { commitDate: paidDate, commitAtPaid: row.commitAtPaid || row.commitDate || '' }; }
// A payment read from PEAK. PEAK's date is the date on the receipt, which is not always the day the money came
// in: a receipt issued ahead carries a future date, and a cheque carries the day it was collected. Those two wait
// for accounting to confirm the money ('await'); anything else is recorded as paid on PEAK's date.
function fromPeakPayment(row, { payDate, cheque, today = todayMs() }) {
  const d = parseDate(payDate);
  if (d !== null && d <= today && !cheque) return { mode: 'paid', fields: { paidDate: payDate, rtDate: row.rtDate || payDate, ...onPaid(row, payDate) } };
  // Waiting: the forecast date is the receipt date when it is still ahead, else the commit date stays.
  const fields = { rtDate: payDate };
  if (d !== null && d > today) fields.commitDate = payDate;
  else if (!row.commitDate) fields.commitDate = payDate;
  return { mode: 'await', fields, why: cheque ? 'cheque' : 'future' };
}
const dueOf = (issueDate, term) => { const i = parseDate(issueDate); return i === null ? '' : fmt(i + num(term) * DAY); };

// Invoices row for an INV accounting just marked issued in the app.
function rowFromRequest(iv, { request, lines, users, issueDate, ivNo, peakIvId, peakDocLink, productGroups }) {
  const hero = (lines || []).find((l) => l.role === 'hero') || (lines || []).find((l) => Number(String(l.unitPrice).replace(/,/g, '')) > 0) || (lines || [])[0] || {};
  const u = (users || []).find((x) => String(x.email).toLowerCase() === String(iv.requestedBy).toLowerCase());
  let productLine = '';
  let packageName = String(hero.description || '').split('\n')[0].slice(0, 200);
  if (hero.keyHS) {
    try {
      const pricing = require('./pricing');
      productLine = pricing.heroComponent(hero.keyHS) || '';
      packageName = pricing.heroName(hero.keyHS) || packageName;
    } catch (e) { /* keep description */ }
  } else if (hero.packageId) packageName = `${hero.packageId} ${packageName}`.trim();
  const group = productGroups && productLine ? productGroups.get(productLine) || '' : '';
  // A company customer (type B2B) sold by the B2C team is reported under B2C: the group follows the team that sold it.
  let segment = (request && request.segment) || '';
  if (segment === 'B2B' && u && String(u.team || '').toLowerCase() === 'b2c') segment = 'B2C';
  return {
    ivNo, issueDate, segment, dealType: (request && request.dealType) || '',
    salesEmail: iv.requestedBy, clientCode: (request && request.clientCode) || '', company: iv.company, taxId: iv.taxId,
    qtNo: iv.qtNo, requestId: iv.requestId, keyHS: hero.keyHS || hero.packageId || '', students: iv.students,
    preVat: num(iv.amountPreVat), creditTermDays: iv.creditTermDays, whtRate: num(iv.whtRate) / 100, poNo: iv.poNo,
    installment: iv.installment, docStatus: 'Active', commitDate: dueOf(issueDate, iv.creditTermDays), commitAtPaid: '', paidDate: '', paidAmount: '', paymentMethod: '', rtNo: '',
    delayReason: '', note: [iv.payCycle ? `รอบจ่าย: ${iv.payCycle}` : '', iv.poNeeded === 'yes' ? 'ต้องใช้ PO วางบิล' : ''].filter(Boolean).join(' · '), source: 'app',
    packageName, salesName: (u && u.name) || iv.salesName || '', ivRequestId: iv.ivRequestId, peakIvId: peakIvId || '',
    peakDocLink: peakDocLink || '', branch: iv.branch || '', followStatus: '', nextActionDate: '', productLineIn: productLine, packageGroupIn: group,
  };
}

async function readProductGroups() {
  try { return new Map((await hub.readList('Lists!H2:I')).map((r) => [r[0], r[1]])); } catch (e) { return new Map(); }
}

module.exports = { WHT_RATES, whtPct, expectedAt, whtIn, CURRENT_FROM, LEGACY_CHECK, VAT, DOC_STATUS, PAY_METHODS, CHANNELS, FOLLOW, DELAY, parseDate, fmt, enrich, weekEnd, weekStart, onPaid, fromPeakPayment, dueOf, rowFromRequest, readProductGroups, todayMs, num };
