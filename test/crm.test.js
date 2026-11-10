const test = require('node:test');
const assert = require('node:assert');
const { normaliseOppId, OPP_RE } = require('../lib/crm');
const { validate } = require('../api/requests.js')._test;
const inv = require('../api/invoice-requests.js')._test;

test('Opportunity ID is normalised from typed text or a pasted CRM link', () => {
  assert.equal(normaliseOppId(' crm-opp-2026-00123 '), 'CRM-OPP-2026-00123');
  assert.equal(normaliseOppId('https://globish-b2b.s.frappe.cloud/app/opportunity/CRM-OPP-2025-01067'), 'CRM-OPP-2025-01067');
  assert.ok(!OPP_RE.test(normaliseOppId('OPP-123')));
});

const qt = { segment: 'B2B', dealType: 'Retention', company: 'Co', taxId: '0105555555554', docLang: 'TH', items: [{ packageId: 'SPD-03-36', students: 10 }] };
const svc = [{ kind: 'service', code: '3822', name: 'Essential', qty: 5, unitPrice: 15900 }];

test('B2B and B2E need an Opportunity ID; B2S never carries one', () => {
  assert.throws(() => validate(qt), /Opportunity ID/);
  assert.equal(validate({ ...qt, opportunityId: 'crm-opp-2026-00001' }).r.opportunityId, 'CRM-OPP-2026-00001');
  assert.throws(() => validate({ ...qt, segment: 'B2E', items: svc }), /Opportunity ID/);
  assert.throws(() => validate({ ...qt, segment: 'B2E', items: svc, opportunityId: 'nope' }), /รูปแบบ/);
  assert.equal(validate({ ...qt, segment: 'B2S', items: svc, opportunityId: 'CRM-OPP-2026-00001' }).r.opportunityId, '');
  assert.ok(validate({ ...qt, segment: 'Others', items: svc }));
});

test('PEAK client code is C + 5 digits; a failed tax check digit is flagged, not blocked', () => {
  const o = { ...qt, opportunityId: 'CRM-OPP-2026-00001' };
  assert.equal(validate({ ...o, clientCode: 'c00123' }).r.clientCode, 'C00123');
  assert.throws(() => validate({ ...o, clientCode: 'C123' }), /C ตามด้วย/);
  assert.match(validate({ ...o, taxId: '0105555555555' }).r.note, /ตรวจเลขภาษี/);
});

test('INV requests accept an optional, well-formed Opportunity ID', () => {
  const base = { qtNo: 'QO-1', company: 'Co', evidenceType: 'PO จากลูกค้า', evidenceLink: 'https://drive.google.com/x', invoices: [{ amountPreVat: 100 }] };
  assert.equal(inv.validate(base).r.opportunityId, '');
  assert.throws(() => inv.validate({ ...base, opportunityId: 'x' }), /รูปแบบ/);
});
