// Server-side copy of the catalog's pricing rules, so a request can't arrive with a price
// the catalog wouldn't give. Keep BS/BB, getPrice and SURCHARGE in step with the page.

const BS = [5, 11, 21, 51, 101, 201, 501]; // band "s": student count where tier 1..7 starts
const BB = [10, 15, 20, 25, 30, 35, 40];   // band "b": Business Group Class

// Defaults from the page's SURCHARGE_CFG (Operation can change them there).
const SURCHARGE = { ws_nn: 2000, ws_na: 5000, ws_area: 1000, bgc_nn: 500, bgc_na: 1000, bgc_area: 800 };

// Key H.S. supplementary part: 16 positions after "/".
const COMPONENTS = [
  'Hero tickets', 'Hero duration (months)', 'Private Class', 'Discussion Class', 'Speedy English',
  'GB+: AI', 'GB+: LI', 'Engoo Standard', 'Engoo Premium Lite', 'VPA', 'VPA+',
  'GECB 2 Skills', 'GECB 4 Skills', 'Workshop', 'Master Class', 'Business Simulation',
];

function packages() {
  // Bundled with the function at deploy time; packages.json is republished (and redeployed)
  // from the Manage tab, so this is always the published catalog.
  return require('../packages.json');
}

function findPackage(id) {
  return packages().find((p) => p.id === id) || null;
}

function getPrice(pkg, n) {
  const bands = pkg.band === 'b' ? BB : BS;
  let price = pkg.p[0];
  for (let i = 0; i < bands.length; i++) if (n >= bands[i]) price = pkg.p[i];
  return price;
}

function floorPrice(pkg) {
  return Math.min(...pkg.p.filter((x) => typeof x === 'number'));
}

function isPerClass(pkg) {
  return pkg.unit === 'per class';
}

function format(pkg) {
  const s = String(pkg.supp || '').toLowerCase();
  if (s.includes('onsite')) return 'onsite';
  if (s.includes('hybrid')) return 'hybrid';
  return 'online';
}

// "Private Class-18-3-Filipino/18-3-HERO-0-12-..." → { hero, slots: [...16] }
function parseKeyHS(keyHS) {
  const s = String(keyHS || '');
  const i = s.indexOf('/');
  if (i < 0) return null;
  const slots = s.slice(i + 1).split('-');
  if (slots.length !== 16) return null;
  return { hero: s.slice(0, i), slots };
}

// Supplement positions (digit 3..16) that carry something: a count or TRUE.
function supplements(keyHS) {
  const k = parseKeyHS(keyHS);
  if (!k) return [];
  const out = [];
  for (let i = 2; i < 16; i++) {
    const v = String(k.slots[i]).toUpperCase();
    if (v === '0' || v === '' || v === 'HERO') continue;
    out.push({ digit: i + 1, component: COMPONENTS[i], value: v });
  }
  return out;
}

const money = (n) => Number(n).toLocaleString('en-US');

