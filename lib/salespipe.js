// Sales pipeline for the "ยอดขาย" page: quotations → invoiced → collected, all before VAT.
//
// Two sources of quotations:
//   PeakQuotes / PeakInvoices tabs  — PEAK's own quotation and invoice reports (Excel), uploaded on the page. They carry
//       every QT of the year with PEAK's status (fully / partly invoiced, accepted, waiting, expired, rejected) and, on
//       the invoice report, the QT each INV was issued from. No API quota is used.
//   Requests tab                    — QTs asked for through the app that are not in the last upload yet.
// The Invoices tab (the AR book) adds what PEAK's report does not know: part payments, seller, customer group.
const ar = require('./ar');

const round2 = (n) => Math.round(n * 100) / 100;
const up = (v) => String(v || '').trim().toUpperCase();
const QT_LIVE = ['qt_approved', 'accepted', 'iv_requested', 'iv_issued'];
// PEAK quotation status → where the QT stands. Drafts are not quotations yet.
const BUCKET = { 'ออกครบแล้ว': 'won', 'ออกบางส่วน': 'part', 'ยอมรับแล้ว': 'open', 'รอตอบรับ': 'open', 'พ้นกำหนด': 'lost', 'ปฏิเสธแล้ว': 'lost' };
const DRAFT = 'ร่าง';
const PEAK_PAID = 'รับชำระแล้ว';

// Share of an INV's pre-VAT amount that has been collected (bank charges the company absorbed count as collected).
const paidShare = (r) => (r.state === 'Paid' ? 1 : r.received > 0 && r.expectedFull > 0 ? Math.min(1, (r.received + (r.fee || 0)) / r.expectedFull) : 0);

// ── Upload ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const QO = /QO-\d{6,}/i;
const numIn = (v) => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
const txt = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// One row of PEAK's report, as the page read it from the Excel file → a row of the tab. Throws on a row that is not
// a document (the page only sends rows with a document number).
function reportRow(kind, r, at) {
  const no = up(r.no);
  if (!/^[A-Z]{1,4}-?\d{6,}$/.test(no)) throw new Error(`เลขที่เอกสารไม่ถูกต้อง: ${txt(r.no, 30)}`);
  if (!DATE.test(String(r.issue || ''))) throw new Error(`${no}: วันที่ออกไม่ถูกต้อง (${txt(r.issue, 20)})`);
  const preVat = round2(numIn(r.novat) + numIn(r.vat0) + numIn(r.vat7));
  const base = { issueDate: r.issue, status: txt(r.status, 30), company: txt(r.company, 200), taxId: txt(r.taxId, 20), product: txt(r.product, 120), preVat, total: round2(numIn(r.total)), importedAt: at };
  if (kind === 'qt') return { qtNo: no, ...base, validUntil: DATE.test(String(r.until || '')) ? r.until : '', branch: txt(r.branch, 10), ref: txt(r.ref, 60) };
  const q = QO.exec(`${r.ref || ''} ${r.sysRef || ''}`);
  return { ivNo: no, ...base, dueDate: DATE.test(String(r.until || '')) ? r.until : '', qtNo: q ? up(q[0]) : '' };
}

// New upload over what the tab holds: a document in the upload replaces the stored one, the others stay (an upload
// of one year does not drop the other year). Newest first.
function mergeReport(kind, existing, incoming) {
  const key = kind === 'qt' ? 'qtNo' : 'ivNo';
  const m = new Map(existing.filter((r) => r[key]).map((r) => [up(r[key]), r]));
  let added = 0, updated = 0;
  for (const r of incoming) { if (m.has(r[key])) updated++; else added++; m.set(r[key], r); }
  const rows = [...m.values()].sort((a, b) => (ar.parseDate(b.issueDate) || 0) - (ar.parseDate(a.issueDate) || 0) || up(b[key]).localeCompare(up(a[key])));
  return { rows, added, updated };
}

