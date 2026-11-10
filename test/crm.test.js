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

const qt = { segment: 'B2B', dealType: 'Retention', company: 'Co', taxId: '0105555555555', docLang: 'TH', items: [{ packageId: 'SPD-03-36', students: 10 }] };

test('B2B QT requests need an Opportunity ID; other segments may leave it blank', () => {
  assert.throws(() => validate(qt), /Opportunity ID/);
  assert.equal(validate({ ...qt, opportunityId: 'crm-opp-2026-00001' }).r.opportunityId, 'CRM-OPP-2026-00001');
  assert.ok(validate({ ...qt, segment: 'B2E' }));
  assert.throws(() => validate({ ...qt, segment: 'B2E', opportunityId: 'nope' }), /รูปแบบ/);
});

test('INV requests accept an optional, well-formed Opportunity ID', () => {
  const base = { qtNo: 'QO-1', company: 'Co', evidenceType: 'PO จากลูกค้า', evidenceLink: 'https://drive.google.com/x' };
  assert.equal(inv.validate(base).opportunityId, '');
  assert.throws(() => inv.validate({ ...base, opportunityId: 'x' }), /รูปแบบ/);
});
