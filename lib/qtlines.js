// After a QT is edited in PEAK, copy the new quantities / prices back onto RequestLines so every page
// (INV form price-per-student, balances) works from the QT as it is now, not as Sales first asked.
// Lines are matched in order and must carry the same service codes; otherwise nothing is changed.

const hub = require('./hub');
const num = (x) => Number(String(x ?? '').replace(/,/g, '')) || 0;
const r2 = (n) => Math.round(n * 100) / 100;

async function syncFromPeak(requestId, q) {
  const products = (q && q.products) || [];
  if (!products.length) return { changed: 0, reason: 'no products' };
  const lines = (await hub.readTable('RequestLines')).filter((l) => l.requestId === requestId).sort((a, b) => num(a.line) - num(b.line));
  if (lines.length !== products.length) return { changed: 0, reason: `lines ${lines.length} ≠ PEAK ${products.length}` };
  const same = lines.every((l, i) => !l.peakServiceCode || !products[i].productCode || String(l.peakServiceCode).toUpperCase() === String(products[i].productCode).toUpperCase());
  if (!same) return { changed: 0, reason: 'service codes differ' };
  let changed = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], p = products[i];
    const qty = num(p.quantity), price = num(p.price), disc = r2(num(p.discount) * qty);
    const f = {};
    if (qty !== num(l.qty)) f.qty = qty;
    if (Math.abs(price - num(l.unitPrice)) > 0.009) f.unitPrice = price;
    if (Math.abs(disc - num(l.discount)) > 0.009) f.discount = disc;
    if (Object.keys(f).length) { await hub.updateRow('RequestLines', l._row, f); changed++; }
  }
  return { changed };
}

module.exports = { syncFromPeak };
