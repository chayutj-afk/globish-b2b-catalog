// lib/ivdraft.js with a stubbed PEAK client.
const test = require('node:test');
const assert = require('node:assert');
const peak = require('../lib/peak');
const ivdraft = require('../lib/ivdraft');

const QT = { id: 'q1', code: 'QO-1', status: 'Approve', taxStatus: 0, preTaxAmount: 20000, netAmount: 21400,
  products: [{ productCode: 'S1', description: 'Pro 12 เดือน', quantity: 10, price: 1500, discount: 0, vatType: 3 }, { productCode: 'S2', description: 'Book', quantity: 10, price: 500, discount: 0, vatType: 3 }] };
function stub(over = {}) {
  const calls = { create: [], classify: [] };
  Object.assign(peak, {
    getQuotation: async () => QT,
    findContacts: async () => [{ code: 'C2' }],
    createInvoiceFromQuotationDraft: async (b) => { calls.create.push(b); return { id: 'i1', code: 'IV-1' }; },
    getInvoice: async () => ({ id: 'i1', preTaxAmount: calls.create[0].PeakInvoices.invoices.products.reduce((s, p) => s + p.quantity * p.price, 0), documentLink: 'https://doc.peakaccount.com/i' }),
    classify: async (...a) => { calls.classify.push(a); return {}; },
    ...over,
  });
  return calls;
}
const qtRow = { requestId: 'REQ-1', peakQtId: 'q1', peakQtNo: 'QO-1', taxId: '0105555555554', branch: '00000', segment: 'B2B', requestedBy: 's@g', opportunityId: 'CRM-OPP-2026-00001', whtRate: '3', docLang: 'TH' };
const iv = { ivRequestId: 'INVREQ-1-1', requestId: 'REQ-1', taxId: '0105555555554', branch: '00000', amountPreVat: '20000', wantedIssueDate: '14/11/2026', creditTermDays: '30', whtRate: '3', installment: '', requestedBy: 's@g', poNo: 'PO9' };

test('whole QT → QT lines, Draft, due date from credit term, WHT, tags, classification 102', async () => {
  const c = stub();
  const { fields } = await ivdraft.createForIvRequest(iv, qtRow, [{ email: 's@g', salesPerf: 'B2B-S001' }]);
  const inv = c.create[0].PeakInvoices.invoices;
  assert.equal(c.create[0].PeakInvoices.quotationId, 'q1');
  assert.deepEqual([inv.status, inv.issuedDate, inv.dueDate, inv.taxStatus, inv.reference, inv.remark], ['Draft', '20261114', '20261214', 0, 'QO-1', 'PO: PO9']);
  assert.equal(inv.products.length, 2);
  assert.equal(inv.products[0].withHoldingTaxAmount, '450.00');
  assert.equal(inv.contactCode, undefined, 'same customer as the QT');
  assert.deepEqual(inv.tags, ['CRM-OPP-2026-00001', 'REQ-1', 'INVREQ-1-1']);
  assert.deepEqual([fields.status, fields.peakIvNo, fields.peakIvId, fields.peakDocLink], ['iv_draft', 'IV-1', 'i1', 'https://doc.peakaccount.com/i']);
  assert.deepEqual(c.classify.map((x) => [x[1], x[2], x[3]]), [[102, 'G012', 'G012-00002'], [102, 'G013', 'G013-00001'], [102, 'G014', 'B2B-S001']]);
});

test('instalment → one line with the main service and the amount; other entity → its contact', async () => {
  const c = stub();
  const { fields } = await ivdraft.createForIvRequest({ ...iv, amountPreVat: '5000', installment: '1/4', taxId: '0105555555562' }, qtRow, []);
  const inv = c.create[0].PeakInvoices.invoices;
  assert.deepEqual(inv.products, [{ productCode: 'S1', description: 'Pro 12 เดือน\nงวด 1/4', quantity: 1, price: 5000, vatType: 3, withHoldingTaxAmount: '150.00' }]);
  assert.equal(inv.contactCode, 'C2');
  assert.match(fields.accountNote, /บรรทัดเดียว/);
});

test('QT still Draft / voided / no QT → refused before anything is created', async () => {
  const c = stub({ getQuotation: async () => ({ ...QT, status: 'Draft' }) });
  await assert.rejects(ivdraft.createForIvRequest(iv, qtRow, []), /ยังเป็น Draft/);
  stub({ getQuotation: async () => ({ ...QT, isVoid: 1 }) });
  await assert.rejects(ivdraft.createForIvRequest(iv, qtRow, []), /ยกเลิก/);
  await assert.rejects(ivdraft.createForIvRequest(iv, { ...qtRow, peakQtId: '' }, []), /ไม่มี QT/);
  assert.equal(c.create.length, 0);
});
