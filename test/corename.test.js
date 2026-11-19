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

require('node:test')('customer type from the PEAK business unit when the document has no customer type', () => {
  const { segOf } = require('../lib/peaksync')._test, a = require('node:assert');
  a.strictEqual(segOf({ G013: 'G013-00002' }, 'Others'), 'B2C');
  a.strictEqual(segOf({ G013: 'G013-00002' }, 'B2E'), '');
  a.strictEqual(segOf({ G013: 'G013-00005' }, 'B2C'), 'MaoMao');
  a.strictEqual(segOf({ G013: 'G013-00001' }, 'B2C'), 'B2B');
  a.strictEqual(segOf({ G012: 'G012-00003', G013: 'G013-00002' }, 'Others'), 'B2S');
});
