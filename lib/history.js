// Approval history for accounting: built from SyncLog (every action the app already records),
// joined to the request rows for the customer name, document number, amount and the sales note.
// Read only. Nothing new is stored.
const hub = require('./hub');

// event → [kind, class, label, main]. main = shown as a row; otherwise it only appears in a document's timeline.
// kind: qt | inv | rt | edit | pay. class: green (approved / issued) | red (sent back / void) | blue (a step) | '' (neutral).
const EV = {
  request_created: ['qt', '', 'เซลส่งคำขอ QT', 0],
  qt_approve: ['qt', 'green', 'อนุมัติคำขอ QT', 1],
  qt_retry: ['qt', 'blue', 'สั่งสร้าง QT อีกครั้ง', 1],
  qt_reopen: ['qt', 'blue', 'เปิดคำขอ QT อีกครั้ง', 1],
  qt_reject: ['qt', 'red', 'ตีกลับคำขอ QT', 1],
  qt_qt_approved: ['qt', 'green', 'QT อนุมัติแล้ว', 1],
  qt_qt_voided: ['qt', 'red', 'ยกเลิก QT (Void)', 1],
  qt_qt_fixed: ['qt', 'blue', 'ตรวจ QT ใหม่', 1],
  qt_live_qt_draft: ['qt', '', 'ระบบสร้าง QT Draft ใน PEAK', 0],
  qt_live_needs_review: ['qt', '', 'สร้าง QT ไม่ได้ ต้องตรวจคำขอ', 0],
  qt_live_needs_contact: ['qt', '', 'สร้าง QT ไม่ได้ ไม่พบลูกค้าใน PEAK', 0],
  qt_live_needs_service_code: ['qt', '', 'สร้าง QT ไม่ได้ ไม่พบรหัสบริการ', 0],
  qt_live_qt_error: ['qt', '', 'สร้าง QT ไม่สำเร็จ', 0],
  qt_refreshed: ['qt', '', 'อัปเดต QT จาก PEAK', 0],
  qt_adopt: ['qt', 'blue', 'นำ QT เข้าระบบ', 1],
  invoice_requested: ['inv', '', 'เซลส่งคำขอ INV', 0],
  iv_live_draft: ['inv', 'blue', 'สร้าง INV Draft', 1],
  iv_live_error: ['inv', 'red', 'สร้าง INV Draft ไม่สำเร็จ', 0],
  iv_live_partial: ['inv', '', 'สร้าง INV Draft ได้บางส่วน', 0],
  iv_check: ['inv', 'green', 'ออก INV แล้ว', 1],
  iv_issued: ['inv', 'green', 'ออก INV แล้ว', 1],
  iv_reject: ['inv', 'red', 'ตีกลับคำขอ INV', 1],
  iv_reopen: ['inv', 'blue', 'เปิดคำขอ INV อีกครั้ง', 1],
  iv_reset: ['inv', '', 'ส่งคำขอ INV กลับเข้าคิว', 1],
  original_requested: ['inv', '', 'ขอเอกสารตัวจริง', 0],
  original_not_needed: ['inv', '', 'ไม่ต้องส่งตัวจริง', 0],
  original_sent: ['inv', 'blue', 'ส่งตัวจริงแล้ว', 1],
  pay_notice: ['pay', '', 'เซลแจ้งว่าลูกค้าจ่ายแล้ว', 0],
  pay_confirm: ['pay', 'green', 'ยืนยันรับเงิน', 1],
  pay_reject: ['pay', 'red', 'ตีกลับแจ้งรับเงิน', 1],
  receipt_requested: ['rt', '', 'เซลส่งคำขอใบเสร็จ', 0],
  rt_live_draft: ['rt', 'blue', 'สร้างใบเสร็จ Draft', 1],
  rt_from_inv: ['rt', 'green', 'ออกใบเสร็จแล้ว', 1],
  rt_check: ['rt', 'green', 'ออกใบเสร็จแล้ว', 1],
  rt_issued: ['rt', 'green', 'ออกใบเสร็จแล้ว', 1],
  rt_reject: ['rt', 'red', 'ตีกลับคำขอใบเสร็จ', 1],
  rt_reopen: ['rt', 'blue', 'เปิดคำขอใบเสร็จอีกครั้ง', 1],
  rt_sent: ['rt', 'blue', 'ส่งใบเสร็จตัวจริงแล้ว', 1],
  edit_requested: ['edit', '', 'เซลขอแก้เอกสาร', 0],
  edit_done: ['edit', 'green', 'แก้เอกสารแล้ว', 1],
  edit_reject: ['edit', 'red', 'ตีกลับคำขอแก้ไข', 1],
};
// What PEAK told the app (webhook). Only results that changed something are kept.
const HOOK = [
  [/^quotation_/, /^approved/, 'qt', 'green', 'QT อนุมัติใน PEAK'],
  [/^quotation_/, /^edited/, 'qt', '', 'QT ถูกแก้ใน PEAK'],
  [/^quotation_/, /^(voided|void with INV)/, 'qt', 'red', 'QT ถูกยกเลิกใน PEAK'],
  [/^invoice_/, /^issued/, 'inv', 'green', 'INV อนุมัติใน PEAK'],
  [/^invoice_/, /^void synced/, 'inv', 'red', 'INV ถูกยกเลิกใน PEAK'],
  [/^invoice_/, /^paid/, 'pay', 'green', 'รับเงินครบใน PEAK'],
  [/^invoice_/, /^partly paid/, 'pay', '', 'รับเงินบางส่วนใน PEAK'],
  [/^receipt_/, /^issued/, 'rt', 'green', 'ใบเสร็จอนุมัติใน PEAK'],
  [/^receipt_/, /^void synced/, 'rt', 'red', 'ใบเสร็จถูกยกเลิกใน PEAK'],
];

