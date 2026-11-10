const test = require('node:test');
const assert = require('node:assert');
const { validate } = require('../api/invoice-requests.js')._test;

const base = { qtNo: 'QO-20261100001', company: 'Co', evidenceType: 'QT ที่ลูกค้าเซ็นแล้ว', evidenceLink: 'https://drive.google.com/file/d/x/view' };

test('needs QT number, company and evidence', () => {
  assert.ok(validate(base));
  assert.throws(() => validate({ ...base, qtNo: '' }), /QT/);
  assert.throws(() => validate({ ...base, evidenceLink: '' }), /แนบไฟล์/);
  assert.throws(() => validate({ ...base, evidenceLink: 'https://evil.example/x' }), /Google Drive/);
  assert.throws(() => validate({ ...base, evidenceType: 'อื่นๆ' }), /ระบุ/);
});

test('installments need a label and an amount', () => {
  assert.throws(() => validate({ ...base, billing: 'installment' }), /งวด/);
  assert.throws(() => validate({ ...base, billing: 'installment', installment: '1/2' }), /ยอด/);
  const r = validate({ ...base, billing: 'installment', installment: '1/2', amountPreVat: 50000 });
  assert.equal(r.billing, 'Installment');
});