// ── Pipeline ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Customer group of a QT nobody invoiced (so nothing in the AR book says it): from the product name. An estimate.
const ORG = /บริษัท|จำกัด|มหาชน|ห้างหุ้นส่วน|หจก|co\.|ltd|limited|company|\binc\b|corp|pte|plc|มหาวิทยาลัย|โรงเรียน|วิทยาลัย|สมาคม|มูลนิธิ|สถาบัน|สำนักงาน|ธนาคาร|การไฟฟ้า|กรม|กระทรวง|องค์การ|เทศบาล/i;
function guessSeg(q) {
  const m = /B2[BCEGS]/.exec(String(q.product || ''));
  if (m) return m[0];
  if (!ORG.test(String(q.company || ''))) return 'B2C';
  return /^\s*\d+\s*-\s*\(/.test(String(q.product || '')) ? 'B2E' : 'B2B'; // "5280 - (Xtra Plus) …" is a Whitehouse package
}

// reqs: Requests rows · invs: every Invoices row, enriched (ar.enrich + preVatN) · pq / pi: the PEAK report tabs
// sees(row): may this user see a document of this seller / customer group
function pipeline({ reqs, invs, pq = [], pi = [], sees }) {
  const byIv = new Map(), byReq = new Map(), byQt = new Map(), segOfTax = new Map();
  const put = (m, k, r) => { if (k) { if (!m.has(k)) m.set(k, []); m.get(k).push(r); } };
  for (const r of invs) {
    byIv.set(up(r.ivNo), r);
    if (r.state === 'Closed') continue;
    if (r.requestId) put(byReq, r.requestId, r);
    if (r.qtNo) put(byQt, up(r.qtNo), r);
    if (r.taxId && r.segment) segOfTax.set(String(r.taxId).trim(), r.segment);
  }
  const piByQt = new Map();
  for (const r of pi) put(piByQt, up(r.qtNo), r);
  const reqByQt = new Map(reqs.filter((q) => q.peakQtNo).map((q) => [up(q.peakQtNo), q]));
  const out = [], seen = new Set();

  // INVs of one QT: PEAK's report first (it knows every INV of the QT), then INVs the AR book links to it that the
  // report does not have (issued after the upload). Each: pre-VAT amount and the share collected.
  const invoicesOf = (qtNo, requestId) => {
    const list = [], had = new Set();
    for (const p of piByQt.get(qtNo) || []) {
      const s = byIv.get(up(p.ivNo)); had.add(up(p.ivNo));
      // PEAK says whether the INV is settled; the AR book knows part payments of one that is not.
      list.push({ amt: ar.num(p.preVat), share: p.status === PEAK_PAID ? 1 : s && s.state !== 'Closed' ? paidShare(s) : 0, s });
    }
    for (const s of [...(byReq.get(requestId) || []), ...(byQt.get(qtNo) || [])]) {
      if (had.has(up(s.ivNo))) continue;
      had.add(up(s.ivNo)); list.push({ amt: s.preVatN || 0, share: paidShare(s), s });
    }
    return list;
  };
  const add = ({ qtNo, company, ms, total, st, ivs, floor = 0, req, src, link }) => {
    const sum = ivs.reduce((t, x) => t + x.amt, 0);
    // PEAK says "fully invoiced" but no INV is known here (e.g. a 2025 QT without the 2025 invoice report): the QT
    // total counts as invoiced, and whether it was paid is not known.
    const blind = st === 'won' && !ivs.length;
    const inv = round2(blind ? total : Math.min(total, Math.max(sum, floor)));
    const paid = round2(Math.min(inv, ivs.reduce((t, x) => t + x.amt * x.share, 0)));
    // The status in the upload can be older than the INVs known here.
    const now = inv >= total - 1 ? 'won' : inv > 0.009 ? 'part' : st === 'won' ? 'open' : st;
    const first = (ivs.find((x) => x.s) || {}).s;
    const sales = (req && (req.salesName || req.requestedBy)) || (first && (first.salesName || first.salesEmail)) || '(ไม่ระบุ)';
    const email = (req && req.requestedBy) || (first && first.salesEmail) || '';
    const seg = (req && req.segment) || (first && first.segment) || src.seg || 'Others';
    if (!sees({ salesEmail: email, segment: seg })) return;
    out.push({ qtNo, company, sales, seg, date: ar.fmt(ms), total, inv, paid, unk: blind ? inv : undefined, st: now, link: link || undefined });
  };

  for (const q of pq) {
    const qtNo = up(q.qtNo), st = BUCKET[q.status];
    if (!qtNo || !st || seen.has(qtNo)) continue; // drafts and unknown statuses are left out
    const ms = ar.parseDate(q.issueDate), total = round2(ar.num(q.preVat));
    if (ms === null || !(total > 0)) continue;
    seen.add(qtNo);
    const req = reqByQt.get(qtNo);
    add({ qtNo, company: q.company, ms, total, st, ivs: invoicesOf(qtNo, req && req.requestId), req, link: req && req.peakDocLink,
      src: { seg: segOfTax.get(String(q.taxId || '').trim()) || guessSeg(q) } });
  }
  // QTs from the app that the last upload does not have.
  for (const q of reqs) {
    const qtNo = up(q.peakQtNo);
    if (!qtNo || seen.has(qtNo) || !QT_LIVE.includes(q.status)) continue;
    const ms = ar.parseDate(q.qtApprovedAt) ?? ar.parseDate(q.createdAt), total = round2(ar.num(q.totalPreVat));
    if (ms === null || !(total > 0)) continue;
    seen.add(qtNo);
    // An INV issued from this QT before the app existed is only known as an amount (openingInvoiced / the sheet's total).
    add({ qtNo, company: q.company, ms, total, st: 'open', ivs: invoicesOf(qtNo, q.requestId), floor: Math.max(ar.num(q._invoicedPreVat), ar.num(q.openingInvoiced)), req: q, link: q.peakDocLink, src: {} });
  }
  return out;
}

// The same question starting from the INV: INVs issued in a month (every INV in the AR book, with or without a QT)
// and how much of them has been collected, pre-VAT. One row per month × seller × customer group, 36 months back.
function invoiceMonths(invs, today) {
  const from = Date.UTC(new Date(today).getUTCFullYear(), new Date(today).getUTCMonth() - 35, 1);
  const g = new Map();
  for (const r of invs) {
    if (r.state === 'Closed' || r.issueMs === null || r.issueMs < from || !(r.preVatN > 0)) continue;
    const m = ar.fmt(r.issueMs).slice(3), sales = r.salesName || r.salesEmail || '(ไม่ระบุ)', seg = r.segment || 'Others', k = [m, sales, seg].join('|');
    const o = g.get(k) || g.set(k, { m, sales, seg, n: 0, inv: 0, paid: 0 }).get(k);
    o.n++; o.inv += r.preVatN; o.paid += r.preVatN * paidShare(r);
  }
  return [...g.values()].map((o) => ({ ...o, inv: round2(o.inv), paid: round2(o.paid) }));
}

// When each report was last uploaded and what it covers (shown on the page).
function reportInfo(rows, key) {
  const live = rows.filter((r) => r[key]);
  if (!live.length) return null;
  const ms = live.map((r) => ar.parseDate(r.issueDate)).filter((x) => x !== null);
  const at = live.map((r) => String(r.importedAt || '')).sort((a, b) => (ar.parseDate(b) || 0) - (ar.parseDate(a) || 0) || b.localeCompare(a))[0] || '';
  return { count: live.length, from: ms.length ? ar.fmt(Math.min(...ms)) : '', to: ms.length ? ar.fmt(Math.max(...ms)) : '', at };
}

module.exports = { pipeline, invoiceMonths, paidShare, reportRow, mergeReport, reportInfo, guessSeg, BUCKET, DRAFT };