// ─── Customer-facing description from a Key H.S. ─────────────────────────────
// "Private Class-46-6-Asian, European and Native/46-6-HERO-24-120-0-…-24-0" →
//   Private Class (เรียนตัวต่อตัว) 46 ครั้ง ระยะเวลา 6 เดือน · โค้ชเอเชีย ยุโรป และเจ้าของภาษา
//   รวมในแพ็กเกจ (ต่อผู้เรียน 1 ท่าน):
//   • Discussion Class (คลาสสนทนากลุ่ม) 24 ครั้ง …
// Used as the line description on QT (and so on the INV accounting creates from it).
const LABEL = {
  TH: {
    'Private Class': 'Private Class (เรียนตัวต่อตัวกับโค้ช)', 'Discussion Class': 'Discussion Class (คลาสสนทนากลุ่ม)',
    'Speedy English': 'Speedy English', 'GB+: AI': 'Globish Plus: AI', 'GB+: LI': 'Globish Plus: Live Instruction',
    'Engoo Standard': 'Engoo Standard', 'Engoo Premium Lite': 'Engoo Premium Lite',
    VPA: 'แบบประเมินระดับภาษา VPA', 'VPA+': 'แบบประเมินระดับภาษา VPA+',
    'GECB 2 Skills': 'การสอบ GECB 2 ทักษะ (Receptive)', 'GECB 4 Skills': 'การสอบ GECB 4 ทักษะ (Receptive + Productive)',
    Workshop: 'Workshop', 'Master Class': 'Master Class', 'Business Simulation': 'Business Simulation',
  },
  EN: {
    'Private Class': 'Private Class (1:1 coaching)', 'Discussion Class': 'Discussion Class (group conversation)',
    'Speedy English': 'Speedy English', 'GB+: AI': 'Globish Plus: AI', 'GB+: LI': 'Globish Plus: Live Instruction',
    'Engoo Standard': 'Engoo Standard', 'Engoo Premium Lite': 'Engoo Premium Lite',
    VPA: 'VPA proficiency assessment', 'VPA+': 'VPA+ proficiency assessment',
    'GECB 2 Skills': 'GECB test, 2 skills (Receptive)', 'GECB 4 Skills': 'GECB test, 4 skills (Receptive + Productive)',
    Workshop: 'Workshop', 'Master Class': 'Master Class', 'Business Simulation': 'Business Simulation',
  },
};
function coachText(c, lang) {
  const s = String(c || '').trim();
  if (!s || /^none$/i.test(s)) return '';
  if (lang === 'EN') return `${s} coaches`;
  const th = s.replace(/Asian/g, 'เอเชีย').replace(/European/g, 'ยุโรป').replace(/Native/g, 'เจ้าของภาษา')
    .replace(/Filipino/g, 'ฟิลิปปินส์').replace(/Thai/g, 'ไทย').replace(/Global/g, 'นานาชาติ').replace(/ and /g, ' และ').replace(/และ +/g, 'และ').replace(/, /g, ' ');
  return `โค้ช${th}`;
}
// hero part "Private Class-46-6-Asian, European and Native" → { name, tickets, months, coach }
function parseHero(hero) {
  const m = /^(.*?)-(\d+)-(\d+)(?:-(.*))?$/.exec(String(hero || ''));
  return m ? { name: m[1].trim(), tickets: Number(m[2]), months: Number(m[3]), coach: m[4] || '' } : { name: String(hero || ''), tickets: 0, months: 0, coach: '' };
}
// Document name for a Key H.S. hero ("Private Class-36-6-…" → label used on QT/INV).
function heroName(keyHS, lang = 'TH') {
  const L = lang === 'EN' ? 'EN' : 'TH';
  const k = parseKeyHS(keyHS);
  if (!k) return '';
  const h = parseHero(k.hero);
  const heroComp = heroComponent(keyHS);
  return LABEL[L][h.name] || (LABEL[L][heroComp] && h.name === heroComp && LABEL[L][heroComp]) || h.name;
}
function describeKeyHS(keyHS, { lang = 'TH', title = '', perClass = false } = {}) {
  const L = lang === 'EN' ? 'EN' : 'TH';
  const k = parseKeyHS(keyHS);
  if (!k) return title || '';
  const h = parseHero(k.hero);
  const heroComp = heroComponent(keyHS);
  const name = title || LABEL[L][h.name] || LABEL[L][heroComp] && h.name === heroComp && LABEL[L][heroComp] || h.name;
  const parts = [];
  if (L === 'TH') {
    let first = name;
    if (perClass) first += ' (ราคาต่อครั้ง)';
    else if (h.tickets) first += ` ${h.tickets} ครั้ง`;
    if (h.months) first += ` ระยะเวลา ${h.months} เดือน`;
    const c = coachText(h.coach, 'TH'); if (c) first += ` · ${c}`;
    parts.push(first);
  } else {
    let first = name;
    if (perClass) first += ' (price per session)';
    else if (h.tickets) first += ` · ${h.tickets} ${h.tickets === 1 ? 'session' : 'sessions'}`;
    if (h.months) first += ` over ${h.months} ${h.months === 1 ? 'month' : 'months'}`;
    const c = coachText(h.coach, 'EN'); if (c) first += ` · ${c}`;
    parts.push(first);
  }
  const inc = supplements(keyHS).map((s) => {
    const label = LABEL[L][s.component] || s.component;
    if (s.value === 'TRUE') return L === 'TH' ? `• ${label} (ใช้งานได้ตลอดระยะเวลาแพ็กเกจ)` : `• ${label} (access for the whole package)`;
    const n = Number(s.value);
    return L === 'TH' ? `• ${label} ${n} ครั้ง` : `• ${label}: ${n} ${n === 1 ? 'session' : 'sessions'}`;
  });
  if (inc.length) parts.push(L === 'TH' ? `รวมในแพ็กเกจ (ต่อผู้เรียน 1 ท่าน):` : 'Included per learner:', ...inc);
  return parts.join('\n');
}

