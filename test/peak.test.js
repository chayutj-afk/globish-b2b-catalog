const test = require('node:test');
const assert = require('node:assert');

process.env.PEAK_MODE = 'uat';
process.env.PEAK_CONNECT_ID = 'cid';
process.env.PEAK_PASSWORD = 'pw';
process.env.PEAK_USER_TOKEN = 'ut';
const peak = require('../lib/peak.js');

// Fake PEAK: a list of handlers, one per expected call. Records every request.
function fakePeak(handlers) {
  const calls = [];
  global.fetch = async (url, opts) => {
    const h = handlers.shift();
    if (!h) throw new Error('unexpected call ' + url);
    const call = { url, method: opts.method, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : undefined };
    calls.push(call);
    const [status, data, headers = {}] = h(call);
    return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(data), headers: { get: (k) => headers[k.toLowerCase()] } };
  };
  return calls;
}
const tokenOk = () => [200, { PeakClientToken: { token: 'ct-1', resCode: '200', resDesc: 'Token Authorized' } }];

test('signature: HMAC-SHA1 of the timestamp keyed by connectId, hex unless PEAK_SIG_ENCODING=base64', () => {
  assert.equal(peak.signature('20160830072630', 'key', 'hex'), require('crypto').createHmac('sha1', 'key').update('20160830072630').digest('hex'));
  assert.match(peak.signature('20160830072630', 'key', 'base64'), /=$/);
  assert.equal(peak.stamp(new Date(Date.UTC(2016, 7, 30, 7, 26, 30))), '20160830072630');
});

test('client token is fetched once with connectId + password, then sent with the user token', async () => {
  peak._test.reset();
  const calls = fakePeak([tokenOk,
    () => [200, { PeakContacts: { contacts: [{ id: 'c1', code: 'C01401', name: 'A', taxNumber: '0105557083391', branchCode: '00000' }], resCode: '200' } }],
    () => [200, { PeakContacts: { contacts: [], resCode: '200' } }]]);
  const found = await peak.findContacts('0-1055-57083-39-1');
  await peak.findContacts('0105557083391', '00001');
  assert.equal(calls.length, 3, 'token cached');
  assert.deepEqual(calls[0].body, { PeakClientToken: { connectId: 'cid', password: 'pw' } });
  assert.match(calls[0].url, /peakengineapidev.*\/ClientToken$/);
  assert.equal(calls[1].method, 'GET');
  assert.match(calls[1].url, /\/Contacts\?taxId=0105557083391&branchCode=00000$/);
  assert.match(calls[2].url, /branchCode=00001$/);
  assert.equal(calls[1].headers['Client-Token'], 'ct-1');
  assert.equal(calls[1].headers['User-Token'], 'ut');
  assert.deepEqual(found, [{ id: 'c1', code: 'C01401', name: 'A', taxNumber: '0105557083391', branchCode: '00000', type: undefined }]);
  await assert.rejects(peak.findContacts('123'), /13 หลัก/);
});

test('an error code inside an HTTP 200 is an error', async () => {
  peak._test.reset();
  fakePeak([() => [200, { PeakClientToken: { resCode: '401', resDesc: 'Invalid TimeSignature' } }]]);
  await assert.rejects(peak.getQuotation('q1'), /401: Invalid TimeSignature/);
});

test('429 waits retryAfterSeconds and retries; an expired client token is renewed once', async () => {
  peak._test.reset();
  const calls = fakePeak([tokenOk,
    () => [429, { error: 'RATE_LIMITED', type: 'concurrency', policy: 'GetConcurrencyLimitByUserToken', retryAfterSeconds: 0.01 }],
    () => [401, { message: 'Client-Token expired' }],
    () => [200, { PeakClientToken: { token: 'ct-2', resCode: '200' } }],
    () => [200, { PeakQuotations: { quotations: [{ id: 'q1', code: 'QO-1' }], resCode: '200' } }]]);
  const q = await peak.getQuotation('q1');
  assert.equal(q.code, 'QO-1');
  assert.equal(calls.at(-1).headers['Client-Token'], 'ct-2');
});

test('creates are Draft only: a non-Draft body never reaches PEAK', async () => {
  fakePeak([]);
  await assert.rejects(peak.createQuotationDraft({ PeakQuotations: { quotations: [{ status: 'Approve' }] } }), /Draft/);
  await assert.rejects(peak.createInvoiceFromQuotationDraft({ PeakInvoices: { quotationId: 'q', invoices: { issuedDate: '20261111' } } }), /Draft/);
});

test('INV from QT: Draft, linked by quotation id, due date from credit term; lines replace the QT lines for an instalment', async () => {
  const whole = peak.buildInvoiceFromQuotation({ quotationId: 'q1', quotationCode: 'QO-1', issuedDate: '2026-11-20', creditTermDays: 30, reference: 'INVREQ-1-1', tags: ['CRM-OPP-2026-00001', 'INVREQ-1-1'] });
  assert.deepEqual(whole, { PeakInvoices: { quotationId: 'q1', quotationCode: undefined, invoices: {
    issuedDate: '20261120', dueDate: '20261220', reference: 'INVREQ-1-1', remark: undefined, tags: ['CRM-OPP-2026-00001', 'INVREQ-1-1'], taxStatus: 0, status: 'Draft' } } });
  const part = peak.buildInvoiceFromQuotation({ quotationCode: 'QO-1', issuedDate: '2026-11-20', whtRate: 3,
    lines: [{ productCode: 'B2B-PVT', description: 'งวด 1/2', qty: 2, unitPrice: 25000, discount: 1000 }] });
  assert.equal(part.PeakInvoices.quotationCode, 'QO-1');
  assert.deepEqual(part.PeakInvoices.invoices.products, [{ productCode: 'B2B-PVT', description: 'งวด 1/2', quantity: 2, price: 25000, discount: '500', vatType: 3, withHoldingTaxAmount: '1470' }]);
  assert.throws(() => peak.buildInvoiceFromQuotation({ issuedDate: '2026-11-20' }), /QT/);

  peak._test.reset();
  const calls = fakePeak([tokenOk, () => [200, { PeakInvoices: { invoices: [{ id: 'i1', code: 'IV-1', status: 'Draft', resCode: '200' }], resCode: '200' } }]]);
  const r = await peak.createInvoiceFromQuotationDraft(whole);
  assert.equal(r.code, 'IV-1');
  assert.match(calls[1].url, /\/Invoices\/createbyquotation\?getResult=1$/);
  assert.equal(calls[1].body.PeakInvoices.invoices.status, 'Draft');
});

test('a document-level error inside a successful create is reported', async () => {
  peak._test.reset();
  fakePeak([tokenOk, () => [200, { PeakQuotations: { quotations: [{ resCode: '400', resDesc: 'productCode not found' }], resCode: '200' } }]]);
  const { body } = peak.buildQuotation({ requestId: 'REQ-1', clientCode: 'C1' }, [{ role: 'hero', qty: 1, unitPrice: 100, description: 'x' }], () => 'B2B-PVT');
  await assert.rejects(peak.createQuotationDraft(body), /productCode not found/);
});

test('PEAK_MODE off sends nothing', async () => {
  process.env.PEAK_MODE = 'off';
  fakePeak([]);
  await assert.rejects(peak.getQuotation('q1'), /PEAK_MODE = off/);
  process.env.PEAK_MODE = 'uat';
});
