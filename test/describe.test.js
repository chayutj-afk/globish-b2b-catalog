const test = require('node:test');
const assert = require('node:assert');
process.env.ANTHROPIC_API_KEY = 'test';
const d = require('../lib/describe');

const reply = (text, stop = 'end_turn') => ({ ok: true, json: async () => ({ stop_reason: stop, content: [{ type: 'text', text }] }) });

test('describe: a reply cut off at the token limit is asked again with more room', async () => {
  const keep = global.fetch, warn = console.warn; const calls = [];
  console.warn = () => {};
  global.fetch = async (_u, o) => { const b = JSON.parse(o.body); calls.push(b.max_tokens); return calls.length === 1 ? reply('{"ok":true,"description":"แพ็กเกจคลาส', 'max_tokens') : reply('```json\n{"ok":true,"description":"บรรทัด 1\\nบรรทัด 2"}\n```'); };
  const r = await d.describeLine({ base: 'x', note: 'y', lang: 'TH' });
  assert.deepStrictEqual(r, { ok: true, description: 'บรรทัด 1\nบรรทัด 2' });
  assert.deepStrictEqual(calls, [4000, 8000]);
  global.fetch = async () => reply('ขออภัย ไม่สามารถทำได้');
  await assert.rejects(() => d.describeLine({ base: 'x', note: 'y' }), /ไม่ใช่ JSON/);
  global.fetch = async () => reply('{"ok":false,"reason":"ขัดกัน"}');
  assert.deepStrictEqual(await d.describeLine({ base: 'x', note: 'y' }), { ok: false, reason: 'ขัดกัน' });
  global.fetch = keep; console.warn = warn;
});
