const test = require('node:test'); const assert = require('node:assert');
const { createCoded } = require('../lib/newcontact');
const hubOf = (v) => { const s = { ...v }; return { s, getSetting: async (k) => s[k] ?? '', setSetting: async (k, x) => { s[k] = String(x); } }; };
test('contact code by customer type, running number from Settings', async () => {
  const made = []; const peak = { createContact: async (b) => { made.push(b.code); return { id: 'x', code: b.code || 'V00009', name: b.name }; } };
  const hub = hubOf({ 'Next contact no. CB': '1301', 'Next contact no. C': '14890' });
  assert.strictEqual((await createCoded(peak, hub, { name: 'ก' }, 'B2B')).code, 'CB01301');
  assert.strictEqual(hub.s['Next contact no. CB'], '1302');
  assert.strictEqual((await createCoded(peak, hub, { name: 'ข' }, 'B2C')).code, 'C14890');
  // no number set for this prefix, or another customer type → PEAK's own code
  assert.strictEqual((await createCoded(peak, hub, { name: 'ค' }, 'B2E')).code, 'V00009');
  assert.strictEqual((await createCoded(peak, hub, { name: 'ง' }, 'B2S')).code, 'V00009');
  assert.deepStrictEqual(made, ['CB01301', 'C14890', undefined, undefined]);
});
test('a code PEAK already has is skipped; other errors are not swallowed', async () => {
  const taken = new Set(['CE00012', 'CE00013']);
  const peak = { createContact: async (b) => { if (taken.has(b.code)) throw new Error('รหัสผู้ติดต่อซ้ำ'); return { id: 'x', code: b.code, name: b.name }; } };
  const hub = hubOf({ 'Next contact no. CE': '12' });
  assert.strictEqual((await createCoded(peak, hub, { name: 'ก' }, 'B2E')).code, 'CE00014');
  assert.strictEqual(hub.s['Next contact no. CE'], '15');
  await assert.rejects(createCoded({ createContact: async () => { throw new Error('taxNumber invalid'); } }, hub, { name: 'ก' }, 'B2E'), /taxNumber/);
  assert.strictEqual(hub.s['Next contact no. CE'], '15');
});
