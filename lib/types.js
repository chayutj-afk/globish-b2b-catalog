// Customer types = PEAK classification G012 (ประเภทลูกค้า). The type Sales picks on a form decides:
//   vat    'incl' | 'excl'   prices on the QT include VAT or not
//   kinds  what can go on the QT: catalog (B2B Catalog), keyhs (Customized Package), surcharge, service (WH package / PEAK service)
//   opp    an Opportunity ID from CRM is required
//   svcGroups  services are picked from PEAK lists instead of typing a WH Package ID, e.g. for B2S:
//              [{ label: 'บริการ B2S', prefixes: ['B2S'] }, { label: 'Assessment', keyword: 'Assessment' }]
//              (a service is in a group when its code starts with one of the prefixes or its name has the keyword)
// The item names from PEAK (B2C / B2B / B2S) are what the app stores as "segment" (Requests E, AR, reports).
// Rules live in the ClassRules tab (scope 'type', key = G012 item, item = JSON), edited on /users; a type
// added in PEAK can be picked only once its rules are set.

const hub = require('./hub');

const GROUP = 'G012';
const KINDS = ['catalog', 'keyhs', 'surcharge', 'service'];
const DEFAULTS = {
  'G012-00001': { name: 'B2C', vat: 'incl', kinds: ['service'], opp: true, prefix: '' },
  'G012-00002': { name: 'B2B', vat: 'excl', kinds: ['catalog', 'keyhs', 'surcharge'], opp: true, prefix: '' },
  'G012-00003': { name: 'B2S', vat: 'excl', kinds: ['service'], opp: false, svcGroups: [{ label: 'บริการ B2S', prefixes: ['B2S'] }, { label: 'Assessment', keyword: 'Assessment' }] },
};

const up = (v, n) => String(v || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, n);
function cleanGroups(list, legacyPrefix) {
  const src = Array.isArray(list) ? list : legacyPrefix ? [{ label: `บริการ ${legacyPrefix}`, prefixes: [legacyPrefix] }] : [];
  return src.map((g) => ({
    label: String(g && g.label || '').trim().slice(0, 60),
    prefixes: [...new Set((Array.isArray(g && g.prefixes) ? g.prefixes : String(g && g.prefixes || '').split(/[,\s]+/)).map((p) => up(p, 20)).filter(Boolean))].slice(0, 10),
    keyword: String(g && g.keyword || '').trim().slice(0, 40),
  })).filter((g) => g.label && (g.prefixes.length || g.keyword)).slice(0, 10);
}
function cleanRule(x) {
  const r = x && typeof x === 'object' ? x : {};
  const kinds = (Array.isArray(r.kinds) ? r.kinds : []).filter((k) => KINDS.includes(k));
  const svcGroups = kinds.includes('service') ? cleanGroups(r.svcGroups, up(r.prefix, 20)) : [];
  return { vat: r.vat === 'incl' ? 'incl' : 'excl', kinds, opp: r.opp !== false, svcGroups, prefix: svcGroups.length ? 'PEAK' : '' };
}
// Is a PEAK service in one of the type's groups?
const inGroup = (g, s) => g.prefixes.some((p) => String(s.code || '').toUpperCase().startsWith(p)) || (g.keyword && String(s.name || '').toLowerCase().includes(g.keyword.toLowerCase()));

// [{ code, name, vat, kinds, opp, prefix, ready }] — every G012 item in PEAK (or the defaults while PEAK can't be read).
async function list() {
  const rows = await hub.readTable('ClassRules').catch(() => []);
  const saved = {};
  for (const r of rows) if (r.group === GROUP && r.scope === 'type') { try { saved[r.key] = cleanRule(JSON.parse(r.item)); } catch { /* skip */ } }
  let items = null;
  try { const g = (await require('./classrules').peakGroups()).find((x) => x.code === GROUP); if (g) items = g.items; } catch { /* PEAK off */ }
  if (!items) items = Object.entries(DEFAULTS).map(([code, d]) => ({ code, name: d.name }));
  return items.map((i) => {
    const rule = saved[i.code] || (DEFAULTS[i.code] && cleanRule(DEFAULTS[i.code]));
    return { code: i.code, name: i.name, ...(rule || cleanRule({})), ready: !!rule && rule.kinds.length > 0 };
  });
}

const bad = (m, s = 400) => Object.assign(new Error(m), { status: s });
// The type a form sent (by G012 item code, or by name for older pages).
async function resolve(value) {
  const v = String(value || '').trim();
  const types = await list();
  const t = types.find((x) => x.code === v) || types.find((x) => x.name === v);
  if (!t) throw bad('เลือกประเภทลูกค้า');
  if (!t.ready) throw bad(`ประเภทลูกค้า ${t.name} ยังไม่ได้ตั้งกติกา (VAT / สินค้า) ให้ฝ่ายบัญชีตั้งที่หน้าจัดการผู้ใช้ก่อน`);
  return t;
}

// Accounting / admin sets the rules of one type.
async function save(code, rule, by) {
  const types = await list();
  const t = types.find((x) => x.code === code);
  if (!t) throw bad(`ไม่พบประเภทลูกค้า ${code} ใน PEAK`);
  const r = cleanRule(rule);
  if (r.kinds.includes('service') && Array.isArray(rule.svcGroups) && rule.svcGroups.length && !r.svcGroups.length) throw bad('กลุ่มบริการต้องมีชื่อ และรหัสขึ้นต้นหรือคำในชื่ออย่างน้อยหนึ่งอย่าง');
  if (!r.kinds.length) throw bad('เลือกสินค้าที่ใช้ได้อย่างน้อย 1 แบบ');
  const rows = (await hub.readTable('ClassRules').catch(() => [])).map(({ _row, ...x }) => x).filter((x) => !(x.group === GROUP && x.scope === 'type' && x.key === code));
  rows.push({ group: GROUP, scope: 'type', key: code, item: JSON.stringify(r), updatedBy: by, updatedAt: hub.sheetDateTime() });
  await hub.replaceTable('ClassRules', rows);
  await hub.log('users', 'customer_type', code, `${by} · ${JSON.stringify(r)}`);
}

module.exports = { GROUP, KINDS, DEFAULTS, list, resolve, save, cleanRule, inGroup };
