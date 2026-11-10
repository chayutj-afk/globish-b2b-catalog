const test = require('node:test');
const assert = require('node:assert');
const p = require('../lib/pricing');
const peak = require('../lib/peak');

test('every published package has a 16-slot Key H.S.', () => {
  for (const x of p.packages()) assert.ok(p.parseKeyHS(x.keyHS), x.id);
});

test('hero line carries the price, supplements are zero-priced lines', () => {
  const r = p.priceItem({ packageId: 'SPD-06-72-18PV', students: 25 });
  assert.equal(r.lines[0].role, 'hero');
  assert.equal(r.lines[0].unitPrice, p.getPrice(p.findPackage('SPD-06-72-18PV'), 25));
  const supp = r.lines.filter((l) => l.role === 'supplement');
  assert.deepEqual(supp.map((l) => l.component), ['Private Class', 'GB+: AI']);
  assert.ok(supp.every((l) => l.unitPrice === 0 && l.qty === 25));
  assert.equal(r.total, r.lines[0].unitPrice * 25);
});

test('catalog price is a reference: sales price and discount are used, below-floor is flagged not blocked', () => {
  const r = p.priceItem({ packageId: 'SPD-03-36', students: 10, unitPrice: 1500, discount: '10%' });
  assert.equal(r.lines[0].unitPrice, 1500);
  assert.equal(r.lines[0].discount, 1500);
  assert.equal(r.total, 13500);
  assert.equal(r.catalogTotal, p.getPrice(p.findPackage('SPD-03-36'), 10) * 10);
  assert.match(r.belowFloor, /SPD-03-36/);
  const ok = p.priceItem({ packageId: 'SPD-03-36', students: 10, discount: 2000 });
  assert.equal(ok.belowFloor, '');
});

test('discount must be baht or percent and not exceed the line', () => {
  assert.throws(() => p.priceItem({ packageId: 'SPD-03-36', students: 10, discount: 'abc' }), /ส่วนลด/);
  assert.throws(() => p.priceItem({ packageId: 'SPD-03-36', students: 10, discount: 999999 }), /มากกว่ายอด/);
});

test('per-class workshop with coach and travel surcharges', () => {
  const r = p.priceItem({ packageId: 'WSOS-NULL-01-TH', students: 20, classes: 2, intl: 'na', loc: 'out' });
  assert.equal(r.total, 28000 * 2 + 5000 * 2 + 1000 * 2);
});

test('PEAK payload: draft, VAT 7% lines, unmapped codes reported', () => {
  const lines = p.priceItem({ packageId: 'SPD-03-36-AI', students: 10 }).lines;
  const req = { requestId: 'REQ-1', company: 'Co', taxId: '0105555555555', wantedQtDate: '2026-11-12' };
  const none = peak.buildQuotation(req, lines, () => '');
  assert.ok(none.missing.length >= 2);
  const ok = peak.buildQuotation(req, lines, (l) => (l.role === 'hero' ? 'SPD001' : 'GBAI01'));
  const q = ok.body.PeakQuotations.quotations[0];
  assert.equal(ok.missing.length, 0);
  assert.equal(q.status, 'Draft');
  assert.equal(q.issuedDate, '20261112');
  assert.equal(q.products[1].price, 0);
  assert.ok(q.products.every((x) => x.vatType === 3));
  const disc = peak.buildQuotation(req, p.priceItem({ packageId: 'SPD-03-36', students: 10, discount: 500 }).lines, () => 'X');
  // PEAK discount is per unit: 500 off the line ÷ 10 students = 50 per unit
  assert.equal(disc.body.PeakQuotations.quotations[0].products[0].discount, '50');
  assert.equal(q.dueDate, '20261212');
  assert.equal(peak.unitDiscount({ discount: 1590, qty: 2 }), '795');
  assert.equal(peak.addDays('20261215', 30), '20270114');
  // uneven per-unit discount → document-level discountTotal, no line discounts
  const un = peak.buildQuotation(req, [{ role: 'wh_package', packageId: '3822', description: 'x', qty: 3, unitPrice: 15900, discount: 1000 }], () => '3822').body.PeakQuotations.quotations[0];
  assert.equal(un.discountTotal, '1000');
  assert.equal(un.products[0].discount, undefined);
  const ev = peak.buildQuotation(req, [{ role: 'wh_package', packageId: '3822', description: 'x', qty: 2, unitPrice: 15900, discount: 1590 }], () => '3822').body.PeakQuotations.quotations[0];
  assert.equal(ev.discountTotal, undefined);
  assert.equal(ev.products[0].discount, '795');
});

