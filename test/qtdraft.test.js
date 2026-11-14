// lib/qtdraft.js with a stubbed PEAK client: what the app sends and how it reads PEAK's answer.
const test = require('node:test');
const assert = require('node:assert');
const peak = require('../lib/peak');
const qtdraft = require('../lib/qtdraft');

function stub(over = {}) {
  const calls = { create: [], classify: [] };
  Object.assign(peak, {
    findContacts: async () => [{ id: 'c1', code: 'C14889', taxNumber: '1999999990011', branchCode: '00000' }],
    createQuotationDraft: async (body) => { calls.create.push(body); return { id: 'q1', code: 'QO-1' }; },
    getQuotation: async () => ({ id: 'q1', preTaxAmount: 16728.97, netAmount: 17900, documentLink: 'https://doc.peakaccount.com/x', products: [{ productId: 'p1', productCode: '5136', accountCode: '410235' }] }),
    getService: async () => ({ sellAccount: '410235' }),
    classify: async (...a) => { calls.classify.push(a); return {}; },
    ...over,
  });
  return calls;
}
const row = { requestId: 'REQ-1', segment: 'B2C', taxId: '1999999990011', branch: '00000', clientCode: 'C14889', vatMode: 'incl', totalPreVat: '16,728.97', totalInclVat: '17,900.00', whtRate: '3', wantedQtDate: '12/11/2026', requestedBy: 's@globish.co.th', opportunityId: 'CRM-OPP-1' };
const lines = [{ requestId: 'REQ-1', line: '1', peakServiceCode: '5136', description: 'pkg', qty: '1', unitPrice: '17,900', discount: '0', salesNote: '', freebie: '', qtDescription: '' }];
const users = [{ email: 's@globish.co.th', salesPerf: 'B2C-S001' }];

test('VAT-inclusive request → Draft with taxStatus 1, WHT on pre-VAT, tags and G012/G013/G014', async () => {
  const calls = stub();
  const r = await qtdraft.createForRequest(row, lines, users);
  assert.equal(r.fields.status, 'qt_draft');
  assert.equal(r.fields.peakQtNo, 'QO-1');
  assert.match(r.fields.peakNote, /ราคารวม VAT/);
  const q = calls.create[0].PeakQuotations.quotations[0];
  assert.equal(q.taxStatus, 1);
  assert.equal(q.contactCode, 'C14889');
  assert.equal(q.issuedDate, '20261112');
  assert.equal(q.status, 'Draft');
  assert.deepEqual(q.tags, ['CRM-OPP-1', 'REQ-1']);
  assert.equal(q.products[0].withHoldingTaxAmount, '501.87');
  assert.deepEqual(calls.classify.map((c) => [c[2], c[3]]), [['G012', 'G012-00001'], ['G013', 'G013-00002'], ['G014', 'B2C-S001']]);
});

test('account code different from the service → qt_error with the line', async () => {
  stub({ getService: async () => ({ sellAccount: '410201' }) });
  const r = await qtdraft.createForRequest(row, lines, users);
  assert.equal(r.fields.status, 'qt_error');
  assert.match(r.fields.peakNote, /5136 ได้ 410235 ควรเป็น 410201/);
  assert.equal(r.fields.peakQtId, 'q1');
});

test('amount different in PEAK → qt_error', async () => {
  stub({ getQuotation: async () => ({ preTaxAmount: 17900, netAmount: 19153, products: [] }) });
  const r = await qtdraft.createForRequest(row, lines, users);
  assert.equal(r.fields.status, 'qt_error');
  assert.match(r.fields.peakNote, /ยอดใน PEAK ไม่ตรง/);
});

test('no / several contacts → needs_contact; missing service code → needs_service_code; note → deferred', async () => {
  stub({ findContacts: async () => [] });
  assert.equal((await qtdraft.createForRequest(row, lines, users)).fields.status, 'needs_contact');
  stub({ findContacts: async () => [{ code: 'C1', taxNumber: '1999999990011' }, { code: 'C2', taxNumber: '1999999990011' }] });
  assert.match((await qtdraft.createForRequest(row, lines, users)).fields.peakNote, /2 รหัส/);
  stub();
  assert.equal((await qtdraft.createForRequest(row, [{ ...lines[0], peakServiceCode: '' }], users)).fields.status, 'needs_service_code');
  assert.equal((await qtdraft.createForRequest(row, [{ ...lines[0], salesNote: 'เรียน ม.ค.' }], users)).defer, 'notes');
});

test('B2B before VAT → taxStatus 0, exact pre-VAT check', async () => {
  const calls = stub({ getQuotation: async () => ({ preTaxAmount: 16000, netAmount: 17120, products: [] }) });
  const r = await qtdraft.createForRequest({ ...row, segment: 'B2B', vatMode: 'excl', totalPreVat: '16,000', totalInclVat: '17,120' }, [{ ...lines[0], unitPrice: '3200', qty: '5' }], users);
  assert.equal(r.fields.status, 'qt_draft');
  assert.equal(calls.create[0].PeakQuotations.quotations[0].taxStatus, 0);
});
