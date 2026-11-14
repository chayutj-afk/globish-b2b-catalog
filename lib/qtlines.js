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

// The QT in PEAK may have been edited without the app knowing (no webhook yet). Bring the Requests row
// (totals, signature, link) and its lines up to date. Returns true when something changed.
async function refreshRequest(row, q) {
  if (!row || !q) return false;
  const peak = require('./peak');
  const sig = peak.quotationSig(q);
  if (row.qtSig && row.qtSig === sig) return false;
  const pre = num(q.preTaxAmount), net = num(q.netAmount);
  const incl = Number(q.taxStatus) === 1;
  const f = { qtSig: sig, updatedAt: hub.sheetDateTime() };
  if (pre) f.totalPreVat = pre;
  if (net) f.totalInclVat = incl ? net : r2(pre * 1.07);
  if (q.documentLink) f.peakDocLink = q.documentLink;
  const moved = Math.abs(pre - num(row.totalPreVat)) > 0.009;
  if (moved && row.qtSig) f.qtEditedAt = hub.sheetDateTime();
  await hub.updateRow('Requests', row._row, f);
  Object.assign(row, f);
  await syncFromPeak(row.requestId, q).catch(() => null);
  return moved;
}

module.exports.refreshRequest = refreshRequest;