const num = (v) => { const n = Number(String(v || '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
// "18/11/2026 13:42" (Bangkok) → sortable number.
const stamp = (s) => { const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})/.exec(String(s || '')); return m ? Number(m[3] + m[2] + m[1] + m[4] + m[5]) : 0; };
const up = (s) => String(s || '').trim().toUpperCase();

function build({ log, reqs, ivs, rts, edits, pays, users }) {
  const names = new Map(users.map((u) => [String(u.email).toLowerCase(), u.name || String(u.email).split('@')[0]]));
  const roles = new Map(users.map((u) => [String(u.email).toLowerCase(), u.role]));
  const threads = {};
  const idx = new Map(); // any reference (request id, document number) → thread key
  const put = (key, refs, t) => { threads[key] = t; refs.filter(Boolean).forEach((r) => idx.set(up(r), key)); };
  for (const q of reqs) {
    put('Q:' + q.requestId, [q.requestId, q.peakQtNo], {
      kind: 'qt', company: q.company, doc: q.peakQtNo, id: q.requestId, sales: q.salesName, note: q.note,
      amount: q.vatMode === 'incl' && num(q.totalInclVat) ? num(q.totalInclVat) : num(q.totalPreVat), amountNote: q.vatMode === 'incl' && num(q.totalInclVat) ? 'รวม VAT' : 'ก่อน VAT',
      link: q.peakDocLink, to: { t: 'qt', q: q.requestId },
    });
  }
  const batches = new Map();
  for (const v of ivs) {
    put('I:' + v.ivRequestId, [v.ivRequestId, v.peakIvNo], {
      kind: 'inv', company: v.company, doc: v.peakIvNo, id: v.ivRequestId, sales: v.salesName, note: v.note, qt: v.qtNo, installment: v.installment,
      amount: num(v.amountPreVat), amountNote: 'ก่อน VAT', link: v.peakDocLink, to: { t: 'inv', q: v.ivRequestId },
    });
    if (v.batchId) { if (!batches.has(up(v.batchId))) batches.set(up(v.batchId), []); batches.get(up(v.batchId)).push('I:' + v.ivRequestId); }
  }
  for (const r of rts) {
    put('R:' + r.rtRequestId, [r.rtRequestId, r.peakRtNo], {
      kind: 'rt', company: r.billName, doc: r.peakRtNo, id: r.rtRequestId, sales: r.salesName, note: r.note, ref: r.refDoc,
      amount: num(r.price) - num(r.discount), amountNote: 'หลังส่วนลด', link: r.peakDocLink, to: { t: 'rt', q: r.rtRequestId },
    });
  }
  for (const e of edits) {
    put('E:' + e.editId, [e.editId], { kind: 'edit', company: e.company, doc: `${e.docType} ${e.docNo}`, id: e.editId, sales: e.salesName, note: e.detail, amount: 0, to: { t: 'edit', q: e.editId } });
  }
  // A payment notice belongs to its INV's story.
  const payOf = new Map(pays.map((p) => [up(p.noticeId), p]));

  const out = [];
  for (const l of log) {
    const ts = stamp(l.at); if (!ts) continue;
    let def = EV[l.event], auto = false, detail = String(l.detail || '');
    if (l.source === 'peak-webhook') {
      const h = HOOK.find(([e, d]) => e.test(l.event) && d.test(detail));
      if (!h) continue;
      def = [h[2], h[3], h[4], 1]; auto = true;
    }
    if (!def) continue;
    const ref = up(l.reference);
    let keys = idx.has(ref) ? [idx.get(ref)] : batches.get(ref) || [];
    let amount = null;
    if (def[0] === 'pay' && payOf.has(ref)) { const p = payOf.get(ref); keys = idx.has(up(p.ivNo)) ? [idx.get(up(p.ivNo))] : []; amount = num(p.amount); }
    // Who: "<email> · rest". Events written by the system carry no email.
    const m = /^([^\s·]+@[^\s·]+)(?:\s·\s([\s\S]*))?$/.exec(detail);
    const email = m ? m[1].toLowerCase() : '';
    const rest = m ? (m[2] || '') : detail;
    const isReject = /_reject$/.test(l.event);
    const e = {
      at: l.at, ts, ev: l.event, kind: def[0], cls: def[1], label: def[2], main: def[3] ? 1 : 0,
      by: auto ? 'PEAK' : email ? (names.get(email) || email.split('@')[0]) : 'ระบบ',
      role: auto ? 'แจ้งอัตโนมัติ' : email ? ({ op: 'บัญชี', admin: 'Admin', collector: 'ตามหนี้' }[roles.get(email)] || 'Sales') : 'อัตโนมัติ',
      auto: auto ? 1 : 0, ref: l.reference, reason: isReject ? rest : '',
      // Left-over text worth showing when the row cannot be joined to a request (e.g. the request row was cleared).
      extra: isReject || !m ? '' : rest.slice(0, 160),
    };
    if (amount !== null) e.amount = amount;
    if (!keys.length) out.push(e);
    // One log line for a batch of INV requests: it belongs to each of them, but is shown once.
    keys.forEach((k, i) => out.push({ ...e, thread: k, main: i ? 0 : e.main, n: keys.length > 1 ? keys.length : undefined }));
  }
  out.sort((a, b) => b.ts - a.ts);
  const used = new Set(out.map((e) => e.thread).filter(Boolean));
  return { entries: out, threads: Object.fromEntries(Object.entries(threads).filter(([k]) => used.has(k))) };
}

async function load() {
  const c = { cache: 30e3 };
  const [log, reqs, ivs, rts, edits, pays, users] = await Promise.all(
    ['SyncLog', 'Requests', 'InvoiceRequests', 'ReceiptRequests', 'EditRequests', 'PaymentNotices', 'Users'].map((t) => hub.readTable(t, c)));
  return build({ log, reqs, ivs, rts, edits, pays, users });
}

module.exports = { build, load, stamp };
