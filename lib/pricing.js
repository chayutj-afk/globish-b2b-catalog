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

// item = { packageId, students, classes, unitPrice?, intl?, loc? }
// Returns { pkg, lines, total } or throws a 400 error with a Thai message.
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

  const n = perClass ? (pkg.minN || students) : students;
  const list = getPrice(pkg, n);
  let unit = list;
  if (item.unitPrice !== undefined && item.unitPrice !== null && item.unitPrice !== '') {
    unit = Number(item.unitPrice);
    if (!Number.isFinite(unit) || unit <= 0) throw bad(`ราคาต่อหน่วยของ ${pkg.id} ไม่ถูกต้อง`);
    const floor = floorPrice(pkg);
    if (unit < floor) throw bad(`ราคาต่อหน่วยของ ${pkg.id} ต่ำกว่าราคาขั้นต่ำในแคตตาล็อก (${money(floor)})`);
  }
  const qty = perClass ? classes : students;
  const per = perClass ? 'class' : 'learner';
  const discountNote = unit < list ? ` · list ${money(list)}/${per}` : '';

  const lines = [{
    role: 'hero', keyHS: pkg.keyHS, packageId: pkg.id, qty, unitPrice: unit,
    description: `${pkg.id} · ${parseKeyHS(pkg.keyHS).hero} · ${pkg.qty} cls${pkg.dur ? ` / ${pkg.dur} mo` : ''}${discountNote}`,
  }];
  for (const s of supplements(pkg.keyHS)) {
    const what = s.value === 'TRUE' ? 'access' : `${s.value} classes`;
    lines.push({
      role: 'supplement', keyHS: pkg.keyHS, packageId: pkg.id, component: s.component, qty, unitPrice: 0,
      description: `${s.component}: ${what} per ${per} (included in ${pkg.id})`,
    });
  }

  // Coach and travel surcharges for Business Group Class and Workshop, same rules as the page.
  const isWS = pkg.hero === 'Workshop';
  const isBGC = pkg.hero === 'Business Group Class';
  if (isWS || isBGC) {
    const intl = ['nn', 'na'].includes(item.intl) ? item.intl : '0';
    if (intl !== '0') {
      const fee = isWS ? (intl === 'na' ? SURCHARGE.ws_na : SURCHARGE.ws_nn) : (intl === 'na' ? SURCHARGE.bgc_na : SURCHARGE.bgc_nn);
      lines.push({ role: 'surcharge', keyHS: pkg.keyHS, packageId: pkg.id, qty: isWS ? classes : students, unitPrice: fee,
        description: `${intl === 'na' ? 'Native' : 'Non-Native'} coach surcharge (${pkg.id})` });
    }
    if (item.loc === 'out' && format(pkg) !== 'online') {
      lines.push({ role: 'surcharge', keyHS: pkg.keyHS, packageId: pkg.id, qty: isWS ? classes : 1,
        unitPrice: isWS ? SURCHARGE.ws_area : SURCHARGE.bgc_area, description: `Travel outside Bangkok (${pkg.id})` });
    }
  }

  const total = lines.reduce((s, l) => s + l.qty * l.unitPrice, 0);
  return { pkg, lines, total };
}

module.exports = { BS, BB, SURCHARGE, COMPONENTS, packages, findPackage, getPrice, floorPrice, parseKeyHS, supplements, priceItem };
