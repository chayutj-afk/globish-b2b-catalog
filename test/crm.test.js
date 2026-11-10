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

test('PEAK client code is any PEAK code; a failed tax check digit is flagged, not blocked', () => {
  const o = { ...qt, opportunityId: 'CRM-OPP-2026-00001' };
  assert.equal(validate({ ...o, clientCode: 'c00123' }).r.clientCode, 'C00123');
  assert.equal(validate({ ...o, clientCode: 'cb00458' }).r.clientCode, 'CB00458');
  assert.throws(() => validate({ ...o, clientCode: 'C 12/3' }), /รหัสลูกค้า/);
  assert.match(validate({ ...o, taxId: '0105555555555' }).r.note, /ตรวจเลขภาษี/);
  // tax ID is required in every segment, even with a client code
  for (const segment of ['B2B', 'B2E', 'B2S', 'Others']) {
    assert.throws(() => validate({ ...o, segment, taxId: '', clientCode: 'C01988' }), /13 หลัก/);
  }
});

test('INV requests accept an optional, well-formed Opportunity ID', () => {
  const base = { qtNo: 'QO-1', company: 'Co', taxId: '0105555555554', evidenceType: 'PO จากลูกค้า', evidenceLink: 'https://drive.google.com/x', invoices: [{ amountPreVat: 100 }] };
  assert.equal(inv.validate(base).r.opportunityId, '');
  assert.throws(() => inv.validate({ ...base, opportunityId: 'x' }), /รูปแบบ/);
});

test('contact lookup matches the tax ID digits and the branch (blank = head office)', () => {
  const { match } = require('../api/contacts')._test;
  const rows = [
    { taxId: '0-1355-61012-50-8', branch: '00000', code: 'CA00101', name: 'A' },
    { taxId: '0135561012508', branch: '', code: 'CA00102', name: 'A dup' },
    { taxId: '0135561012508', branch: '00002', code: 'CA00103', name: 'A br2' },
  ];
  assert.deepEqual(match(rows, '0135561012508', '00000').matches.map((x) => x.code), ['CA00101', 'CA00102']);
  assert.deepEqual(match(rows, '0135561012508', '00002').matches.map((x) => x.code), ['CA00103']);
  const none = match(rows, '0135561012508', '00009');
  assert.equal(none.matches.length, 0);
  assert.equal(none.otherBranches.length, 3);
});

test('contact import keeps only 13-digit tax IDs with a code, strips dashes, defaults branch', () => {
  const { cleanRows } = require('../api/contacts')._test;
  const out = cleanRows([
    { taxId: '0-1355-61012-50-8', branch: '', code: 'CA00101', name: 'A' },
    { taxId: '61-1974052', branch: '00000', code: 'VC00551', name: 'foreign' },
    { taxId: '0105555555554', branch: '2', code: '', name: 'no code' },
    { taxId: '0105555555554', branch: '2', code: 'CB1', name: 'B' },
  ]);
  assert.deepEqual(out.map((x) => [x.taxId, x.branch, x.code]), [['0135561012508', '00000', 'CA00101'], ['0105555555554', '00002', 'CB1']]);
});