// Which product a Key H.S. is "about": the component in the HERO position, or Business
// Group Class (its Key H.S. has no HERO slot). PEAK service codes are kept per component
// (Components tab), so catalog and customized packages map to a code the same way.
function heroComponent(keyHS) {
  const k = parseKeyHS(keyHS);
  if (!k) return '';
  const i = k.slots.findIndex((v) => String(v).toUpperCase() === 'HERO');
  if (i >= 2) return COMPONENTS[i];
  if (/^Business Group Class/i.test(k.hero)) return 'Business Group Class';
  return 'Customized (no HERO slot)';
}

// The catalog price is a reference only. Sales sets the real unit price and any extra
// discount; accounting issues documents with those numbers. We keep the catalog price
// next to it so a price below the catalog floor is visible, not blocked.
//
// discount: number (baht off the line) or "10%" (percent of the line before discount).
function parseDiscount(raw, gross) {
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  if (raw === undefined || raw === null || String(raw).trim() === '') return 0;
  const s = String(raw).trim().replace(/,/g, '');
  let amt;
  if (/^\d+(\.\d+)?%$/.test(s)) amt = gross * Number(s.slice(0, -1)) / 100;
  else if (/^\d+(\.\d+)?$/.test(s)) amt = Number(s);
  else throw bad('ส่วนลดต้องเป็นจำนวนเงิน (เช่น 5000) หรือเปอร์เซ็นต์ (เช่น 10%)');
  amt = Math.round(amt * 100) / 100;
  if (amt > gross) throw bad('ส่วนลดมากกว่ายอดของรายการ');
  return amt;
}

// VAT. B2B and B2S quote prices before VAT; B2C, B2E, MaoMao and Others quote VAT-inclusive
// prices (what the customer pays). Requests store both totals: totalPreVat for revenue reports,
// totalInclVat for what the customer sees.
const VAT = 0.07;
const VAT_INCL_SEGMENTS = ['B2C', 'B2E', 'MaoMao', 'Others'];
const vatIncluded = (segment) => VAT_INCL_SEGMENTS.includes(String(segment || ''));
const round2 = (n) => Math.round(n * 100) / 100;
// amount in the segment's basis → { preVat, inclVat }
function vatSplit(amount, incl) {
  const a = Number(amount) || 0;
  return incl ? { preVat: round2(a / (1 + VAT)), inclVat: round2(a) } : { preVat: round2(a), inclVat: round2(a * (1 + VAT)) };
}

