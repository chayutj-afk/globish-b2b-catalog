// PEAK webhook receiver: PEAK calls /api/peak-webhook/<type> on Create / Edit / Void / PaidPayment.
// The payload has the same shape as the API response ({ PeakInvoices: { invoices: [...] }, eventType, apiType }).
// PEAK sends every event of the type (also documents made by hand in PEAK), so everything we don't
// know is ignored. Auth: header x-api-key = PEAK_WEBHOOK_KEY (agreed with PEAK at activation).
//
// What it does, so accounting doesn't click twice:
//   quotation approved in PEAK  → Requests qt_draft → qt_approved
//   approved quotation edited    → new totals, warning for Sales (old PDF), Chat asks accounting to refresh
//   quotation voided in PEAK    → Requests qt_error with the recovery note (only when no INV request yet)
//   invoice created from a QT   → links it to the matching INV request (number, id, link)
//   invoice approved in PEAK    → INV request iv_issued + row in AR, same as accounting's "อนุมัติ"
//   payment recorded in PEAK    → AR paid (date, amount), pending Sales payment notices closed
//   receipt approved in PEAK    → the app's RT Draft request issued, RT No. into AR
// Nothing here writes to PEAK.

const crypto = require('crypto');
const hub = require('./hub');
const notify = require('./notify');
const peak = require('./peak');
const { vatIncluded } = require('./pricing');
const LIVE_QT = ['qt_approved', 'accepted', 'iv_requested', 'iv_issued'];

const num = (x) => Number(String(x ?? '').replace(/,/g, '')) || 0;
const up = (s) => String(s || '').toUpperCase();
const dmyOf = (ymd) => { const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(ymd || '').replace(/-/g, '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
const isVoid = (d) => !!(d && (Number(d.isVoid) === 1 || /void/i.test(d.status || '')));
const isApproved = (d) => !!(d && !isVoid(d) && /approve/i.test(d.status || ''));

function authorised(req) {
  const key = process.env.PEAK_WEBHOOK_KEY;
  const got = String(req.headers['x-api-key'] || '');
  if (!key || !got || got.length !== key.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(key));
}

// The documents in a payload, whatever the wrapper casing.
function docsOf(payload) {
  if (!payload || typeof payload !== 'object') return [];
  for (const v of Object.values(payload)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const w of Object.values(v)) if (Array.isArray(w)) return w.filter((x) => x && typeof x === 'object');
    }
  }
  return Array.isArray(payload.data) ? payload.data : [];
}

