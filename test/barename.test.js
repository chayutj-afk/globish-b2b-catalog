const test = require('node:test'); const assert = require('node:assert');
const { bareName } = require('../lib/newcontact');
test('legal form and head-office words are not sent to PEAK (it prints them from the type)', () => {
  assert.strictEqual(bareName('บริษัทบริหารสินทรัพย์ กรุงเทพพาณิชย์ จำกัด (มหาชน) สำนักงานใหญ่', 3), 'บริหารสินทรัพย์ กรุงเทพพาณิชย์');
  assert.strictEqual(bareName('บริษัท บริหารสินทรัพย์ กรุงเทพพาณิชย์ จำกัด (มหาชน)', 3), 'บริหารสินทรัพย์ กรุงเทพพาณิชย์');
  assert.strictEqual(bareName('บริษัท วันไทยอุตสาหกรรมการอาหาร จำกัด', 2), 'วันไทยอุตสาหกรรมการอาหาร');
  assert.strictEqual(bareName('บริษัท ไทยโพลิเอททีลีน จำกัด สาขา 00001', 2), 'ไทยโพลิเอททีลีน');
  assert.strictEqual(bareName('ห้างหุ้นส่วนจำกัด ทดสอบ', 1), 'ทดสอบ');
});
test('other names are left alone', () => {
  assert.strictEqual(bareName('NYK LINE (THAILAND) CO., LTD.', 2), 'NYK LINE (THAILAND) CO., LTD.');
  assert.strictEqual(bareName('สมชาย ใจดี', 5), 'สมชาย ใจดี');
  assert.strictEqual(bareName('มูลนิธิทดสอบ', 9), 'มูลนิธิทดสอบ');
  assert.strictEqual(bareName('บริษัท จำกัด', 2), 'บริษัท จำกัด');
});