// item = { packageId, students, classes, unitPrice?, discount?, intl?, loc?, vatIncl? }
// Returns { pkg, lines, total, catalogTotal, belowFloor } or throws a 400 error.
function priceItem(item) {
  const bad = (m) => { const e = new Error(m); e.status = 400; return e; };
  // Catalog prices exclude VAT. For a VAT-inclusive segment (Others) the reference, floor and
  // surcharge fees are shown and charged VAT-inclusive.
  const vf = item.vatIncl ? 1 + VAT : 1;
  const r2 = (n) => Math.round(n * vf * 100) / 100;
  const pkg = findPackage(item.packageId);
  if (!pkg) throw bad(`ไม่พบแพ็กเกจ ${item.packageId} ในแคตตาล็อก`);
  if (!pkg.keyHS || !parseKeyHS(pkg.keyHS)) throw bad(`แพ็กเกจ ${pkg.id} ยังไม่มี Key H.S. ที่ถูกต้อง`);

  const perClass = isPerClass(pkg);
  const students = Math.floor(Number(item.students));
  if (!Number.isFinite(students) || students < 1 || students > 5000) throw bad(`จำนวนผู้เรียนของ ${pkg.id} ไม่ถูกต้อง`);
  const classes = perClass ? Math.floor(Number(item.classes)) : 1;
  if (perClass && (!Number.isFinite(classes) || classes < 1 || classes > 500)) throw bad(`จำนวนคลาสของ ${pkg.id} ไม่ถูกต้อง`);

  const list = r2(getPrice(pkg, perClass ? (pkg.minN || students) : students));
  let unit = list;
  if (item.unitPrice !== undefined && item.unitPrice !== null && item.unitPrice !== '') {
    unit = Math.round(Number(item.unitPrice) * 100) / 100;
    if (!Number.isFinite(unit) || unit < 0 || unit > 10000000) throw bad(`ราคาต่อหน่วยของ ${pkg.id} ไม่ถูกต้อง`);
  }
  const qty = perClass ? classes : students;
  const per = perClass ? 'class' : 'learner';
  const discount = parseDiscount(item.discount, qty * unit);
  const floor = r2(floorPrice(pkg));
  const netUnit = qty ? (qty * unit - discount) / qty : unit;

  const lines = [{
    role: 'hero', keyHS: pkg.keyHS, packageId: pkg.id, component: heroComponent(pkg.keyHS), qty, unitPrice: unit, discount, listPrice: list,
    description: `${describeKeyHS(pkg.keyHS, { lang: item.lang, perClass })}\n(${pkg.id})`,
  }];
  for (const s of supplements(pkg.keyHS)) {
    lines.push({
      role: 'supplement', keyHS: pkg.keyHS, packageId: pkg.id, component: s.component, qty, unitPrice: 0, discount: 0, listPrice: 0,
      description: suppLine(s, item.lang),
    });
  }

  // Coach and travel surcharges for Business Group Class and Workshop, at catalog rates.
  const isWS = pkg.hero === 'Workshop';
  const isBGC = pkg.hero === 'Business Group Class';
  if (isWS || isBGC) {
    const intl = ['nn', 'na'].includes(item.intl) ? item.intl : '0';
    if (intl !== '0') {
      const fee = r2(isWS ? (intl === 'na' ? SURCHARGE.ws_na : SURCHARGE.ws_nn) : (intl === 'na' ? SURCHARGE.bgc_na : SURCHARGE.bgc_nn));
      lines.push({ role: 'surcharge', keyHS: pkg.keyHS, packageId: pkg.id, component: 'Coach surcharge', qty: isWS ? classes : students, unitPrice: fee, discount: 0, listPrice: fee,
        description: `${intl === 'na' ? 'Native' : 'Non-Native'} coach surcharge (${pkg.id})` });
    }
    if (item.loc === 'out' && format(pkg) !== 'online') {
      const fee = r2(isWS ? SURCHARGE.ws_area : SURCHARGE.bgc_area);
      lines.push({ role: 'surcharge', keyHS: pkg.keyHS, packageId: pkg.id, component: 'Travel surcharge', qty: isWS ? classes : 1, unitPrice: fee, discount: 0, listPrice: fee,
        description: `Travel outside Bangkok (${pkg.id})` });
    }
  }

  const total = lines.reduce((s, l) => s + l.qty * l.unitPrice - l.discount, 0);
  const catalogTotal = lines.reduce((s, l) => s + l.qty * l.listPrice, 0);
  const belowFloor = netUnit < floor ? `${pkg.id} ${money(netUnit)}/${per} < ${money(floor)}` : '';
  return { pkg, lines, total, catalogTotal, belowFloor };
}

// Zero-price line for an included component (kept as its own line for revenue reporting).
function suppLine(s, lang) {
  const L = lang === 'EN' ? 'EN' : 'TH';
  const label = LABEL[L][s.component] || s.component;
  if (L === 'EN') return `${label}${s.value === 'TRUE' ? '' : `: ${s.value} sessions`} (included in the package above)`;
  return `${label}${s.value === 'TRUE' ? '' : ` ${s.value} ครั้ง`} (รวมอยู่ในแพ็กเกจข้างต้น)`;
}

