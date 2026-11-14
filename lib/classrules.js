// Which PEAK classification items the app puts on its documents (QT 101, INV 102, RT 103).
//
// The groups and their items come from PEAK (GET /Classification), so a group or item accounting adds
// in PEAK shows up in the app by itself. What the app should pick is kept in the Revenue Hub tab
// ClassRules, edited on /users:
//   group | scope | key | item
//   G012  | mode    |         | segment      ← how this group is chosen: segment / seller / off
//   G012  | segment | B2B     | G012-00002   ← by customer segment
//   G014  | mode    |         | seller
//   G014  | user    | a@g…    | B2B-S001     ← by the seller who made the request
// An empty tab = the rules the app started with (below), with G014 per seller from Users.salesPerf.

const hub = require('./hub');
const peak = require('./peak');

const SEGMENTS = ['B2B', 'B2C', 'MaoMao', 'B2E', 'B2S', 'Others'];
const MODES = ['segment', 'seller', 'off'];
const DEFAULTS = {
  G012: { mode: 'segment', segments: { B2B: 'G012-00002', B2C: 'G012-00001', B2E: 'G012-00001', MaoMao: 'G012-00001', B2S: 'G012-00003' } },
  G013: { mode: 'segment', segments: { B2B: 'G013-00001', B2C: 'G013-00002', B2E: 'G013-00002', MaoMao: 'G013-00005' } },
  G014: { mode: 'seller', segments: {} },
};
const low = (e) => String(e || '').trim().toLowerCase();

// { group: { mode, segments: { seg: item }, users: { email: item } } }
async function load(users) {
  const rows = await hub.readTable('ClassRules').catch(() => []);
  const rules = {};
  const g = (code) => (rules[code] = rules[code] || { mode: 'off', segments: {}, users: {} });
  if (!rows.length) for (const [code, r] of Object.entries(DEFAULTS)) Object.assign(g(code), { mode: r.mode, segments: { ...r.segments } });
  for (const r of rows) {
    const code = String(r.group || '').trim(); if (!code) continue;
    if (r.scope === 'mode') g(code).mode = MODES.includes(r.item) ? r.item : 'off';
    else if (r.scope === 'segment' && r.item) g(code).segments[r.key] = r.item;
    else if (r.scope === 'user' && r.item) g(code).users[low(r.key)] = r.item;
  }
  // Sales Performance set before ClassRules existed lives in Users.salesPerf.
  if (rules.G014) for (const u of users || []) if (u.salesPerf && !rules.G014.users[low(u.email)]) rules.G014.users[low(u.email)] = u.salesPerf;
  return rules;
}

// [[group, item]] for a request row made by `email`, plus groups that should have had one but don't.
function pick(rules, row, email) {
  const out = [], missing = [];
  for (const [code, r] of Object.entries(rules)) {
    const item = r.mode === 'segment' ? r.segments[row.segment] : r.mode === 'seller' ? r.users[low(email)] : '';
    if (item) out.push([code, item]);
    else if (r.mode === 'seller') missing.push(code);
  }
  return { tags: out, missing };
}

// Groups that can go on revenue documents (financeType 0 = both, 1 = revenue), live from PEAK, cached 5 min.
let cache = null;
async function peakGroups() {
  if (cache && Date.now() - cache.at < 300e3) return cache.list;
  const list = (await peak.listClassificationGroups())
    .filter((x) => [0, 1].includes(Number(x.classificationDocumentFinanceType ?? 0)))
    .map((x) => ({ code: x.number, name: x.name, description: x.description || '', items: (x.classificationItemList || []).map((i) => ({ code: i.number, name: i.name })) }));
  cache = { at: Date.now(), list };
  return list;
}

function toRows(rules, by) {
  const at = hub.sheetDateTime(), out = [];
  for (const [code, r] of Object.entries(rules)) {
    out.push({ group: code, scope: 'mode', key: '', item: r.mode, updatedBy: by, updatedAt: at });
    for (const [k, v] of Object.entries(r.segments || {})) if (v) out.push({ group: code, scope: 'segment', key: k, item: v, updatedBy: by, updatedAt: at });
    for (const [k, v] of Object.entries(r.users || {})) if (v) out.push({ group: code, scope: 'user', key: k, item: v, updatedBy: by, updatedAt: at });
  }
  return out;
}

const bad = (m, s = 400) => Object.assign(new Error(m), { status: s });
async function checkItem(group, item, groups) {
  if (!item) return;
  const g = (groups || []).find((x) => x.code === group);
  if (groups && (!g || !g.items.some((i) => i.code === item))) throw bad(`ไม่พบรายการ ${item} ในกลุ่ม ${group} ใน PEAK`);
}

// Accounting / admin changes how a group is chosen (and, for segment mode, the item per segment).
async function saveGroup(group, { mode, segments }, users, by) {
  if (!MODES.includes(mode)) throw bad('เลือกวิธีติดกลุ่ม: ตามกลุ่มลูกค้า / ตามเซล / ไม่ติด');
  const groups = await peakGroups().catch(() => null);
  if (groups && !groups.some((x) => x.code === group)) throw bad(`ไม่พบกลุ่ม ${group} ใน PEAK`);
  const clean = {};
  for (const s of SEGMENTS) { const v = String((segments || {})[s] || '').trim(); if (v) { await checkItem(group, v, groups); clean[s] = v; } }
  const rules = await load(users);
  const cur = rules[group] || { users: {} };
  rules[group] = { mode, segments: mode === 'segment' ? clean : {}, users: cur.users || {} };
  await hub.replaceTable('ClassRules', toRows(rules, by));
  await hub.log('users', 'class_rules', group, `${by} · ${mode} ${JSON.stringify(rules[group].segments)}`);
}

// The item(s) one seller carries, for groups chosen by seller. items = { group: item | '' }.
async function saveUser(email, items, users, by) {
  const groups = await peakGroups().catch(() => null);
  const rules = await load(users);
  for (const [group, item0] of Object.entries(items || {})) {
    const item = String(item0 || '').trim();
    if (!rules[group] || rules[group].mode !== 'seller') throw bad(`กลุ่ม ${group} ไม่ได้ตั้งให้ติดตามเซล`);
    await checkItem(group, item, groups);
    if (item) rules[group].users[low(email)] = item; else delete rules[group].users[low(email)];
  }
  await hub.replaceTable('ClassRules', toRows(rules, by));
}

module.exports = { SEGMENTS, MODES, DEFAULTS, load, pick, peakGroups, saveGroup, saveUser, _test: { toRows } };