test('PEAK signature is HMAC-SHA1 hex of the UTC timestamp', () => {
  assert.equal(peak.stamp(new Date(Date.UTC(2016, 7, 30, 7, 26, 30))), '20160830072630');
  assert.match(peak.signature('20160830072630', 'abc'), /^[0-9a-f]{40}$/);
});

const { priceCustomKeyHS, priceService } = require('../lib/pricing');
const { validTaxId, normBranch } = require('../lib/taxid');

test('customized Key H.S.: full price on the hero line, supplements at 0', () => {
  const p = priceCustomKeyHS({ keyHS: 'Private Class-24-4-Native/24-4-HERO-6-12-TRUE-0-0-0-0-0-0-0-0-0-0', name: 'PTT custom', qty: 10, unitPrice: 20000, discount: '5%' });
  assert.equal(p.lines[0].role, 'hero');
  assert.equal(p.lines[0].unitPrice, 20000);
  assert.ok(p.lines.slice(1).every((l) => l.unitPrice === 0));
  assert.equal(p.total, 190000);
  assert.throws(() => priceCustomKeyHS({ keyHS: 'nope', qty: 1, unitPrice: 1 }), /Key H.S./);
});

test('Whitehouse package lines carry the package ID as the PEAK service code', () => {
  const p = priceService({ code: '3822', name: 'Essential Communication Development', qty: 3, unitPrice: 15900 });
  assert.equal(p.lines[0].role, 'wh_package');
  assert.equal(p.lines[0].peakCode, '3822');
  assert.equal(p.total, 47700);
  assert.equal(priceService({ code: 'b2scamp001', name: 'Camp', qty: 1, unitPrice: 800 }).lines[0].peakCode, 'B2SCAMP001');
  assert.throws(() => priceService({ code: '3822', name: 'x', qty: 1 }), /ราคา/);
});

test('Thai tax ID check digit and branch code', () => {
  assert.ok(validTaxId('0105555555554'));
  assert.ok(!validTaxId('0105555555555'));
  assert.equal(normBranch(''), '00000');
  assert.equal(normBranch('1'), '00001');
  assert.equal(normBranch('สาขาบางนา'), null);
});

test('hero component comes from the HERO slot, or Business Group Class', () => {
  assert.equal(p.heroComponent('Speedy English-36-3-X/36-3-0-0-HERO-TRUE-0-0-0-0-0-0-0-0-0-0'), 'Speedy English');
  assert.equal(p.heroComponent('Business Group Class Online-10-0-Thai/10-0-0-0-0-0-0-0-0-0-0-0-0-0-0-0'), 'Business Group Class');
  assert.equal(p.heroComponent('Master Class 60 minutes-1-0-X/1-0-0-0-0-0-0-0-0-0-0-0-0-0-HERO-0'), 'Master Class');
});

test('Whitehouse package lines get a customer-readable description from WHPackages', () => {
  const { priceService, describeWh } = require('../lib/pricing');
  const wh = { id: '3822', packageName: 'Essential Communication Development', product: 'Build Up', privateClass: '12', freeTalk: '3', discussion: '2', realwork: '0', months: '3', extras: 'MC' };
  const th = describeWh(wh, { title: 'Essential Communication Development', code: '3822' });
  assert.match(th, /^Essential Communication Development \(3822\)/);
  assert.match(th, /หลักสูตร Build Up · ระยะเวลาเรียน 3 เดือน/);
  assert.match(th, /คลาสเรียนตัวต่อตัว 1:1 12 ครั้ง/);
  assert.match(th, /Master Class/);
  assert.doesNotMatch(th, /Real-world/);
  assert.match(describeWh({ ...wh, months: '240' }, { lang: 'EN' }), /no expiry/);
  const line = priceService({ code: '3822', name: 'Essential', qty: 2, unitPrice: 15900, wh, lang: 'EN' }).lines[0];
  assert.match(line.description, /One-on-one classes: 12 sessions/);
  assert.equal(priceService({ code: 'B2SCAMP001', name: 'Camp', qty: 1, unitPrice: 1 }).lines[0].description, 'B2SCAMP001 · Camp');
});
