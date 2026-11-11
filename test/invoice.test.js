const test = require('node:test');
const L = { students: 5, wantedIssueDate: '2026-11-20', creditTermDays: 30 };
const assert = require('node:assert');
const { validate, alreadyInvoiced } = require('../api/invoice-requests.js')._test;

const base = {
  poNeeded: 'no', whtRate: '3', qtNo: 'QO-20261100001', company: 'Co', taxId: '0105555555554',
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
});

test('already-invoiced amount ignores rejected requests', () => {
  const rows = [
    { requestId: 'REQ-1', amountPreVat: '30,000', status: 'new' },
    { requestId: 'REQ-1', amountPreVat: '5000', status: 'rejected' },
    { requestId: 'REQ-2', amountPreVat: '1', status: 'new' },
  ];
  assert.equal(alreadyInvoiced(rows, { requestId: 'REQ-1' }), 30000);
});
