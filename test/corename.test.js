const test = require('node:test'); const assert = require('node:assert');
const { coreName } = require('../lib/peaksync')._test;
test('same company with and without its legal form', () => {
  assert.strictEqual(coreName('บริษัท วันไทยอุตสาหกรรมการอาหาร จำกัด'), coreName('วันไทยอุตสาหกรรมการอาหาร'));
  assert.strictEqual(coreName('บริษัท เจริญโภคภัณฑ์อาหาร จำกัด (มหาชน)'), coreName('เจริญโภคภัณฑ์อาหาร'));
  assert.strictEqual(coreName('NYK LINE (THAILAND) CO., LTD.'), coreName('NYK Line (Thailand)'));
});
test('a real change of name is still a change', () => {
  assert.notStrictEqual(coreName('บริษัท ไทยโพลิเอททีลีน จำกัด'), coreName('บริษัท ไทยโพลิเอททีลีน (ระยอง) จำกัด'));
  assert.notStrictEqual(coreName('วันไทย'), coreName('วันไทยอุตสาหกรรมการอาหาร'));
});