function lineMoney(item, label) {
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  const qty = Math.floor(Number(item.qty));
  if (!Number.isFinite(qty) || qty < 1 || qty > 100000) throw bad(`จำนวนของ ${label} ไม่ถูกต้อง`);
  const unit = Math.round(Number(item.unitPrice) * 100) / 100;
  if (item.unitPrice === '' || item.unitPrice === undefined || item.unitPrice === null || !Number.isFinite(unit) || unit < 0 || unit > 10000000) {
    throw bad(`ใส่ราคาต่อหน่วยของ ${label}`);
  }
  const discount = parseDiscount(item.discount, qty * unit);
  return { qty, unit, discount };
}

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);

// Customized B2B package: Product gives sales a Key H.S. that isn't in the catalog.
// Same line split as catalog packages (full price on the hero line, supplements at 0),
// but there is no catalog price to compare against.
// item = { keyHS, name?, qty, unitPrice, discount? }
function priceCustomKeyHS(item) {
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  const keyHS = clean(item.keyHS, 300);
  const k = parseKeyHS(keyHS);
  if (!k || !k.hero) throw bad('Key H.S. ต้องเป็นรูปแบบ "ชื่อ hero-…/ตัวเลข 16 ช่องคั่นด้วย -"');
  if (!k.slots.some((s) => String(s).toUpperCase() === 'HERO') && !/^\d+$/.test(k.slots[0])) throw bad('Key H.S. ไม่ถูกต้อง');
  const name = clean(item.name, 120) || k.hero;
  const { qty, unit, discount } = lineMoney(item, name);
  const lines = [{
    role: 'hero', keyHS, packageId: 'CUSTOM', component: heroComponent(keyHS), qty, unitPrice: unit, discount, listPrice: '',
    description: describeKeyHS(keyHS, { lang: item.lang, title: clean(item.name, 120) }),
  }];
  for (const s of supplements(keyHS)) {
    lines.push({ role: 'supplement', keyHS, packageId: 'CUSTOM', component: s.component, qty, unitPrice: 0, discount: 0, listPrice: '',
      description: suppLine(s, item.lang) });
  }
  const total = qty * unit - discount;
  return { lines, total, catalogTotal: 0, belowFloor: '' };
}

// What a Whitehouse package includes, written for the customer. wh = WHPackages row.
const WH_EXTRAS = {
  MC: { TH: 'Master Class', EN: 'Master Class' },
  AI: { TH: 'AI Practice (ฝึกพูดกับ AI)', EN: 'AI Practice' },
  EN: { TH: 'Engoo', EN: 'Engoo' },
  GP: { TH: 'Globish Plus E-learning', EN: 'Globish Plus e-learning' },
};
function describeWh(wh, { lang = 'TH', title = '', code = '' } = {}) {
  const L = lang === 'EN' ? 'EN' : 'TH';
  const n = (v) => Number(v) || 0;
  const head = `${title || wh.packageName}${code ? ` (${code})` : ''}`;
  if (!wh) return head;
  const inc = [];
  const add = (count, th, en) => { if (n(count) > 0) inc.push(L === 'TH' ? `• ${th} ${n(count)} ครั้ง` : `• ${en}: ${n(count)} ${n(count) === 1 ? 'session' : 'sessions'}`); };
  add(wh.privateClass, 'คลาสเรียนตัวต่อตัว 1:1', 'One-on-one classes');
  add(wh.discussion, 'คลาสกลุ่ม (Discussion Class)', 'Group discussion classes');
  add(wh.freeTalk, 'Free Talk', 'Free Talk sessions');
  add(wh.realwork, 'Real-world Class', 'Real-world classes');
  for (const x of String(wh.extras || '').split('+').filter(Boolean)) {
    const e = WH_EXTRAS[x];
    if (e) inc.push(L === 'TH' ? `• ${e.TH} (ใช้งานได้ตลอดระยะเวลาแพ็กเกจ)` : `• ${e.EN} (access for the whole package)`);
  }
  const m = n(wh.months);
  const dur = !m ? '' : m >= 120 ? (L === 'TH' ? 'ไม่มีวันหมดอายุ' : 'no expiry') : L === 'TH' ? `ระยะเวลาเรียน ${m} เดือน` : `valid for ${m} ${m === 1 ? 'month' : 'months'}`;
  const course = wh.product ? (L === 'TH' ? `หลักสูตร ${wh.product}` : `Course: ${wh.product}`) : '';
  const lines = [head, [course, dur].filter(Boolean).join(' · ')].filter(Boolean);
  if (inc.length) lines.push(L === 'TH' ? 'รวมในแพ็กเกจ (ต่อผู้เรียน 1 ท่าน):' : 'Included per learner:', ...inc);
  return lines.join('\n');
}

