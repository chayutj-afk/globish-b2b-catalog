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

// item = { packageId, students, classes, unitPrice?, discount?, intl?, loc? }
// Returns { pkg, lines, total, catalogTotal, belowFloor } or throws a 400 error.
function priceItem(item) {
  const bad = (m) => { const e = new Error(m); e.status = 400; return e; };
  const pkg = findPackage(item.packageId);
  if (!pkg) throw bad(`ไม่พบแพ็กเกจ ${item.packageId} ในแคตตาล็อก`);
  if (!pkg.keyHS || !parseKeyHS(pkg.keyHS)) throw bad(`แพ็กเกจ ${pkg.id} ยังไม่มี Key H.S. ที่ถูกต้อง`);

  const perClass = isPerClass(pkg);
  const students = Math.floor(Number(item.students));
  if (!Number.isFinite(students) || students < 1 || students > 5000) throw bad(`จำนวนผู้เรียนของ ${pkg.id} ไม่ถูกต้อง`);
  const classes = perClass ? Math.floor(Number(item.classes)) : 1;
  if (perClass && (!Number.isFinite(classes) || classes < 1 || classes > 500)) throw bad(`จำนวนคลาสของ ${pkg.id} ไม่ถูกต้อง`);

  const list = getPrice(pkg, perClass ? (pkg.minN || students) : students);
  let unit = list;
  if (item.unitPrice !== undefined && item.unitPrice !== null && item.unitPrice !== '') {
    unit = Math.round(Number(item.unitPrice) * 100) / 100;
    if (!Number.isFinite(unit) || unit < 0 || unit > 10000000) throw bad(`ราคาต่อหน่วยของ ${pkg.id} ไม่ถูกต้อง`);
  }
  const qty = perClass ? classes : students;
  const per = perClass ? 'class' : 'learner';
  const discount = parseDiscount(item.discount, qty * unit);
  const floor = floorPrice(pkg);
  const netUnit = qty ? (qty * unit - discount) / qty : unit;

  const lines = [{
    role: 'hero', keyHS: pkg.keyHS, packageId: pkg.id, qty, unitPrice: unit, discount, listPrice: list,
    description: `${pkg.id} · ${parseKeyHS(pkg.keyHS).hero} · ${pkg.qty} cls${pkg.dur ? ` / ${pkg.dur} mo` : ''}`,
  }];
  for (const s of supplements(pkg.keyHS)) {
    const what = s.value === 'TRUE' ? 'access' : `${s.value} classes`;
    lines.push({
      role: 'supplement', keyHS: pkg.keyHS, packageId: pkg.id, component: s.component, qty, unitPrice: 0, discount: 0, listPrice: 0,
      description: `${s.component}: ${what} per ${per} (included in ${pkg.id})`,
    });
  }

  // Coach and travel surcharges for Business Group Class and Workshop, at catalog rates.
  const isWS = pkg.hero === 'Workshop';
  const isBGC = pkg.hero === 'Business Group Class';
  if (isWS || isBGC) {
    const intl = ['nn', 'na'].includes(item.intl) ? item.intl : '0';
    if (intl !== '0') {
      const fee = isWS ? (intl === 'na' ? SURCHARGE.ws_na : SURCHARGE.ws_nn) : (intl === 'na' ? SURCHARGE.bgc_na : SURCHARGE.bgc_nn);
      lines.push({ role: 'surcharge', keyHS: pkg.keyHS, packageId: pkg.id, qty: isWS ? classes : students, unitPrice: fee, discount: 0, listPrice: fee,
        description: `${intl === 'na' ? 'Native' : 'Non-Native'} coach surcharge (${pkg.id})` });
    }
    if (item.loc === 'out' && format(pkg) !== 'online') {
      const fee = isWS ? SURCHARGE.ws_area : SURCHARGE.bgc_area;
      lines.push({ role: 'surcharge', keyHS: pkg.keyHS, packageId: pkg.id, qty: isWS ? classes : 1, unitPrice: fee, discount: 0, listPrice: fee,
        description: `Travel outside Bangkok (${pkg.id})` });
    }
  }

  const total = lines.reduce((s, l) => s + l.qty * l.unitPrice - l.discount, 0);
  const catalogTotal = lines.reduce((s, l) => s + l.qty * l.listPrice, 0);
  const belowFloor = netUnit < floor ? `${pkg.id} ${money(netUnit)}/${per} < ${money(floor)}` : '';
  return { pkg, lines, total, catalogTotal, belowFloor };
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
    role: 'hero', keyHS, packageId: 'CUSTOM', qty, unitPrice: unit, discount, listPrice: '',
    description: `Customized · ${name}`,
  }];
  for (const s of supplements(keyHS)) {
    const what = s.value === 'TRUE' ? 'access' : `${s.value} classes`;
    lines.push({ role: 'supplement', keyHS, packageId: 'CUSTOM', component: s.component, qty, unitPrice: 0, discount: 0, listPrice: '',
      description: `${s.component}: ${what} (included in ${name})` });
  }
  const total = qty * unit - discount;
  return { lines, total, catalogTotal: 0, belowFloor: '' };
}

// B2E / B2S / Others: a Whitehouse package (numeric Package ID; PEAK uses the same
// number as the service code) or an existing PEAK service code (e.g. B2SCAMP001).
// item = { code, name, qty, unitPrice, discount? }
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
      description: `${isWh ? 'WH ' : ''}${code} · ${name}` }],
    total: qty * unit - discount, catalogTotal: 0, belowFloor: '',
  };
}

module.exports = { BS, BB, SURCHARGE, COMPONENTS, packages, findPackage, getPrice, floorPrice, parseKeyHS, supplements, parseDiscount, priceItem, priceCustomKeyHS, priceService };
