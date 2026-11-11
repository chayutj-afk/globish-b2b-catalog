const test = require('node:test');
const L = { students: 5, wantedIssueDate: '2026-11-20', creditTermDays: 30, originalDoc: 'unknown' };
const assert = require('node:assert');
const { validate, alreadyInvoiced } = require('../api/invoice-requests.js')._test;

const base = {
  poNeeded: 'no', financeContact: 'A', financeEmail: 'a@b.co', financePhone: '0812345678', whtRate: '3', qtNo: 'QO-20261100001', company: 'Co', taxId: '0105555555554',
  evidenceType: 'QT ที่ลูกค้าเซ็นแล้ว', file: { name: 'qt.pdf', type: 'application/pdf', data: 'JVBERi0=' },
  invoices: [{ ...L, amountPreVat: 50000 }],
};

test('needs QT number, evidence and at least one invoice with an amount', () => {
  assert.ok(validate(base));
  assert.throws(() => validate({ ...base, qtNo: '' }), /QT/);
  assert.throws(() => validate({ ...base, whtRate: undefined }), /หัก ณ ที่จ่าย/);
  assert.throws(() => validate({ ...base, file: undefined }), /แนบไฟล์/);
  assert.throws(() => validate({ ...base, evidenceType: 'อื่นๆ' }), /ระบุ/);
  assert.throws(() => validate({ ...base, invoices: [] }), /อย่างน้อย/);
  assert.throws(() => validate({ ...base, invoices: [{}] }), /ยอดก่อน VAT/);
  assert.throws(() => validate({ ...base, invoices: [{ ...L, students: '', amountPreVat: 1 }] }), /จำนวนผู้เรียน/);
  assert.throws(() => validate({ ...base, invoices: [{ ...L, wantedIssueDate: '', amountPreVat: 1 }] }), /วันที่ต้องการให้ลงใน INV/);
  assert.throws(() => validate({ ...base, invoices: [{ ...L, creditTermDays: '', amountPreVat: 1 }] }), /เครดิตเทอม/);
});

test('one QT can bill several entities; another entity needs its own name, valid tax ID and relation', () => {
  const two = { ...base, invoices: [{ ...L, amountPreVat: 30000 }, { ...L, billTo: 'other', company: 'Sub Co', taxId: '0107555000015', relation: 'บริษัทลูก', amountPreVat: 20000 }] };
  const { invoices } = validate(two);
  assert.equal(invoices[0].company, 'Co');
  assert.equal(invoices[0].branch, '00000');
  assert.equal(invoices[1].company, 'Sub Co');
  assert.throws(() => validate({ ...two, invoices: [{ ...L, billTo: 'other', company: 'Sub', taxId: '0107555000015', amountPreVat: 1 }] }), /ความสัมพันธ์/);
  assert.throws(() => validate({ ...two, invoices: [{ ...L, billTo: 'other', company: 'Sub', relation: 'x', amountPreVat: 1 }] }), /13 หลัก/);
  assert.throws(() => validate({ ...two, invoices: [{ ...L, billTo: 'other', company: 'Sub', relation: 'x', taxId: '010755500001', amountPreVat: 1 }] }), /13 หลัก/);
  assert.equal(validate({ ...two, invoices: [{ ...L, billTo: 'other', company: 'Sub', relation: 'x', taxId: '0107555000016', amountPreVat: 1 }] }).invoices[0].taxCheckWarn, true);
});

test('asking for the original document needs an address', () => {
  assert.throws(() => validate({ ...base, invoices: [{ ...L, amountPreVat: 1, originalDoc: 'yes' }] }), /ตัวจริง/);
  assert.equal(validate({ ...base, invoices: [{ ...L, amountPreVat: 1 }] }).invoices[0].originalDoc, 'unknown');
  assert.throws(() => validate({ ...base, invoices: [{ ...L, amountPreVat: 1, originalDoc: '' }] }), /ตัวจริง/);
});

test('already-invoiced amount ignores rejected requests', () => {
  const rows = [
    { requestId: 'REQ-1', amountPreVat: '30,000', status: 'new' },
    { requestId: 'REQ-1', amountPreVat: '5000', status: 'rejected' },
    { requestId: 'REQ-2', amountPreVat: '1', status: 'new' },
  ];
  assert.equal(alreadyInvoiced(rows, { requestId: 'REQ-1' }), 30000);
});

test('column-layout guard: live headers match, moved column is caught', () => {
  const hub = require('../lib/hub');
  const live = ['Email', 'Name', 'Role (sales = Sales, lead = หัวหน้าเซล, op = บัญชี)', 'First login', 'Last login', 'Role changed by', 'Role changed at',
    'Team (b2b / b2c / both, ว่าง = both · b2c ไม่เห็น Catalog)', 'PEAK Sales Performance (G014 code, from Lists!K)', 'Extra permissions (comma list)'];
  assert.equal(hub.layoutProblem('Users', live), '');
  const moved = [...live]; moved.splice(2, 0, 'Phone');
  assert.match(hub.layoutProblem('Users', moved), /คอลัมน์ C/);
  assert.match(hub.layoutProblem('Users', live.slice(0, 9)), /คอลัมน์ J/, 'missing last column');
  assert.equal(hub.layoutProblem('Requests', require('../lib/headers').Requests.map((h) => h.replace('WHT %', 'WHT % (หัก ณ ที่จ่าย: 0 = ไม่หัก)'))), '');
  for (const t of Object.keys(hub.TABLES)) assert.equal(require('../lib/headers')[t].length, hub.TABLES[t].length, t);
});

test('PEAK number/link checks catch wrong type and reuse', () => {
  const p = require('../lib/peakdoc');
  const invLink = 'https://doc.peakaccount.com/invoice?emi=MTE5MDU0&eti=MTE5ODE5NTEz';
  assert.match(p.checkDoc('RT', 'RT-2026111111', invLink), /ใบแจ้งหนี้/);
  assert.match(p.checkDoc('INV', 'QO-20261100023', ''), /ใบเสนอราคา/);
  assert.match(p.checkDoc('INV', 'IV-1', 'https://doc.peakaccount.com/?emi=a&eti=b&etti=MQ=='), /ใบเสนอราคา/);
  assert.equal(p.checkDoc('INV', 'IV-20261100016', 'https://doc.peakaccount.com/?emi=MTE5MDU0&eti=MTE5ODE5NTEz&etti=Mg=='), '');
  assert.match(p.checkDoc('INV', 'IV-1', 'https://example.com/x'), /ลิงก์ต้องเป็น/);
  const used = [{ no: 'IV-20261100016', link: invLink, ref: 'INVREQ-A', taxId: '0999999990012', label: 'INV ของคำขอ INVREQ-A' }];
  assert.match(p.findReuse(used, { no: 'iv-20261100016', ref: 'INVREQ-B' }), /INVREQ-A/);
  assert.match(p.findReuse(used, { link: 'https://doc.peakaccount.com/?emi=MTE5MDU0&eti=MTE5ODE5NTEz&etti=Mg==', ref: 'X' }), /ลิงก์นี้/);
  assert.equal(p.findReuse(used, { no: 'IV-20261100016', ref: 'INVREQ-A' }), '', 'same record is fine');
  assert.equal(p.findReuse(used, { no: 'IV-20261100016', ref: 'R', taxId: '0999999990012', sameCustomerOk: true }), '');
});