// The "PEAK Services (สรุป)" tab cuts names at 45 characters; use the full Whitehouse name then.
function fullServiceName(peakName, wh) {
  const n = String(peakName || '').trim(), w = String((wh && wh.packageName) || '').trim();
  return n.length >= 45 && w.length > n.length ? w : n;
}

// B2E / B2S / Others: a Whitehouse package (numeric Package ID; PEAK uses the same
// number as the service code) or an existing PEAK service code (e.g. B2SCAMP001).
// item = { code, name, qty, unitPrice, discount?, wh?, lang? }  wh = WHPackages row for the package
function priceService(item) {
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  const code = clean(item.code, 40).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_\-+.]{0,39}$/.test(code)) throw bad('ใส่ Package ID ของ Whitehouse หรือรหัสบริการใน PEAK');
  const name = clean(item.name, 160);
  if (!name) throw bad(`ใส่ชื่อแพ็กเกจของ ${code}`);
  const { qty, unit, discount } = lineMoney(item, code);
  const isWh = /^\d+$/.test(code);
  return {
    lines: [{ role: isWh ? 'wh_package' : 'service', keyHS: '', packageId: code, peakCode: code, qty, unitPrice: unit, discount, listPrice: '',
      description: item.wh ? describeWh(item.wh, { lang: item.lang, title: name, code }) : `${isWh ? 'WH ' : ''}${code} · ${name}` }],
    total: qty * unit - discount, catalogTotal: 0, belowFloor: '',
  };
}

// Coach / travel surcharge added by sales to a customized package (catalog packages add
// their surcharges automatically). item = { type: 'coach'|'travel', note?, qty, unitPrice, discount? }
const SURCHARGE_TYPES = {
  coach: { component: 'Coach surcharge', TH: 'ค่าโค้ชชาวต่างชาติ (เพิ่มเติม)', EN: 'Foreign coach surcharge' },
  travel: { component: 'Travel surcharge', TH: 'ค่าเดินทางนอกกรุงเทพฯ', EN: 'Travel outside Bangkok' },
};
function priceSurcharge(item) {
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  const t = SURCHARGE_TYPES[item.type];
  if (!t) throw bad('เลือกประเภทค่าเพิ่ม: โค้ชชาวต่างชาติ หรือ ค่าเดินทาง');
  const L = item.lang === 'EN' ? 'EN' : 'TH';
  const note = clean(item.note, 120);
  const { qty, unit, discount } = lineMoney(item, t[L]);
  return {
    lines: [{ role: 'surcharge', keyHS: '', packageId: 'SURCHARGE', component: t.component, qty, unitPrice: unit, discount, listPrice: '',
      description: note ? `${t[L]} · ${note}` : t[L] }],
    total: qty * unit - discount, catalogTotal: 0, belowFloor: '',
  };
}

module.exports = { VAT, VAT_INCL_SEGMENTS, vatIncluded, vatSplit, fullServiceName, BS, BB, SURCHARGE, COMPONENTS, heroComponent, heroName, describeKeyHS, describeWh, priceSurcharge, SURCHARGE_TYPES, packages, findPackage, getPrice, floorPrice, parseKeyHS, supplements, parseDiscount, priceItem, priceCustomKeyHS, priceService };
