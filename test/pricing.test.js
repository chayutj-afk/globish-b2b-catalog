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

test('prices below the catalog floor are refused', () => {
  assert.throws(() => p.priceItem({ packageId: 'SPD-03-36', students: 10, unitPrice: 100 }), /ต่ำกว่าราคาขั้นต่ำ/);
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
});

test('PEAK signature is HMAC-SHA1 hex of the UTC timestamp', () => {
  assert.equal(peak.stamp(new Date(Date.UTC(2016, 7, 30, 7, 26, 30))), '20160830072630');
  assert.match(peak.signature('20160830072630', 'abc'), /^[0-9a-f]{40}$/);
});
