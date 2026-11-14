const test = require('node:test');
const L = { students: 5, wantedIssueDate: '2026-11-20', creditTermDays: 30, originalDoc: 'unknown' };
const assert = require('node:assert');
const { normaliseOppId, OPP_RE } = require('../lib/crm');
const { validate } = require('../api/requests.js')._test;
const inv = require('../api/invoice-requests.js')._test;

test('Opportunity ID is normalised from typed text or a pasted CRM link', () => {
  assert.equal(normaliseOppId(' crm-opp-2026-00123 '), 'CRM-OPP-2026-00123');
  assert.equal(normaliseOppId('https://globish-b2b.s.frappe.cloud/app/opportunity/CRM-OPP-2025-01067'), 'CRM-OPP-2025-01067');
  assert.ok(!OPP_RE.test(normaliseOppId('OPP-123')));
});

const qt = { segment: 'B2B', dealType: 'Retention', company: 'Co', taxId: '0105555555554', docLang: 'TH', wantedQtDate: '2026-11-15', creditTermDays: 30, whtRate: '3', customerEmail: 'a@b.co', items: [{ packageId: 'SPD-03-36', students: 10 }] };
const svc = [{ kind: 'service', code: '3822', name: 'Essential', qty: 5, unitPrice: 15900 }];

test('every segment but B2S needs an Opportunity ID; B2S never carries one; QT date and credit term are required', () => {
  assert.throws(() => validate(qt), /Opportunity ID/);
  assert.equal(validate({ ...qt, opportunityId: 'crm-opp-2026-00001' }).r.opportunityId, 'CRM-OPP-2026-00001');
  assert.throws(() => validate({ ...qt, segment: 'B2E', items: svc }), /Opportunity ID/);
  assert.throws(() => validate({ ...qt, segment: 'B2E', items: svc, opportunityId: 'nope' }), /รูปแบบ/);
  assert.equal(validate({ ...qt, segment: 'B2S', items: svc, opportunityId: 'CRM-OPP-2026-00001' }).r.opportunityId, '');
  assert.throws(() => validate({ ...qt, segment: 'Others', items: svc }), /Opportunity ID/);
  assert.throws(() => validate({ ...qt, segment: 'B2C', items: svc }), /Opportunity ID/);
  assert.ok(validate({ ...qt, segment: 'B2C', items: svc, opportunityId: 'CRM-OPP-2026-00002' }));
  assert.throws(() => validate({ ...qt, segment: 'B2C', items: [{ packageId: 'SPD-03-36', students: 10 }], opportunityId: 'CRM-OPP-2026-00002' }), /B2C/);
  const ok = { ...qt, opportunityId: 'CRM-OPP-2026-00001' };
  assert.throws(() => validate({ ...ok, wantedQtDate: '' }), /วันที่ต้องการให้ลงใน QT/);
  assert.throws(() => validate({ ...ok, creditTermDays: '' }), /เครดิตเทอม/);
  assert.throws(() => validate({ ...ok, whtRate: '' }), /หัก ณ ที่จ่าย/);
  assert.throws(() => validate({ ...ok, whtRate: '7' }), /หัก ณ ที่จ่าย/);
  assert.equal(validate({ ...ok, whtRate: '0' }).r.whtRate, '0');
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
  const base = { poNeeded: 'no', financeContact: 'A', financeEmail: 'a@b.co', financePhone: '0812345678', whtRate: '3', qtNo: 'QO-1', company: 'Co', taxId: '0105555555554', evidenceType: 'PO จากลูกค้า', file: { name: 'qt.pdf', type: 'application/pdf', data: 'JVBERi0=' }, invoices: [{ ...L, amountPreVat: 100 }] };
  assert.equal(inv.validate(base).r.opportunityId, '');
  assert.throws(() => inv.validate({ ...base, opportunityId: 'x' }), /รูปแบบ/);
});

test('contact lookup splits PEAK contacts into this branch and the others', () => {
  const { split } = require('../api/contacts')._test;
  const all = [{ code: 'CA00101', branch: '00000' }, { code: 'CA00103', branch: '00002' }];
  assert.deepEqual(split(all, '00000').matches.map((x) => x.code), ['CA00101']);
  assert.deepEqual(split(all, '00000').otherBranches.map((x) => x.code), ['CA00103']);
  assert.equal(split(all, '').matches.length, 2, 'no branch = every branch');
  assert.equal(split(all, '00009').otherBranches.length, 2);
});

test('service lookup: proposed codes are not in PEAK, deactivating codes are flagged', () => {
  const { lookup } = require('../api/services')._test;
  const map = new Map([['3822', { code: '3822', name: 'ECD', group: 'B2E', proposal: 'เก็บไว้' }], ['1145', { code: '1145', name: 'Old', group: '', proposal: 'ปิดใช้งาน' }]]);
  assert.deepEqual(lookup(map, ' 3822 '), { found: true, code: '3822', name: 'ECD', group: 'B2E', inactive: false });
  assert.equal(lookup(map, '1145').inactive, true);
  assert.equal(lookup(map, '9999').found, false);
});

test('services list follows the accounting decision in column G', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const f = path.join(os.tmpdir(), `svc-${process.pid}.json`);
  fs.writeFileSync(f, JSON.stringify({ PeakServices: [
    ['3822', 'ECD', 'B2E', 'ขายได้', 'เก็บไว้', '', 'ตามข้อเสนอ'],
    ['466', 'Old', 'Adult', 'Inactive', 'ปิดใช้งาน', '', 'ตามข้อเสนอ'],
    ['1305', 'Review', 'Adult', '', 'ตรวจก่อน', '', 'ปิดใช้งาน'],
    ['4974_TikTok', 'Tik', 'Adult', '', 'ตรวจก่อน', '', 'เก็บไว้'],
    ['B2B-PVT', 'PVT', 'B2B', '', 'สร้างแล้ว', '', 'ตามข้อเสนอ'],
    ['0001A', 'Legacy', 'B2B', '', 'ปิดใช้งาน (หลังเริ่มใช้รหัสใหม่)', '', 'ตามข้อเสนอ'],
  ] }));
  const prev = [process.env.HUB_MODE, process.env.HUB_MOCK_FILE];
  process.env.HUB_MODE = 'mock'; process.env.HUB_MOCK_FILE = f;
  const map = await require('../lib/hub').readServices();
  [process.env.HUB_MODE, process.env.HUB_MOCK_FILE] = prev;
  fs.unlinkSync(f);
  assert.deepEqual([...map.keys()].sort(), ['0001A', '3822', '4974_TIKTOK', 'B2B-PVT']);
  const { lookup } = require('../api/services')._test;
  assert.equal(lookup(map, '0001A').inactive, true);
  assert.equal(lookup(map, '466').found, false);
});
