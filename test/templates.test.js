const test = require('node:test');
const assert = require('node:assert');
const templates = require('../lib/templates');
const p = require('../lib/pricing');

test('templates: numbers come from the package, not from the wording', () => {
  templates._set({});
  const r = p.priceItem({ packageId: 'PVTK-06-36-GB-8DC-72SPD', students: 3, lang: 'TH' });
  assert.match(r.lines[0].description, /^คลาสเรียนแบบตัวต่อตัวกับโค้ช จำนวน 36 คลาส \(คลาสละ 25 นาที\)/);
  assert.match(r.lines[0].description, /\nระยะเวลา 6 เดือน · โค้ช/);
  assert.match(r.lines[0].description, /\n- Discussion Class \(คลาสสนทนากลุ่ม\) 8 ครั้ง\n/);
  assert.match(r.lines[1].description, /จำนวน 8 คลาส \(คลาสละ 55 นาที\)[\s\S]*\n\(รวมอยู่ในแพ็กเกจข้างต้น\)$/);
  assert.match(r.lines[2].description, /จำนวน 72 คลาส \(คลาสละ 30 นาที\)/);
  // Catalog packages no longer bundle Master Class / Workshop (Sales add them when they give them away).
  assert.strictEqual(r.lines.length, 3);
  const en = p.priceItem({ packageId: 'PVTK-06-36-GB-8DC-72SPD', students: 3, lang: 'EN' });
  assert.match(en.lines[0].description, /^One-on-one English coaching with a coach for 36 sessions/);
  // Master Class inside a (customized) package is written as a period, never a number of sessions.
  const keyHS = 'Private Class-36-6-Asian, European and Native/36-6-HERO-8-72-0-0-0-0-0-0-0-0-0-24-0';
  const mc = p.priceCustomKeyHS({ keyHS, qty: 3, unitPrice: 28000, lang: 'TH' }).lines.find((l) => l.component === 'Master Class');
  assert.match(mc.description, /ตลอดระยะเวลา 6 เดือน/); assert.doesNotMatch(mc.description, /24|12 /);
  const mcEn = p.priceCustomKeyHS({ keyHS, qty: 3, unitPrice: 28000, lang: 'EN' }).lines.find((l) => l.component === 'Master Class');
  assert.match(mcEn.description, /throughout the 6-month package/);
});

test('templates: Business Group Class is always 15 learners and 2 hours per topic; products without wording keep the short text', () => {
  templates._set({});
  assert.match(p.priceItem({ packageId: 'BGOS-12', students: 12 }).lines[0].description, /จัดการเรียนที่บริษัท[\s\S]*15 คน\/คลาส เรียนทั้งหมด 12 หัวข้อ \(24 ชั่วโมง\)/);
  assert.match(p.priceItem({ packageId: 'MSTC-NULL-90', students: 20, classes: 1 }).lines[0].description, /คลาสละ 90 นาที/);
  assert.match(p.priceItem({ packageId: 'WSOL-NULL-01-TH', students: 20, classes: 2 }).lines[0].description, /จัดในรูปแบบออนไลน์/);
  assert.match(p.priceItem({ packageId: 'GECB-04', students: 5 }).lines[0].description, /- Writing Skill \(2 Prompts\)/);
  assert.match(p.priceItem({ packageId: 'GECB-02', students: 5 }).lines[0].description, /^GECB 2 Skills: Receptive 1 ครั้ง/);
  assert.match(p.priceItem({ packageId: 'ENSD-03-04-S12', students: 5 }).lines[0].description, /^Engoo Standard 12 ครั้ง ระยะเวลา 3 เดือน/);
});

test('templates: the sheet overrides the wording; an empty cell or a missing tab keeps the default', async () => {
  templates._set({ DSC: { th: 'กลุ่มเล็ก {n} คลาส', en: '' } });
  const r = p.priceItem({ packageId: 'PVTK-06-36-GB-8DC-72SPD', students: 3, lang: 'TH' });
  assert.match(r.lines[1].description, /^กลุ่มเล็ก 8 คลาส\n/);
  assert.match(p.priceItem({ packageId: 'PVTK-06-36-GB-8DC-72SPD', students: 3, lang: 'EN' }).lines[1].description, /^Small-group English classes/);
  templates._set({});
  await templates.load({ readTable: async () => { throw new Error('Unable to parse range: DescTemplates!A2:E'); } });
  assert.match(p.priceItem({ packageId: 'PVTK-06-36-GB-8DC-72SPD', students: 3 }).lines[1].description, /^คลาสเรียนภาษาอังกฤษแบบกลุ่มเล็ก/);
});