async function onQuotation(q, ev) {
  if (!q.id) return 'no id';
  const rows = await hub.readTable('Requests');
  const row = rows.find((r) => r.peakQtId === q.id);
  if (!row) return 'not ours';
  const at = hub.sheetDateTime();
  if (isVoid(q)) {
    if (!['qt_draft', 'qt_approved'].includes(row.status)) return `void ignored (${row.status})`;
    const ivs = (await hub.readTable('InvoiceRequests')).filter((v) => v.requestId === row.requestId && v.status !== 'rejected');
    if (ivs.length) { await notify.chat(`⚠️ QT ${row.peakQtNo} (${row.company}) ถูก void ใน PEAK แต่มีคำขอ INV แล้ว ${ivs.length} ใบ ตรวจด้วย`); return 'void with INV'; }
    await hub.updateRow('Requests', row._row, { status: 'qt_error', updatedAt: at, peakNote: `QT ${row.peakQtNo} ถูก void ใน PEAK ถ้าเผลอยกเลิก กด 'QT ถูกยกเลิกใน PEAK สร้างใหม่' ในหน้ารออนุมัติ` });
    return 'voided';
  }
  const sig = peak.quotationSig(q);
  if (isApproved(q) && row.status === 'qt_draft') {
    await hub.updateRow('Requests', row._row, { status: 'qt_approved', qtApprovedAt: at, updatedAt: at, qtSig: sig, peakNote: `อนุมัติ QT ใน PEAK แล้ว (PEAK แจ้งอัตโนมัติ)`, ...(q.documentLink ? { peakDocLink: q.documentLink } : {}) });
    return 'approved';
  }
  // A QT Sales already sent out was edited in PEAK. PEAK's public link keeps the old PDF until someone
  // presses refresh in PEAK, so: take the new totals, warn Sales, ask accounting to refresh.
  if (LIVE_QT.includes(row.status) && !isVoid(q)) {
    const pre = num(q.preTaxAmount), net = num(q.netAmount);
    const changed = row.qtSig ? row.qtSig !== sig : (pre && Math.abs(pre - num(row.totalPreVat)) > 0.009);
    if (!changed) { if (!row.qtSig) await hub.updateRow('Requests', row._row, { qtSig: sig }); return 'no content change'; }
    const incl = row.vatMode ? row.vatMode === 'incl' : vatIncluded(row.segment);
    const f = { qtSig: sig, qtEditedAt: at, updatedAt: at, ...(q.documentLink ? { peakDocLink: q.documentLink } : {}) };
    if (pre) f.totalPreVat = pre;
    if (incl && net) f.totalInclVat = net;
    await hub.updateRow('Requests', row._row, f);
    const ivs = (await hub.readTable('InvoiceRequests')).filter((v) => v.requestId === row.requestId && v.status !== 'rejected');
    const asked = ivs.reduce((s, v) => s + (incl ? (num(v.amountInclVat) || num(v.amountPreVat) * 1.07) : num(v.amountPreVat)), 0);
    const total = incl ? net : pre;
    await notify.chat([`✏️ QT ${row.peakQtNo} (${row.company}) ถูกแก้ไขใน PEAK · ยอดใหม่ ${total.toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
      'ไฟล์ที่ลิงก์ให้ Sales ยังเป็นเวอร์ชันเก่า: เปิด QT ใน PEAK กดรีเฟรชเอกสาร แล้วกด "รีเฟรชแล้ว" ในหน้ารออนุมัติ',
      asked > total + 0.01 ? `⚠️ ขอ INV ไปแล้ว ${asked.toFixed(2)} เกินยอด QT ใหม่ ตรวจคำขอ INV` : ''].filter(Boolean).join('\n'));
    return 'edited';
  }
  return `no change (${ev} · ${q.status})`;
}

async function onInvoice(iv, ev) {
  if (!iv.id) return 'no id';
  const [ivreqs, invs] = await Promise.all([hub.readTable('InvoiceRequests'), hub.readTable('Invoices')]);
  const at = hub.sheetDateTime();

  // Payment recorded in PEAK → AR paid.
  if (/paid/i.test(ev) && !/void/i.test(ev)) {
    const a = invs.find((x) => x.peakIvId === iv.id) || invs.find((x) => up(x.ivNo) === up(iv.code));
    if (!a || a.paidDate) return a ? 'already paid' : 'AR row not found';
    const pays = iv.paidPayments || iv.payments || [];
    const last = pays.map((p) => p.paymentDate || p.paidDate).filter(Boolean).sort().pop();
    const total = Math.round(pays.reduce((s, p) => s + num(p.paymentTotal ?? p.amount), 0) * 100) / 100;
    if (num(iv.remainAmount) > 0.01) return 'partly paid, left for accounting';
    await hub.updateRow('Invoices', a._row, { paidDate: dmyOf(last) || at.slice(0, 10), paidAmount: total || a.paidAmount, note: [a.note, 'รับเงินตาม PEAK (แจ้งอัตโนมัติ)'].filter(Boolean).join(' · ').slice(0, 500) });
    const notices = await hub.readTable('PaymentNotices').catch(() => []);
    for (const n of notices.filter((x) => up(x.ivNo) === up(a.ivNo) && x.status === 'new')) {
      await hub.updateRow('PaymentNotices', n._row, { status: 'matched', accountNote: 'รับเงินตาม PEAK แล้ว (แจ้งอัตโนมัติ)', doneBy: 'peak-webhook', updatedAt: at });
    }
    await notify.chat(`💰 ลูกค้าจ่ายแล้ว ${a.ivNo} · ${a.company} ${total || ''} (บันทึกใน PEAK) · รอออกใบเสร็จ`);
    return 'paid';
  }
  if (isVoid(iv)) {
    const r = ivreqs.find((x) => x.peakIvId === iv.id);
    if (r) await notify.chat(`⚠️ INV ${iv.code} (${r.company}) ถูก void ใน PEAK ตรวจคำขอ ${r.ivRequestId}`);
    return r ? 'void noted' : 'not ours';
  }

  // Which INV request is this? Already linked by id, else the one from the same QT with the same amount.
  let row = ivreqs.find((x) => x.peakIvId === iv.id);
  if (!row) {
    const reqs = await hub.readTable('Requests');
    const qt = reqs.find((r) => (iv.referenceId && r.peakQtId === iv.referenceId) || (iv.referenceCode && up(r.peakQtNo) === up(iv.referenceCode)));
    const qtNo = up(iv.referenceCode || (qt && qt.peakQtNo));
    const cands = ivreqs.filter((x) => ['new', 'iv_draft'].includes(x.status) && !x.peakIvId
      && ((qt && x.requestId === qt.requestId) || (qtNo && up(x.qtNo) === qtNo))
      && (Math.abs(num(x.amountPreVat) - num(iv.preTaxAmount)) <= 0.05 || (num(x.amountInclVat) && Math.abs(num(x.amountInclVat) - num(iv.netAmount)) <= 0.01)));
    if (cands.length !== 1) {
      if (qtNo && cands.length > 1) await notify.chat(`ℹ️ INV ${iv.code} จาก ${qtNo} ตรงกับคำขอ INV ${cands.length} ใบ (ยอดเท่ากัน) ใส่เลขเองในหน้ารออนุมัติ`);
      return cands.length ? 'ambiguous' : 'no matching request';
    }
    row = cands[0];
  }
  const link = iv.documentLink || row.peakDocLink || '';
  if (isApproved(iv)) {
    if (row.status === 'iv_issued') return 'already issued';
    await require('../api/invoice-requests').issueInv(row, { ivNo: up(iv.code), link, issueDate: dmyOf(iv.issuedDate) || row.wantedIssueDate, note: 'ออก INV ใน PEAK แล้ว (PEAK แจ้งอัตโนมัติ)', peakIvId: iv.id });
    return 'issued';
  }
  if (row.status === 'new' || row.status === 'iv_draft') {
    await hub.updateRow('InvoiceRequests', row._row, { status: 'iv_draft', peakIvNo: up(iv.code), peakIvId: iv.id, peakDocLink: link, updatedAt: at });
    return 'linked draft';
  }
  return `no change (${row.status})`;
}

// Receipt approved in PEAK (an RT Draft the app made from a paid INV) → issued + RT No. in AR.
async function onReceipt(r, ev) {
  if (!r.id) return 'no id';
  const row = (await hub.readTable('ReceiptRequests')).find((x) => x.peakRtId === r.id);
  if (!row) return 'not ours';
  if (isVoid(r)) { await notify.chat(`⚠️ ใบเสร็จ ${r.code} (${row.billName}) ถูก void ใน PEAK ตรวจคำขอ ${row.rtRequestId}`); return 'void noted'; }
  if (isApproved(r) && row.status === 'rt_draft') {
    await require('../api/invoice-requests').finishRt(row, r, 'PEAK แจ้งอัตโนมัติ');
    return 'issued';
  }
  return `no change (${ev} · ${r.status})`;
}

async function handle(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  if (!authorised(req)) return res.status(401).json({ ok: false });
  // Vercel rewrite /api/peak-webhook/:type → /api/users?view=peak-hook&type=:type (req.query has it; the path is a fallback).
  const u = new URL(req.url, 'http://x');
  const type = String((req.query && req.query.type) || u.searchParams.get('type') || u.pathname.split('/').pop() || '').toLowerCase();
  const payload = req.body || {};
  const ev = String(payload.eventType || payload.EventType || '');
  const out = [];
  for (const d of docsOf(payload).slice(0, 10)) {
    let r;
    try {
      r = type === 'quotation' ? await onQuotation(d, ev) : type === 'invoice' ? await onInvoice(d, ev) : type === 'receipt' ? await onReceipt(d, ev) : 'ignored type';
    } catch (e) { r = `error: ${String(e.message).slice(0, 120)}`; }
    out.push(r);
    await hub.log('peak-webhook', `${type}_${ev || 'event'}`, d.code || d.id || '', String(r)).catch(() => {});
  }
  return res.status(200).json({ ok: true, results: out });
}

module.exports = { handle, _test: { docsOf, isVoid, isApproved, dmyOf, onQuotation, onInvoice, onReceipt, authorised } };
