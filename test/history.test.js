const test = require('node:test');
const assert = require('node:assert');
const { build } = require('../lib/history');

const data = () => ({
  users: [{ email: 'acc@globish.co.th', name: 'Ploy', role: 'op' }, { email: 's@globish.co.th', name: 'Benz', role: 'sales' }],
  reqs: [{ requestId: 'REQ-1', company: 'A Co', peakQtNo: 'QO-1', totalPreVat: '1000', note: 'hello', salesName: 'Benz' }],
  ivs: [{ ivRequestId: 'INVREQ-1-1', batchId: 'INVREQ-1', company: 'A Co', peakIvNo: 'IV-1', amountPreVat: '500', note: 'names' },
    { ivRequestId: 'INVREQ-1-2', batchId: 'INVREQ-1', company: 'A Co', peakIvNo: '', amountPreVat: '500' }],
  rts: [], edits: [{ editId: 'EDIT-1', docType: 'QT', docNo: 'QO-1', company: 'A Co', detail: 'fix' }],
  pays: [{ noticeId: 'PAY-1', ivNo: 'IV-1', amount: '535' }],
  log: [
    { at: '16/11/2026 09:00', source: 'catalog', event: 'request_created', reference: 'REQ-1', detail: 's@globish.co.th · A Co · 1000' },
    { at: '16/11/2026 09:05', source: 'catalog', event: 'qt_approve', reference: 'REQ-1', detail: 'acc@globish.co.th' },
    { at: '16/11/2026 09:06', source: 'peak-webhook', event: 'quotation_Create', reference: 'QO-1', detail: 'not ours' },
    { at: '16/11/2026 09:10', source: 'peak-webhook', event: 'quotation_Edit', reference: 'QO-1', detail: 'approved' },
    { at: '16/11/2026 10:00', source: 'catalog', event: 'invoice_requested', reference: 'INVREQ-1', detail: 's@globish.co.th · QO-1 · 2 INV · 1000' },
    { at: '16/11/2026 10:05', source: 'peak', event: 'iv_live_draft', reference: 'INVREQ-1-1', detail: 'acc@globish.co.th · IV-1' },
    { at: '16/11/2026 10:06', source: 'peak-webhook', event: 'invoice_Edit', reference: 'IV-1', detail: 'issued (after re-check)' },
    { at: '16/11/2026 10:30', source: 'catalog', event: 'edit_reject', reference: 'EDIT-1', detail: 'acc@globish.co.th · ทำไม่ได้' },
    { at: '16/11/2026 11:00', source: 'catalog', event: 'pay_confirm', reference: 'PAY-1', detail: 'acc@globish.co.th · IV-1 · 535' },
    { at: '16/11/2026 11:01', source: 'catalog', event: 'ar_peakcheck', reference: 'IV-1', detail: 'acc@globish.co.th · ok' },
    { at: '16/11/2026 12:00', source: 'catalog', event: 'iv_issued', reference: 'INVREQ-GONE-1', detail: 'acc@globish.co.th' },
  ],
});

test('history: newest first, joins requests, names people, keeps only meaningful PEAK events', () => {
  const { entries, threads } = build(data());
  const main = entries.filter((e) => e.main);
  assert.deepStrictEqual(main.map((e) => e.ev), ['iv_issued', 'pay_confirm', 'edit_reject', 'invoice_Edit', 'iv_live_draft', 'quotation_Edit', 'qt_approve']);
  const ap = main.find((e) => e.ev === 'qt_approve');
  assert.strictEqual(ap.by, 'Ploy'); assert.strictEqual(ap.role, 'บัญชี'); assert.strictEqual(ap.thread, 'Q:REQ-1');
  assert.strictEqual(threads['Q:REQ-1'].note, 'hello');
  const hook = main.find((e) => e.ev === 'invoice_Edit');
  assert.strictEqual(hook.by, 'PEAK'); assert.strictEqual(hook.thread, 'I:INVREQ-1-1'); assert.strictEqual(hook.cls, 'green');
  assert.ok(!entries.some((e) => e.ev === 'quotation_Create' || e.ev === 'ar_peakcheck'));
});

test('history: reject reason, payment joins its INV, batch line shown once, unknown reference still listed', () => {
  const { entries } = build(data());
  assert.strictEqual(entries.find((e) => e.ev === 'edit_reject').reason, 'ทำไม่ได้');
  const pay = entries.find((e) => e.ev === 'pay_confirm');
  assert.strictEqual(pay.thread, 'I:INVREQ-1-1'); assert.strictEqual(pay.amount, 535);
  const batch = entries.filter((e) => e.ev === 'invoice_requested');
  assert.deepStrictEqual(batch.map((e) => e.thread).sort(), ['I:INVREQ-1-1', 'I:INVREQ-1-2']);
  const gone = entries.find((e) => e.ref === 'INVREQ-GONE-1');
  assert.ok(gone && gone.main && !gone.thread);
  // The timeline of INV 1: requested → draft → issued in PEAK → paid.
  assert.deepStrictEqual(entries.filter((e) => e.thread === 'I:INVREQ-1-1').sort((a, b) => a.ts - b.ts).map((e) => e.ev), ['invoice_requested', 'iv_live_draft', 'invoice_Edit', 'pay_confirm']);
});
