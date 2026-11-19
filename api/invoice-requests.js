// /api/invoice-requests
//   GET   → the signed-in user's invoice requests (Operation sees everyone's), newest first
//   POST  → ask accounting to issue one or more invoices against a quotation. One QT can
//           become several INVs: partial billing (customer draws credit over time) or a
//           different billing entity per INV (e.g. subsidiaries). Needs evidence that the
//           customer accepted the QT (signed QT, PO, confirmation email, other).
//   PATCH → follow-ups on one INV: the customer now wants the original document
//           (sales), or the original has been sent (Operation / accounting).

const crypto = require('crypto');
const { checkOrigin, sendError } = require('../lib/session');
const { requireUser, can, visibility, docLinkFor } = require('../lib/users');
const users = require('../lib/users');
// Requests that no longer count (turned down, or their INV / receipt voided in PEAK).
const DEAD = new Set(['rejected', 'iv_void', 'rt_void']);
// Receipts of an INV paid in rounds. A receipt made for one round carries "รอบ <notice> · รับเงิน <amount>" in its note;
// a receipt without it covers everything received that has no receipt yet (the whole INV when there were no round receipts).
const rtRound = (x) => { const m = /รอบ (PAY-[A-Z0-9-]+) · รับเงิน ([\d,.]+)/.exec(String(x.note || '')); return m ? { id: m[1], amount: Number(m[2].replace(/,/g, '')) || 0 } : null; };
function rtPlan(a, rts, notices, noticeId) {
  const ivNo = String(a.ivNo).toUpperCase();
  const live = rts.filter((x) => String(x.refDoc).toUpperCase() === ivNo && !DEAD.has(x.status));
  const whole = live.find((x) => !rtRound(x));
  if (whole || (a.rtNo && !live.length)) throw bad(`INV นี้มีใบเสร็จแล้ว (${whole ? whole.peakRtNo || whole.rtRequestId : a.rtNo}) รีเฟรชหน้า`, 409);
  const done = live.map(rtRound);
  if (noticeId) {
    const n = notices.find((x) => x.noticeId === noticeId && String(x.ivNo).toUpperCase() === ivNo && x.status === 'confirmed');
    if (!n) throw bad('ไม่พบรอบรับเงินนี้ หรือยังไม่ได้ยืนยันเงินเข้า', 404);
    if (done.some((c) => c.id === n.noticeId)) throw bad('รอบนี้ออกใบเสร็จแล้ว รีเฟรชหน้า', 409);
    const amount = round2(Number(String(n.amount).replace(/,/g, '')));
    return { amount, paidDate: n.paidDate, tag: ` · รอบ ${n.noticeId} · รับเงิน ${amount.toFixed(2)}`, round: true, slip: n.slipLink };
  }
  if (!a.paidDate) throw bad('ยังรับเงินไม่ครบ ออกใบเสร็จรวมได้เมื่อรับครบ หรือออกใบเสร็จของรอบที่รับแล้ว', 409);
  const total = round2(Number(String(a.paidAmount).replace(/,/g, '')) || 0);
  const rest = round2(total - done.reduce((t, c) => t + c.amount, 0));
  if (done.length && rest <= 0.01) throw bad('ออกใบเสร็จครบทุกรอบแล้ว', 409);
  return { amount: done.length ? rest : total, paidDate: a.paidDate, tag: done.length ? ` · รับเงิน ${rest.toFixed(2)} (ส่วนที่เหลือ)` : '', round: false, rest: done.length > 0, total };
}
const rtNoAdd = (cur, no) => { const xs = String(cur || '').split(/\s*,\s*/).filter(Boolean); return xs.map((x) => x.toUpperCase()).includes(String(no).toUpperCase()) ? xs.join(', ') : [...xs, no].join(', '); };
const hub = require('../lib/hub');
const drive = require('../lib/drive');
const notify = require('../lib/notify');
const { OPP_ONLY_RE, OPP_RE, normaliseOppId } = require('../lib/crm');
const { validTaxId, normBranch } = require('../lib/taxid');
const ar = require('../lib/ar');
const peakdoc = require('../lib/peakdoc');
const { vatIncluded, vatSplit } = require('../lib/pricing');

// Every PEAK number / link already recorded in the app, for the reuse check.
async function docsInUse() {
  const [reqs, ivs, rts, invs] = await Promise.all([hub.readTable('Requests'), hub.readTable('InvoiceRequests'), hub.readTable('ReceiptRequests'), hub.readTable('Invoices')]);
  const out = [];
  reqs.forEach((x) => out.push({ no: x.peakQtNo, link: x.peakDocLink, ref: x.requestId, taxId: x.taxId, label: `QT ของคำขอ ${x.requestId}` }));
  ivs.filter((x) => !DEAD.has(x.status)).forEach((x) => out.push({ no: x.peakIvNo, link: x.peakDocLink, ref: x.ivRequestId, taxId: x.taxId, label: `INV ของคำขอ ${x.ivRequestId}` }));
  rts.filter((x) => !DEAD.has(x.status)).forEach((x) => out.push({ no: x.peakRtNo, link: x.peakDocLink, ref: x.rtRequestId, taxId: x.taxId, label: `ใบเสร็จของคำขอ ${x.rtRequestId}` }));
  invs.filter((x) => x.ivRequestId).forEach((x) => out.push({ no: x.ivNo, link: x.peakDocLink, ref: x.ivRequestId, taxId: x.taxId, label: `INV ${x.ivNo} ในหน้าติดตามหนี้` }));
  invs.filter((x) => x.rtNo).forEach((x) => out.push({ no: x.rtNo, ref: 'paid:' + x.ivNo, taxId: x.taxId, label: `ใบเสร็จของ ${x.ivNo} ในหน้าติดตามหนี้` }));
  return out;
}
async function assertDoc(kind, { no, link, ref, extraRefs = [], taxId }) {
  const err = peakdoc.checkDoc(kind, no, link);
  if (err) throw bad(err);
  const used = (await docsInUse()).filter((u) => !extraRefs.includes(u.ref));
  const again = peakdoc.findReuse(used, { no, link, ref, taxId, sameCustomerOk: kind === 'RT' });
  if (again) throw bad(`${again} ตรวจเลข/ลิงก์อีกครั้ง`, 409);
}

const EVIDENCE = ['QT ที่ลูกค้าเซ็นแล้ว', 'PO จากลูกค้า', 'อีเมลยืนยันจากลูกค้า', 'อื่นๆ'];
const ORIGINAL = { no: 'not_needed', yes: 'requested', unknown: 'pending_decision' };
const MAX_INVOICES = 12;
const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const text = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
const dmy = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
const num = (v) => (v === '' || v === undefined || v === null ? '' : Number(String(v).replace(/,/g, '')));
const money = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const round2 = (n) => Math.round(n * 100) / 100;

function newBatchId(now = new Date()) {
  const t = new Date(now.getTime() + 7 * 3600e3);
  const p = (x) => String(x).padStart(2, '0');
  return `INVREQ-${String(t.getUTCFullYear()).slice(2)}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function checkEntity(e, label) {
  if (!e.company) throw bad(`${label}: ใส่ชื่อบริษัทตามที่จะออก INV`);
  // 13-digit tax ID is the single source of truth for the billed entity (all segments).
  if (!/^\d{13}$/.test(e.taxId || '')) throw bad(`${label}: กรอกเลขประจำตัวผู้เสียภาษี 13 หลัก`);
  e.taxCheckWarn = !!e.taxId && !validTaxId(e.taxId);
  const br = normBranch(e.branch);
  if (br === null) throw bad(`${label}: สาขาต้องเป็นรหัส 5 หลัก เช่น 00000 (สำนักงานใหญ่)`);
  e.branch = br;
}

function validate(b) {
  if (!b || typeof b !== 'object') throw bad('ข้อมูลคำขอไม่ถูกต้อง');
  const r = {
    requestId: text(b.requestId, 40),
    qtNo: text(b.qtNo, 40),
    opportunityId: normaliseOppId(b.opportunityId),
    segment: text(b.segment, 20),
    whtRate: String(b.whtRate ?? '').trim(),
    company: text(b.company, 200),
    taxId: text(b.taxId, 20).replace(/[\s-]/g, ''),
    branch: text(b.branch, 20),
    evidenceType: text(b.evidenceType, 40),
    evidenceOther: text(b.evidenceOther, 120),
    financeContact: text(b.financeContact, 120),
    financeEmail: text(b.financeEmail, 120),
    financePhone: text(b.financePhone, 40),
    note: text(b.note, 1000),
    overReason: text(b.overReason, 300),
    offReason: text(b.offReason, 300),
    payCycle: text(b.payCycle, 120),
    poNeeded: ['yes', 'no', 'unknown'].includes(b.poNeeded) ? b.poNeeded : '',
  };
  if (!r.qtNo) throw bad('ใส่เลขที่ใบเสนอราคา (QT) ที่ต้องการออก INV');
  if (!['0', '1', '2', '3', '5'].includes(r.whtRate)) throw bad('เลือกหัก ณ ที่จ่าย (ไม่หัก / 1% / 2% / 3% / 5%)');
  if (/^CRM-LEAD-/.test(r.opportunityId)) throw bad('ออก INV ได้เมื่อ lead ถูก convert เป็น Opportunity แล้วเท่านั้น ใส่ Opportunity ID (CRM-OPP-YYYY-NNNNN)');
  if (r.opportunityId && !OPP_ONLY_RE.test(r.opportunityId)) throw bad('Opportunity ID ต้องเป็นรูปแบบ CRM-OPP-YYYY-NNNNN');
  checkEntity(r, 'ลูกค้าตาม QT');
  if (!EVIDENCE.includes(r.evidenceType)) throw bad('เลือกประเภทหลักฐานที่ลูกค้ายอมรับ');
  if (r.evidenceType === 'อื่นๆ' && !r.evidenceOther) throw bad('ระบุว่าหลักฐานเป็นเอกสารอะไร');
  if (!b.file) throw bad('แนบไฟล์หลักฐาน (PDF / JPG / PNG)');
  if (!r.poNeeded) throw bad('เลือกว่าลูกค้าต้องใช้ PO ในการวางบิลไหม');
  if (b.docs !== undefined && (!Array.isArray(b.docs) || b.docs.length > 2)) throw bad('แนบเอกสารบริษัทได้ไม่เกิน 2 ไฟล์');
  if (!r.financeContact) throw bad('ใส่ชื่อผู้ติดต่อฝ่ายการเงินของลูกค้า');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.financeEmail)) throw bad('ใส่อีเมลฝ่ายการเงินของลูกค้า');
  if (!/\d{9,}/.test(r.financePhone.replace(/\D/g, ''))) throw bad('ใส่เบอร์โทรฝ่ายการเงินของลูกค้า');

  const list = Array.isArray(b.invoices) ? b.invoices : [];
  if (list.length < 1) throw bad('เพิ่มใบแจ้งหนี้อย่างน้อย 1 ใบ');
  if (list.length > MAX_INVOICES) throw bad(`ขอได้ไม่เกิน ${MAX_INVOICES} ใบต่อครั้ง`);
  const invoices = list.map((x, i) => {
    const label = `INV ใบที่ ${i + 1}`;
    const same = !x || x.billTo !== 'other';
    const v = {
      billTo: same ? 'same' : 'other',
      taxCheckWarn: same ? r.taxCheckWarn : false,
      company: same ? r.company : text(x.company, 200),
      taxId: same ? r.taxId : text(x.taxId, 20).replace(/[\s-]/g, ''),
      branch: same ? r.branch : text(x.branch, 20),
      relation: same ? '' : text(x.relation, 80),
      label: text(x && x.label, 40),
      // In the segment's basis (before VAT, or VAT-inclusive for B2C / B2E / MaoMao / Others). Split in create().
      amount: num(x && (x.amount !== undefined ? x.amount : x.amountPreVat)),
      students: num(x && x.students),
      wantedIssueDate: text(x && x.wantedIssueDate, 10),
      creditTermDays: num(x && x.creditTermDays),
      poNo: text(x && x.poNo, 60),
      originalDoc: Object.prototype.hasOwnProperty.call(ORIGINAL, x && x.originalDoc) ? x.originalDoc : '',
      originalRecipient: text(x && x.originalRecipient, 120),
      originalAddress: text(x && x.originalAddress, 500),
      note: text(x && x.note, 500),
    };
    if (!same) checkEntity(v, label);
    if (!same && !v.relation) throw bad(`${label}: ระบุความสัมพันธ์กับลูกค้าตาม QT เช่น บริษัทลูก`);
    if (!(v.amount > 0 && v.amount < 1e9)) throw bad(`${label}: ใส่ยอดเงิน`);
    v.amount = round2(v.amount);
    if (v.students === '') throw bad(`${label}: ใส่จำนวนผู้เรียนในใบนี้`);
    if (!v.wantedIssueDate) throw bad(`${label}: ใส่วันที่ต้องการให้ลงใน INV`);
    if (v.creditTermDays === '') throw bad(`${label}: ใส่เครดิตเทอม (วัน)`);
    if (!(Number.isInteger(v.students) && v.students >= 1 && v.students <= 5000)) throw bad(`${label}: จำนวนผู้เรียนไม่ถูกต้อง`);
    if (v.wantedIssueDate && !/^\d{4}-\d{2}-\d{2}$/.test(v.wantedIssueDate)) throw bad(`${label}: วันที่ออก INV ไม่ถูกต้อง`);
    if (v.creditTermDays !== '' && !(Number.isInteger(v.creditTermDays) && v.creditTermDays >= 0 && v.creditTermDays <= 180)) throw bad(`${label}: เครดิตเทอมต้องอยู่ระหว่าง 0 ถึง 180 วัน`);
    if (!v.originalDoc) throw bad(`${label}: เลือกว่าต้องส่งเอกสารตัวจริงไหม`);
    if (v.originalDoc === 'yes' && (!v.originalAddress || !v.originalRecipient)) throw bad(`${label}: ใส่ผู้รับและที่อยู่สำหรับส่งเอกสารตัวจริง`);
    return v;
  });
  return { r, invoices };
}

const n0 = (x) => Number(String(x ?? '').replace(/,/g, '')) || 0;
// Amount already requested against a QT (rejected requests don't count), in the QT's basis:
// VAT-inclusive QTs compare VAT-inclusive amounts, so splitting 15,900 into 7,950 × 2 never
// trips the balance check on rounded satang.
function alreadyInvoiced(rows, { requestId, qtNo }, incl = false) {
  return round2(rows
    .filter((x) => !DEAD.has(x.status) && ((requestId && x.requestId === requestId) || (!requestId && qtNo && x.qtNo === qtNo)))
    .reduce((s, x) => s + (incl ? (n0(x.amountInclVat) || round2(n0(x.amountPreVat) * 1.07)) : n0(x.amountPreVat)), 0));
}

async function create(req, res, user) {
  checkOrigin(req);
  if (!can(user, 'request')) throw bad('ไม่มีสิทธิ์ขอเอกสาร', 403);
  const b = req.body || {};
  const { r, invoices } = validate(b);

  if (!drive.enabled()) throw Object.assign(new Error('ระบบยังไม่ได้ตั้งค่าที่เก็บไฟล์ (DOCS_FOLDER_ID) แจ้งผู้ดูแลระบบ'), { status: 500 });
  const now = new Date();
  const at = hub.sheetDateTime(now);
  const batchId = newBatchId(now);
  // Checks first (sheet reads are quick), so a duplicate or over-QT request never leaves a stray file in Drive.
  const [requests, existing] = await Promise.all([r.requestId || r.qtNo ? hub.readTable('Requests') : [], hub.readTable('InvoiceRequests')]);
  // The QT number was typed as "outside the app" but the app knows that QT (e.g. one accounting brought in
  // from PEAK): use it, so the balance is checked and accounting does not have to link the request again.
  let typed = false;
  if (!r.requestId && r.qtNo) {
    const hit = requests.find((x) => String(x.peakQtNo || '').trim().toUpperCase() === String(r.qtNo).trim().toUpperCase()
      && ['qt_approved', 'accepted', 'iv_requested', 'iv_issued'].includes(x.status));
    if (hit) { r.requestId = hit.requestId; r.offReason = ''; typed = true; }
  }
  let linked = null;
  if (r.requestId) {
    linked = requests.find((x) => x.requestId === r.requestId);
    if (!linked || (!typed && !can(user, 'approve') && linked.requestedBy !== user.email)) throw bad('ไม่พบคำขอใบเสนอราคาที่เลือก');
    // Only a QT accounting has approved in PEAK can be billed.
    if (!['qt_approved', 'accepted', 'iv_requested', 'iv_issued'].includes(linked.status)) throw bad('QT นี้ยังไม่ได้อนุมัติใน PEAK ขอ INV ได้หลังฝ่ายบัญชีอนุมัติ QT แล้ว', 409);
    // PEAK API on: the QT may have been edited in PEAK since; balance checks below use its current totals.
    if (linked.peakQtId) {
      const pk = require('../lib/peak');
      if (pk.mode() !== 'off') { const pq = await pk.getQuotation(linked.peakQtId).catch(() => null); if (pq) await require('../lib/qtlines').refreshRequest(linked, pq).catch(() => null); }
    }
    if (linked.peakQtNo && (await hub.readTable('EditRequests')).some((x) => x.docType === 'QT' && x.docNo === String(linked.peakQtNo).toUpperCase() && x.status === 'new')) {
      throw bad(`QT ${linked.peakQtNo} มีคำขอแก้ไขที่รอฝ่ายบัญชีอยู่ ขอ INV ได้หลังฝ่ายบัญชีแก้เสร็จ`, 409);
    }
    // A QT asked for with a Lead ID does not pass its ID on: the INV needs the Opportunity ID.
    if (!r.opportunityId && !/^CRM-LEAD-/.test(linked.opportunityId || '')) r.opportunityId = linked.opportunityId || '';
    r.segment = linked.segment || r.segment;
  }
  // Customer type (PEAK G012): the QT's own, or picked on the form for a QT outside the app.
  const T = require('../lib/types');
  const ctype = linked ? ((await T.list()).find((t) => t.name === linked.segment) || { name: linked.segment, vat: vatIncluded(linked.segment) ? 'incl' : 'excl', opp: linked.segment !== 'B2S' })
    : await T.resolve(b.customerType || b.segment);
  r.segment = ctype.name;
  // A QT typed by hand (not a request in this app): no balance or approval check is possible, so a reason is required.
  if (!r.requestId && !r.offReason) throw bad('เลือก QT จากระบบ หรือใส่เหตุผลที่ใช้ QT นอกระบบ');
  // A QT keeps the basis it was made in (AG); rows without AG follow the segment.
  const incl = linked && linked.vatMode ? linked.vatMode === 'incl' : ctype.vat === 'incl';
  invoices.forEach((v) => { const sp = vatSplit(v.amount, incl); v.amountPreVat = sp.preVat; v.amountInclVat = sp.inclVat; });
  const basis = incl ? 'รวม VAT' : 'ก่อน VAT';
  // CRM Opportunity ID: as the customer type says (B2S has none).
  if (ctype.opp === false) r.opportunityId = '';
  else if (!r.opportunityId) throw bad(`ใส่ Opportunity ID จาก CRM (CRM-OPP-YYYY-NNNNN) สำหรับลูกค้า ${ctype.name} · ถ้า QT ใช้ Lead ID ต้อง convert เป็น Opportunity ก่อนออก INV`);

  // Same QT + same billed tax ID + same amount already requested (not rejected) → probably sent twice.
  if (b.confirmDuplicate !== true) {
    const ref = (x) => (r.requestId ? x.requestId === r.requestId : x.qtNo === r.qtNo);
    const same = existing.filter((x) => !DEAD.has(x.status) && ref(x)
      && invoices.some((v) => x.taxId === v.taxId && Math.abs((Number(String(x.amountPreVat).replace(/,/g, '')) || 0) - v.amountPreVat) < 0.01));
    if (same.length) {
      const e = bad(`QT ${r.qtNo} มีคำขอ INV ยอดเดียวกันอยู่แล้ว ${same.length} ใบ`, 409);
      e.extra = { duplicate: true, matches: same.slice(-5).map((x) => ({ id: x.ivRequestId, createdAt: x.createdAt, by: x.salesName || x.requestedBy, status: x.status, amount: x.amountPreVat, ivNo: x.peakIvNo })) };
      throw e;
    }
  }

  // Balance check: never silently bill more than the QT.
  const opening = linked ? n0(linked.openingInvoiced) : 0;
  const prior = round2(alreadyInvoiced(existing, r, incl) + (incl ? round2(opening * 1.07) : opening));
  const asked = round2(invoices.reduce((s, v) => s + v.amount, 0));
  const qtTotal = !linked ? 0 : incl ? (n0(linked.totalInclVat) || round2(n0(linked.totalPreVat) * 1.07)) : n0(linked.totalPreVat);
  // A QT invoiced in full takes no more INV (customer buys more → a new QT).
  if (linked && qtTotal > 0 && prior >= qtTotal - 0.01) throw bad(`QT ${r.qtNo} ขอ INV ครบยอดแล้ว (${money(prior)} จาก ${money(qtTotal)}) ถ้าลูกค้าซื้อเพิ่ม ให้ขอ QT ใบใหม่`, 409);
  const over = linked && qtTotal > 0 && prior + asked > qtTotal + 0.01;
  if (over && !r.overReason) {
    throw bad(`ยอดรวม INV ${basis} (${money(prior + asked)}) เกินยอด QT (${money(qtTotal)}) ใส่เหตุผลก่อนส่ง หรือแก้ยอด`);
  }

  const evidenceLink = await drive.upload(b.file, { kind: 'inv', docNo: r.qtNo, company: r.company, ref: batchId });
  // Company documents (หนังสือรับรอง / ภ.พ.20), optional.
  const docLinks = [];
  for (const [i, f] of (Array.isArray(b.docs) ? b.docs : []).entries()) docLinks.push(await drive.upload(f, { kind: 'company', part: i + 1, docNo: r.taxId, company: r.company, ref: batchId }));
  const evidenceType = r.evidenceType === 'อื่นๆ' ? `อื่นๆ: ${r.evidenceOther}` : r.evidenceType;
  const partial = invoices.length > 1 || prior > 0 || (qtTotal > 0 && Math.abs(asked - qtTotal) > 0.01);

  const rows = invoices.map((v, i) => ({
    ivRequestId: `${batchId}-${i + 1}`, createdAt: at, requestedBy: user.email, salesName: user.name,
    requestId: r.requestId, qtNo: r.qtNo, company: v.company, taxId: v.taxId,
    evidenceType, evidenceLink, wantedIssueDate: dmy(v.wantedIssueDate),
    billing: partial ? 'Partial' : 'Full', installment: v.label || (invoices.length > 1 ? `${i + 1}/${invoices.length}` : ''),
    amountPreVat: v.amountPreVat, students: v.students, creditTermDays: v.creditTermDays, poNo: v.poNo,
    financeContact: r.financeContact, financeEmail: r.financeEmail, financePhone: r.financePhone,
    deliveryAddress: v.originalAddress, note: [v.taxCheckWarn ? '[ตรวจเลขภาษี: หลักสุดท้ายไม่ผ่าน]' : '', v.note, r.note].filter(Boolean).join(' · '),
    status: 'new', peakIvNo: '', updatedAt: at, opportunityId: r.opportunityId,
    batchId, branch: v.branch, billToRelation: v.billTo === 'other' ? v.relation : '',
    originalDoc: v.originalDoc, originalStatus: ORIGINAL[v.originalDoc], originalRecipient: v.originalRecipient,
    originalAddress: v.originalAddress, originalRequestedAt: v.originalDoc === 'yes' ? at : '', originalSentAt: '', trackingNo: '',
    overReason: over ? r.overReason : (!r.requestId ? `QT นอกระบบ: ${r.offReason}` : ''), whtRate: r.whtRate,
    payCycle: r.payCycle, poNeeded: r.poNeeded, companyDocsLink: docLinks.join('\n'), amountInclVat: v.amountInclVat,
  }));
  await hub.appendRows('InvoiceRequests', rows);

  const remaining = qtTotal > 0 ? round2(qtTotal - prior - asked) : null;
  const after = [
    linked ? hub.updateRow('Requests', linked._row, {
      status: 'iv_requested', ivRequestedAt: linked.ivRequestedAt || at, updatedAt: at,
      peakQtNo: linked.peakQtNo || r.qtNo,
    }) : null,
    linked ? attachToPeak('quotation', linked.peakQtId, b.file, `INV-EVIDENCE_${batchId}`) : null,
    hub.log('catalog', 'invoice_requested', batchId,
      `${user.email} · ${r.qtNo} · ${rows.length} INV · ${asked}${over ? ' · over QT: ' + r.overReason : ''}`),
  ];

  const entities = [...new Set(rows.map((x) => x.company))];
  const originals = rows.filter((x) => x.originalDoc === 'yes').length;
  after.push(notify.chat(`🧾 ขอ INV · QT ${r.qtNo} · ${notify.co(entities[0])}${entities.length > 1 ? ` +${entities.length - 1}` : ''} · ${rows.length} ใบ ${money(asked)} บาท · ${user.name || user.email}${over ? ' · ⚠️ เกินยอด QT' : ''}${!r.requestId ? ' · ⚠️ QT นอกระบบ' : ''}${originals ? ' · 📮 ส่งตัวจริง' : ''} · ${notify.link('pend', undefined, { t: 'inv', q: r.qtNo })}`));
  await Promise.all(after);

  res.status(200).json({
    ok: true, batchId, ivRequestIds: rows.map((x) => x.ivRequestId), evidenceLink, asked, remaining, vatMode: incl ? 'incl' : 'excl',
    message: `ส่งคำขอออก INV ${rows.length} ใบแล้ว ฝ่ายบัญชีจะตรวจหลักฐานและออกเอกสารใน PEAK`,
  });
}

// PATCH { action: 'qt_adopt', ivRequestId, preview?: true, openingInvoiced? }  (accounting only)
// A pending INV request that names a QT made outside the app (e.g. a quota QT from an earlier year):
// read that QT from PEAK, add it as a request here so its balance is tracked, and link every INV
// request that names it. PEAK cannot list the INVs made from a QT, so accounting enters once what
// was invoiced before the app. Read-only in PEAK.
async function adoptQt(req, res, user) {
  checkOrigin(req);
  if (!can(user, 'approve')) throw bad('เฉพาะฝ่ายบัญชี', 403);
  const b = req.body || {};
  const peak = require('../lib/peak');
  const [ivs, reqs] = await Promise.all([hub.readTable('InvoiceRequests'), hub.readTable('Requests')]);
  const row = ivs.find((x) => x.ivRequestId === text(b.ivRequestId, 60));
  if (!row) throw bad('ไม่พบคำขอ INV นี้', 404);
  const code = String(row.qtNo || '').trim().toUpperCase();
  if (row.requestId || !code) throw bad('คำขอนี้ผูกกับ QT ในระบบอยู่แล้ว', 409);
  const up = (x) => String(x || '').trim().toUpperCase();
  const same = ivs.filter((x) => !x.requestId && up(x.qtNo) === code && !DEAD.has(x.status));
  const sum = (list) => round2(list.reduce((t, x) => t + n0(x.amountPreVat), 0));
  const waiting = same.filter((x) => x.status === 'new'), known = same.filter((x) => x.status !== 'new');
  let have = reqs.find((x) => up(x.peakQtNo) === code && !['rejected', 'qt_void', 'cancelled'].includes(x.status));
  let q = null;
  if (!have) {
    if (peak.mode() === 'off') throw bad('ยังไม่ได้เปิดการเชื่อมต่อ PEAK API', 503);
    q = await peak.findQuotationByCode(code);
    if (!q) throw bad(`ไม่พบ QT ${code} ใน PEAK (หรือถูก void แล้ว) ตรวจเลข QT ในคำขอ`, 404);
    if (!/approve/i.test(q.status || '')) throw bad(`QT ${code} ใน PEAK ยังไม่อนุมัติ (สถานะ ${q.status || '-'})`, 409);
  }
  const total = have ? n0(have.totalPreVat) : n0(q.preTaxAmount);
  const info = { qtNo: code, company: have ? have.company : (q.contactName || row.company), total, inApp: sum(known), inAppCount: known.length,
    waiting: sum(waiting), waitingCount: waiting.length, link: have ? have.peakDocLink : (q.documentLink || ''), exists: !!have,
    issuedDate: q ? String(q.issuedDate || '') : '' };
  if (b.preview === true) return res.status(200).json({ ok: true, preview: info });

  const opening = round2(n0(b.openingInvoiced));
  if (opening < 0) throw bad('ยอดที่ออก INV ไปแล้วต้องไม่ติดลบ');
  if (!have && opening + info.inApp > total + 0.01) throw bad(`ยอดที่ออก INV ไปแล้ว (${money(opening + info.inApp)}) เกินยอด QT (${money(total)}) ตรวจตัวเลขอีกครั้ง`);
  const at = hub.sheetDateTime();
  let requestId = have && have.requestId;
  if (!have) {
    requestId = `LEGACY-${code}`;
    if (reqs.some((x) => x.requestId === requestId)) requestId = `LEGACY-${code}-${Date.now().toString(36).toUpperCase()}`;
    const ymd = String(q.issuedDate || '').replace(/\D/g, '');
    const incl = Number(q.taxStatus) === 1;
    await hub.appendRows('Requests', [{
      requestId, createdAt: /^\d{8}$/.test(ymd) ? `${ymd.slice(6)}/${ymd.slice(4, 6)}/${ymd.slice(0, 4)} 00:00` : at,
      requestedBy: row.requestedBy, salesName: row.salesName, segment: row.segment || 'B2B', clientCode: q.contactCode || '',
      company: q.contactName || row.company, taxId: row.taxId, branch: row.branch, docLang: 'TH', status: 'qt_approved',
      note: `QT นอกระบบ นำเข้าจาก PEAK โดย ${user.name || user.email} เมื่อ ${at}`,
      peakQtNo: code, peakQtId: q.id, totalPreVat: n0(q.preTaxAmount), totalInclVat: n0(q.netAmount), vatMode: incl ? 'incl' : 'excl',
      qtApprovedAt: at, updatedAt: at, opportunityId: row.opportunityId || '', peakDocLink: q.documentLink || '', whtRate: row.whtRate || '',
      openingInvoiced: opening || '',
    }]);
  }
  for (const x of same) await hub.updateRow('InvoiceRequests', x._row, { requestId, updatedAt: at });
  if (!have) {
    // Classification of the QT in PEAK (customer type, seller): best effort, the QT is usable without it.
    try { const fresh = (await hub.readTable('Requests')).find((x) => x.requestId === requestId); await require('../lib/peaksync').syncQuotationClasses(fresh, q); } catch (e) { /* ignore */ }
  }
  const left = round2(total - (have ? n0(have.openingInvoiced) : opening) - info.inApp - info.waiting);
  await hub.log('catalog', 'qt_adopt', requestId, `${user.email} · ${code} · ยอด QT ${money(total)} · ออกก่อนใช้ระบบ ${money(opening)} · ผูกคำขอ INV ${same.length} ใบ`);
  res.status(200).json({ ok: true, requestId, linked: same.length, total, left, over: left < -0.01 });
}

// PATCH { ivRequestId, action: 'original', originalDoc: 'yes'|'no', recipient?, address? }  (owner or op)
//       { ivRequestId, action: 'original_sent', trackingNo? }                                (op only)
async function update(req, res, user) {
  checkOrigin(req);
  const b = req.body || {};
  const id = text(b.ivRequestId, 60);
  const rows = await hub.readTable('InvoiceRequests');
  const row = rows.find((x) => x.ivRequestId === id);
  if (!row || (!can(user, 'approve') && row.requestedBy !== user.email)) throw bad('ไม่พบคำขอ INV นี้', 404);
  const at = hub.sheetDateTime();
  if (can(user, 'approve')) hub.checkSeen(row, text(b.seen, 80));

  if (b.action === 'original') {
    const want = b.originalDoc === 'no' ? 'no' : 'yes';
    if (row.originalStatus === 'sent') throw bad('ส่งตัวจริงไปแล้ว', 409);
    if (DEAD.has(row.status)) throw bad(row.status === 'rejected' ? 'คำขอ INV นี้ถูกตีกลับแล้ว' : 'INV ของคำขอนี้ถูกยกเลิกแล้ว', 409);
    const address = text(b.address, 500) || row.originalAddress;
    const recipient = text(b.recipient, 120) || row.originalRecipient;
    if (want === 'yes' && (!address || !recipient)) throw bad('ใส่ผู้รับและที่อยู่สำหรับส่งเอกสารตัวจริง');
    await hub.updateRow('InvoiceRequests', row._row, {
      originalDoc: want, originalStatus: ORIGINAL[want], originalRecipient: recipient, originalAddress: address,
      deliveryAddress: address, originalRequestedAt: want === 'yes' ? at : '', updatedAt: at,
    });
    await hub.log('catalog', want === 'yes' ? 'original_requested' : 'original_not_needed', id, user.email);
    if (want === 'no' && row.originalStatus === 'requested') {
      await notify.chat(`📭 ยกเลิกขอเอกสารตัวจริง · ${row.peakIvNo || 'QT ' + row.qtNo} · ${notify.co(row.company)} · ${user.name || user.email}`);
    }
    if (want === 'yes') {
      await notify.chat(`📮 ขอเอกสารตัวจริง · ${row.peakIvNo || 'QT ' + row.qtNo} · ${notify.co(row.company)} · ${user.name || user.email} · ${notify.link('pend', undefined, { t: 'orig', q: row.peakIvNo || row.qtNo })}`);
    }
    return res.status(200).json({ ok: true, originalStatus: ORIGINAL[want] });
  }

  if (b.action === 'original_sent') {
    if (!can(user, 'approve')) throw bad('ไม่มีสิทธิ์อนุมัติเอกสาร', 403);
    // The original can only go out once the INV exists (approved in PEAK, number + link entered).
    if (row.status !== 'iv_issued') throw bad('ยังส่งตัวจริงไม่ได้: ต้องอนุมัติ INV (ใส่เลข INV และลิงก์ PEAK) ก่อน', 409);
    if (row.originalStatus === 'sent') throw bad(`บันทึกว่าส่งตัวจริงไปแล้ว${row.trackingNo ? ' (เลขพัสดุ ' + row.trackingNo + ')' : ''} รีเฟรชหน้าเพื่อดูข้อมูลล่าสุด`, 409);
    if (row.originalStatus !== 'requested') throw bad('ลูกค้ายังไม่ได้ขอเอกสารตัวจริงสำหรับ INV นี้', 409);
    const trackingNo = text(b.trackingNo, 60);
    await hub.writeChecked('InvoiceRequests', 'ivRequestId', row, { originalStatus: 'sent', originalSentAt: at, trackingNo, updatedAt: at });
    await hub.log('catalog', 'original_sent', id, `${user.email}${trackingNo ? ' · ' + trackingNo : ''}`);
    await notify.chat(`📮 ส่งเอกสารตัวจริงแล้ว · ${row.peakIvNo || 'QT ' + row.qtNo} · ${notify.co(row.company)}${trackingNo ? ' · พัสดุ ' + trackingNo : ''} · ${await notify.at(row.requestedBy, row.salesName)}`);
    return res.status(200).json({ ok: true, originalStatus: 'sent' });
  }

  // PEAK API on. iv_make: accounting checked the evidence → INV Draft in PEAK from the QT.
  // iv_check: "approved in PEAK" → read the INV from PEAK (number, date, link) instead of typing it.
  if (b.action === 'iv_make' || b.action === 'iv_check') {
    if (!can(user, 'approve')) throw bad('ไม่มีสิทธิ์อนุมัติเอกสาร', 403);
    const peak = require('../lib/peak');
    if (peak.mode() === 'off') throw bad('ยังไม่ได้เปิดการเชื่อมต่อ PEAK API', 409);
    const who = user.name || user.email;
    if (b.action === 'iv_make') {
      const t0 = Date.now();
      if (row.status !== 'new' || row.peakIvId) throw bad(`คำขอนี้มี INV ใน PEAK แล้ว (${row.peakIvNo || row.status}) รีเฟรชหน้า`, 409);
      const [reqs, users] = await Promise.all([hub.readTable('Requests'), hub.readTable('Users')]);
      const qt = reqs.find((x) => x.requestId === row.requestId);
      // Claim the row first so a double click can't make two INVs.
      await hub.writeChecked('InvoiceRequests', 'ivRequestId', row, { status: 'iv_creating', updatedAt: at });
      let out;
      let madeId = '';
      try {
        out = (await require('../lib/ivdraft').createForIvRequest(row, qt, users, async (m) => {
          madeId = m.peakIvId; await hub.updateRow('InvoiceRequests', row._row, { peakIvId: m.peakIvId, peakIvNo: m.peakIvNo });
        })).fields;
      }
      catch (e) {
        // A Draft that already exists in PEAK stays linked (status iv_draft), so pressing again cannot make a second one.
        if (madeId) {
          await hub.updateRow('InvoiceRequests', row._row, { status: 'iv_draft', updatedAt: hub.sheetDateTime(), accountNote: `สร้าง INV Draft ใน PEAK แล้ว แต่ขั้นตอนหลังจากนั้นไม่ครบ (${String(e.message).slice(0, 200)}) ตรวจ Draft ใน PEAK`.slice(0, 500) });
          await hub.log('peak', 'iv_live_partial', id, String(e.message).slice(0, 200));
          throw bad(`สร้าง INV Draft ใน PEAK แล้ว แต่ขั้นตอนหลังจากนั้นไม่ครบ ตรวจ Draft ใน PEAK: ${String(e.message).slice(0, 200)}`, 502);
        }
        await hub.updateRow('InvoiceRequests', row._row, { status: 'new', updatedAt: hub.sheetDateTime(), accountNote: `สร้าง INV ใน PEAK ไม่สำเร็จ: ${String(e.message).slice(0, 300)}` });
        await hub.log('peak', 'iv_live_error', id, String(e.message).slice(0, 200));
        throw bad(`สร้าง INV ใน PEAK ไม่สำเร็จ: ${String(e.message).slice(0, 300)}`, e.status === 409 ? 409 : 502);
      }
      out.updatedAt = hub.sheetDateTime();
      out.accountNote = `${out.accountNote} — ${who}`.slice(0, 500);
      await hub.updateRow('InvoiceRequests', row._row, out);
      // The evidence Sales attached goes on the INV too, when there is time left: PEAK can take several
      // seconds per call, and the Draft itself must never be lost to the function's time limit.
      if (Date.now() - t0 < 35e3) {
        const ev = await drive.download(row.evidenceLink).catch(() => null);
        if (ev) await attachToPeak('invoice', out.peakIvId, ev, `INV-EVIDENCE_${row.ivRequestId}`);
      } else {
        await hub.updateRow('InvoiceRequests', row._row, { accountNote: `${out.accountNote} · PEAK ช้า: ยังไม่ได้แนบหลักฐานเข้า INV แนบเองใน PEAK`.slice(0, 500) }).catch(() => {});
      }
      await hub.log('peak', 'iv_live_draft', id, `${user.email} · ${out.peakIvNo}`);
      return res.status(200).json({ ok: true, status: 'iv_draft', peakIvNo: out.peakIvNo, message: out.accountNote });
    }
    if (!['iv_draft', 'new', 'iv_creating'].includes(row.status) || !row.peakIvId) throw bad('คำขอนี้ยังไม่มี INV Draft ใน PEAK', 409);
    const d = await peak.getInvoice(row.peakIvId);
    if (!d) throw bad('ไม่พบ INV นี้ใน PEAK', 404);
    if (Number(d.isVoid) === 1 || /void/i.test(d.status || '')) throw bad(`INV ${d.code} ถูกยกเลิกใน PEAK แล้ว`, 409);
    if (/draft/i.test(d.status || '')) throw bad(`INV ${d.code} ใน PEAK ยังเป็น Draft อนุมัติใน PEAK ก่อน แล้วกดอีกครั้ง`, 409);
    const dmyOf = (x) => { const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(x || '').replace(/-/g, '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
    await issueInv(row, { ivNo: String(d.code).toUpperCase(), link: d.documentLink || row.peakDocLink, issueDate: dmyOf(d.issuedDate) || row.wantedIssueDate, note: `อนุมัติ INV ใน PEAK แล้ว — ${who}`, peakIvId: d.id }, { checked: true });
    await hub.log('catalog', 'iv_check', id, `${user.email} · ${d.code}`);
    return res.status(200).json({ ok: true, status: 'iv_issued', peakIvNo: d.code });
  }

  // A request left in "creating" (the step that makes the Draft was cut off): back to the queue.
  // Only when no Draft is known for it and it has been stuck for a few minutes.
  if (b.action === 'iv_reset') {
    if (!can(user, 'approve')) throw bad('ไม่มีสิทธิ์อนุมัติเอกสาร', 403);
    if (row.status !== 'iv_creating') throw bad('คำขอนี้ไม่ได้ค้างอยู่ รีเฟรชหน้า', 409);
    if (row.peakIvId) throw bad(`คำขอนี้มี INV Draft ${row.peakIvNo || ''} ใน PEAK แล้ว กด "เช็กสถานะจาก PEAK"`, 409);
    const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})/.exec(String(row.updatedAt || ''));
    const ms = (m ? Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]) - 7 * 3600e3 : 0);
    if (ms && Date.now() - ms < 2 * 60e3) throw bad('ระบบอาจยังสร้าง INV อยู่ รอ 2 นาทีแล้วลองอีกครั้ง', 409);
    await hub.updateRow('InvoiceRequests', row._row, { status: 'new', updatedAt: at, accountNote: `ตั้งกลับเป็นรอสร้าง INV (ค้างที่ขั้นสร้าง Draft) — ${user.name || user.email}` });
    await hub.log('catalog', 'iv_reset', id, user.email);
    return res.status(200).json({ ok: true });
  }

  // Accounting: INV issued from the QT in PEAK (fallback when the sync hasn't picked it up), or rejected.
  if (b.action === 'issued' || b.action === 'reject' || b.action === 'reopen') {
    if (!can(user, 'approve')) throw bad('ไม่มีสิทธิ์อนุมัติเอกสาร', 403);
    const note = text(b.note, 500);
    const FROM = { issued: ['new', 'iv_draft'], reject: ['new', 'iv_draft'], reopen: ['rejected'] };
    if (!FROM[b.action].includes(row.status)) {
      throw bad(`ทำรายการนี้ไม่ได้: คำขอ INV อยู่ในสถานะ ${row.status}${row.peakIvNo ? ' (' + row.peakIvNo + ')' : ''} แล้ว รีเฟรชหน้าเพื่อดูข้อมูลล่าสุด`, 409);
    }
    if (b.action === 'reject') {
      if (!note) throw bad('ใส่เหตุผลที่ตีกลับ');
      await hub.writeChecked('InvoiceRequests', 'ivRequestId', row, { status: 'rejected', accountNote: `${note} — ${user.name || user.email}`, updatedAt: at });
      await notify.chat(`↩️ ตีกลับคำขอ INV · QT ${row.qtNo} · ${notify.co(row.company)} · ${await notify.at(row.requestedBy, row.salesName)} · ${notify.link('mine', undefined, { t: 'inv', q: row.ivRequestId })}\nเหตุผล: ${notify.why(note)}`).catch(() => {});
    } else if (b.action === 'reopen') {
      await hub.writeChecked('InvoiceRequests', 'ivRequestId', row, { status: 'new', updatedAt: at });
    } else {
      const ivNo = text(b.peakIvNo, 40).toUpperCase();
      if (!/^[A-Z]{1,6}-?\d{6,}$/.test(ivNo)) throw bad('ใส่เลข INV จาก PEAK เช่น IV-20261100014');
      // Accounting issues the INV from the QT in PEAK; approving here needs the link to that INV.
      let link = text(b.peakDocLink, 500), fromPeak = null;
      // Only the number given: read the date, link and id of that INV from PEAK (read-only).
      if (!link && require('../lib/peak').mode() !== 'off') {
        const iv = await require('../lib/peak').findInvoiceByCode(ivNo);
        if (!iv || Number(iv.isVoid) === 1 || /void/i.test(iv.status || '')) throw bad(`ไม่พบ INV ${ivNo} ใน PEAK (หรือถูก void แล้ว) ตรวจเลขอีกครั้ง`, 404);
        if (!/approve/i.test(iv.status || '')) throw bad(`INV ${ivNo} ใน PEAK ยังไม่อนุมัติ (สถานะ ${iv.status || '-'}) อนุมัติใน PEAK ก่อน`, 409);
        if (!iv.documentLink) throw bad(`PEAK ไม่ส่งลิงก์ของ INV ${ivNo} มา ใส่ลิงก์เองในช่อง "ใส่วันที่และลิงก์เอง"`);
        const want = n0(row.amountPreVat), got = n0(iv.preTaxAmount);
        if (want > 0 && Math.abs(want - got) > 1 && !(n0(row.amountInclVat) > 0 && Math.abs(n0(row.amountInclVat) - n0(iv.netAmount)) <= 1)) {
          throw bad(`ยอด INV ${ivNo} ใน PEAK (${money(got)} ก่อน VAT) ไม่ตรงกับคำขอนี้ (${money(want)}) ตรวจว่าใส่เลขถูกการ์ด ถ้าตั้งใจออกยอดนี้ ให้ใส่วันที่และลิงก์เอง`, 409);
        }
        const ymd = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(String(iv.issuedDate || ''));
        fromPeak = { id: iv.id, issueDate: ymd ? `${ymd[3]}/${ymd[2]}/${ymd[1]}` : '' };
        link = iv.documentLink;
      }
      if (!/^https:\/\/(doc|secure)\.peakaccount\.com\//.test(link)) throw bad('ใส่ลิงก์เอกสาร INV จาก PEAK (https://doc.peakaccount.com/… หรือ https://secure.peakaccount.com/…)');
      await assertDoc('INV', { no: ivNo, link, ref: row.ivRequestId, taxId: row.taxId });
      // Issue date as it is on the INV in PEAK (defaults to the date sales asked for).
      const issueDate = (fromPeak && fromPeak.issueDate) || dmy(text(b.issueDate, 10)) || row.wantedIssueDate;
      if (!ar.parseDate(issueDate)) throw bad('ใส่วันที่ออก INV ตามเอกสารใน PEAK');
      await issueInv(row, { ivNo, link, issueDate, note, ...(fromPeak ? { peakIvId: fromPeak.id } : {}) }, { checked: true });
    }
    await hub.log('catalog', `iv_${b.action}`, id, `${user.email}${note ? ' · ' + note : ''}`);
    return res.status(200).json({ ok: true });
  }

  throw bad('คำสั่งไม่ถูกต้อง');
}

// INV request → iv_issued, and the INV straight into AR (Invoices) so nobody re-types it for debt
// follow-up. Used by accounting's "อนุมัติ" and by the PEAK webhook (INV approved in PEAK).
//   opts.checked: the row came from the page (status/updatedAt guard); the webhook writes directly.
// Live PEAK only: put the file on the PEAK document too, so accounting sees it there (POST insertfile).
// Never blocks the action: a failure goes to SyncLog + chat for accounting to attach by hand.
async function attachToPeak(kind, transactionId, file, label) { // kind: quotation | invoice | receipt
  const peak = require('../lib/peak');
  if (peak.mode() === 'off' || !transactionId || String(transactionId).startsWith('legacy:') || !file) return 'skipped';
  try {
    await peak.insertFile(kind, transactionId, { ...file, name: `${String(label).replace(/[^\w.\-ก-๙]/g, '_').slice(0, 60)}.${(file.name || '').split('.').pop() || 'pdf'}` });
    await hub.log('catalog', 'peak_attach', label, `${kind} ${transactionId}`).catch(() => {});
    return 'attached';
  } catch (e) {
    await Promise.all([hub.log('catalog', 'peak_attach_failed', label, String(e.message).slice(0, 200)).catch(() => {}),
      notify.finance(`⚠️ แนบไฟล์ ${label} เข้า PEAK ไม่สำเร็จ แนบเองใน PEAK`).catch(() => {})]);
    return 'failed';
  }
}

async function issueInv(row, { ivNo, link, issueDate, note, peakIvId }, opts = {}) {
  const [invs, requests, lines, users, groups] = await Promise.all([
    hub.readTable('Invoices'), row.requestId ? hub.readTable('Requests') : [], row.requestId ? hub.readTable('RequestLines') : [],
    hub.readTable('Users'), ar.readProductGroups(),
  ]);
  const dup = invs.find((x) => String(x.ivNo).toUpperCase() === ivNo);
  if (dup && dup.ivRequestId && dup.ivRequestId !== row.ivRequestId) throw bad(`เลข ${ivNo} ถูกใช้กับคำขอ ${dup.ivRequestId} แล้ว ตรวจเลข INV อีกครั้ง`, 409);
  const f = { status: 'iv_issued', peakIvNo: ivNo, peakDocLink: link, accountNote: note || row.accountNote, updatedAt: hub.sheetDateTime() };
  if (peakIvId) f.peakIvId = peakIvId;
  if (opts.checked) await hub.writeChecked('InvoiceRequests', 'ivRequestId', row, f);
  else await hub.updateRow('InvoiceRequests', row._row, f);
  if (!dup) {
    const request = requests.find((x) => x.requestId === row.requestId);
    const ls = lines.filter((x) => x.requestId === row.requestId);
    const a = ar.rowFromRequest(row, { request, lines: ls, users, issueDate, ivNo, peakDocLink: link, productGroups: groups });
    if (peakIvId) a.peakIvId = peakIvId;
    await hub.appendRows('Invoices', [a]);
  }
  if (row.status !== 'iv_issued') await notify.chat(`✅ INV ${ivNo} ออกแล้ว · ${notify.co(row.company)} · ${await notify.at(row.requestedBy, row.salesName)} · ${notify.link('mine', undefined, { t: 'inv', q: ivNo })}`).catch(() => {});
}

// ---------------------------------------------------------------- AR (debt follow-up)
const isOp = (u) => can(u, 'ar');
// Which AR rows a user sees. Accounting / collectors / admins: all. A sales lead (ar_view only): the lead's
// unit: team b2b → B2B, team b2c → B2C, team both → every unit. An INV belongs to its owner's team; when the
// owner is unknown, has left, or works both units, the INV's customer type decides (B2B → b2b, the rest → b2c).
async function arSees(user) {
  if (isOp(user) || can(user, 'approve') || user.admin || user.team === 'both' || !['b2b', 'b2c'].includes(user.team)) return () => true;
  const teams = new Map((await users.list()).map((u) => [u.email.toLowerCase(), u.team]));
  return (row) => {
    const t = teams.get(String(row.salesEmail || '').toLowerCase());
    return (['b2b', 'b2c'].includes(t) ? t : row.segment === 'B2B' ? 'b2b' : 'b2c') === user.team;
  };
}
// Money in, one entry per time it came in: an INV paid in several rounds counts each round on its own date
// (also while the INV is still open); any other paid INV counts once, on its paid date.
function cashEvents(all, roundsOf) {
  const out = [];
  for (const r of all) {
    const xs = roundsOf ? roundsOf(r) : null;
    if (xs) { for (const x of xs) { const ms = ar.parseDate(x.paidDate); if (ms !== null) out.push({ r, ms, amount: x.amount, round: true }); } }
    else if (r.paidMs !== null) out.push({ r, ms: r.paidMs, amount: ar.num(r.paidAmount) || r.expected });
  }
  return out;
}
function summarise(all, today, events = cashEvents(all)) {
  // Old rows the Debt sheet still showed as unpaid are kept apart until someone checks them in PEAK.
  const check = all.filter((r) => r.legacyCheck);
  // Current receivables = issued from 2026 on. The old book (before 2026) is reported on its own.
  const open = all.filter((r) => (r.state === 'Outstanding' || r.state === 'Overdue') && !r.legacyCheck && !r.old);
  const oldOpen = all.filter((r) => (r.state === 'Outstanding' || r.state === 'Overdue') && !r.legacyCheck && r.old);
  const sum = (xs, f = 'expected') => Math.round(xs.reduce((s, r) => s + (Number(r[f]) || 0), 0) * 100) / 100;
  const buckets = ['Not due', '1-30', '31-60', '61-90', '90+'];
  const segs = [...new Set(open.map((r) => r.segment || 'Others'))].sort();
  const aging = segs.map((sg) => ({ segment: sg, ...Object.fromEntries(buckets.map((b) => [b, sum(open.filter((r) => (r.segment || 'Others') === sg && r.aging === b))])), total: sum(open.filter((r) => (r.segment || 'Others') === sg)) }));
  const DAY = 86400e3;
  const paidAmt = (xs) => Math.round(xs.reduce((t, e) => t + e.amount, 0) * 100) / 100;
  // Cash by week: rounds of a part-paid INV, and INVs that are paid (a closed / replaced INV is left out, as before).
  const inWeek = (end) => events.filter((e) => (e.round || e.r.paidWeekMs !== null) && ar.weekEnd(e.ms) === end);
  // Weeks run Friday to Thursday and stop at the month end (ar.weekEnd), the same as the Debt sheet.
  const cur = ar.weekEnd(today);
  const weeks = [];
  let end = cur;
  for (let i = 0; i < 10; i++) {
    const xs = open.filter((r) => r.planMs === end);
    const pd = inWeek(end);
    weeks.push({ weekEnd: ar.fmt(end), expected: sum(xs), count: xs.length, paid: paidAmt(pd), paidCount: pd.length });
    if (i < 9) end = ar.weekEnd(end + DAY);
  }
  const earlier = open.filter((r) => r.planMs !== null && r.planMs < cur);
  const later = open.filter((r) => r.planMs !== null && r.planMs > end);
  const cash = [];
  end = cur;
  for (let i = 0; i < 10; i++) {
    const xs = inWeek(end);
    cash.push({ weekEnd: ar.fmt(end), paid: paidAmt(xs), count: xs.length, current: i === 0 });
    end = ar.weekStart(end) - DAY;
  }
  // Checks the Debt sheet had: every open INV has a commit date, and none of those dates has passed.
  const noCommit = open.filter((r) => r.noCommit), needCommit = open.filter((r) => r.needCommit);
  const vs = all.filter((r) => r.paidMs !== null && r.paidMs >= today - 90 * DAY && r.paidVsCommit !== '');
  const months = [];
  const t = new Date(today);
  for (let i = 0; i < 12; i++) {
    const y = t.getUTCFullYear(), m = t.getUTCMonth() - i;
    const start = Date.UTC(y, m, 1), end = Date.UTC(y, m + 1, 1) - 1;
    const iss = all.filter((r) => r.issueMs !== null && r.issueMs >= start && r.issueMs <= end && r.state !== 'Closed');
    const paid = events.filter((e) => e.ms >= start && e.ms <= end);
    months.push({ month: ar.fmt(start).slice(3), invoiced: sum(iss, 'preVatN'), count: iss.length, cash: paidAmt(paid),
      bySegment: Object.fromEntries([...new Set(iss.map((r) => r.segment || 'Others'))].map((sg) => [sg, sum(iss.filter((r) => (r.segment || 'Others') === sg), 'preVatN')])) });
  }
  const recentPaid = all.filter((r) => r.paidMs !== null && r.paidMs >= today - 90 * DAY && r.cycleDays !== '');
  return {
    legacyCheck: sum(check), legacyCheckCount: check.length,
    old: sum(oldOpen), oldCount: oldOpen.length,
    open: sum(open), openCount: open.length, overdue: sum(open.filter((r) => r.state === 'Overdue')), overdueCount: open.filter((r) => r.state === 'Overdue').length,
    avgDaysToPay: recentPaid.length ? Math.round(recentPaid.reduce((s, r) => s + r.cycleDays, 0) / recentPaid.length) : 0,
    aging, buckets, forecast: { earlier: sum(earlier), earlierCount: earlier.length, weeks, later: sum(later), laterCount: later.length }, cash, months,
    checks: { noCommit: sum(noCommit), noCommitCount: noCommit.length, needCommit: sum(needCommit), needCommitCount: needCommit.length,
      awaitCash: sum(open.filter((r) => r.awaitCash)), awaitCashCount: open.filter((r) => r.awaitCash).length },
    vsCommit: { early: vs.filter((r) => r.paidVsCommit < 0).length, onTime: vs.filter((r) => r.paidVsCommit === 0).length, late: vs.filter((r) => r.paidVsCommit > 0).length },
  };
}

// The invoices behind one figure of the summary / dashboard (?drill=key), with the same rules as summarise().
function drillRows(all, today, key, events = cashEvents(all)) {
  const DAY = 86400e3;
  const open = all.filter((r) => (r.state === 'Outstanding' || r.state === 'Overdue') && !r.legacyCheck && !r.old);
  const [k, a = '', b = ''] = String(key).split('|');
  const seg = (r) => r.segment || 'Others';
  const month = (ms) => (ms === null ? '' : ar.fmt(ms).slice(3));
  const cur = ar.weekEnd(today);
  let last = cur; for (let i = 0; i < 9; i++) last = ar.weekEnd(last + DAY);
  let xs = [], paid = false, ev = null;
  if (k === 'open') xs = open;
  else if (k === 'overdue') xs = open.filter((r) => r.state === 'Overdue');
  else if (k === 'legacy') xs = all.filter((r) => r.legacyCheck);
  else if (k === 'old') xs = all.filter((r) => (r.state === 'Outstanding' || r.state === 'Overdue') && !r.legacyCheck && r.old);
  else if (k === 'nocommit') xs = open.filter((r) => r.noCommit);
  else if (k === 'needcommit') xs = open.filter((r) => r.needCommit);
  else if (k === 'await') xs = open.filter((r) => r.awaitCash);
  else if (k === 'fc') xs = open.filter((r) => r.planMs !== null && ar.fmt(r.planMs) === a);
  else if (k === 'fc-earlier') xs = open.filter((r) => r.planMs !== null && r.planMs < cur);
  else if (k === 'fc-later') xs = open.filter((r) => r.planMs !== null && r.planMs > last);
  else if (k === 'paid') { paid = true; ev = events.filter((e) => (e.round || e.r.paidWeekMs !== null) && ar.fmt(ar.weekEnd(e.ms)) === a); }
  else if (k === 'aging') xs = open.filter((r) => (!a || seg(r) === a) && (!b || r.aging === b));
  else if (k === 'month-inv') xs = all.filter((r) => r.issueMs !== null && month(r.issueMs) === a && r.state !== 'Closed' && (!b || seg(r) === b));
  else if (k === 'month-cash') { paid = true; ev = events.filter((e) => month(e.ms) === a); }
  else if (k === 'sales') xs = open.filter((r) => (r.salesName || r.salesEmail || '(ไม่ระบุ)') === a && (!b || r.state === 'Overdue'));
  else if (k === 'vs') { paid = true; xs = all.filter((r) => r.paidMs !== null && r.paidMs >= today - 90 * DAY && r.paidVsCommit !== '' && (a === 'early' ? r.paidVsCommit < 0 : a === 'late' ? r.paidVsCommit > 0 : r.paidVsCommit === 0)); }
  const preVat = k === 'month-inv';
  // Cash figures list one line per time money came in (a round of a part-paid INV is its own line).
  const rows = (ev ? ev.map((e) => ({ ...e.r, paidDate: ar.fmt(e.ms), paidAmount: e.amount, expected: e.amount, round: e.round ? 1 : 0 })) : xs).map((r) => ({ ivNo: r.ivNo, round: r.round || undefined, company: r.company, segment: r.segment, salesName: r.salesName || r.salesEmail || '', issueDate: r.issueDate, dueDate: r.dueDate,
    commitDate: r.state === 'Paid' ? r.promisedDate : r.commitDate, paidDate: r.paidDate, rtNo: r.rtNo || '', state: r.state, daysOverdue: r.daysOverdue, paidVsCommit: r.paidVsCommit, peakDocLink: r.peakDocLink || '',
    amount: preVat ? r.preVatN : paid ? (ar.num(r.paidAmount) || r.expected) : r.expected }))
    .sort((x, y) => y.amount - x.amount);
  return { rows, total: Math.round(rows.reduce((t, r) => t + (Number(r.amount) || 0), 0) * 100) / 100, basis: preVat ? 'prevat' : paid ? 'paid' : 'expected' };
}

async function arList(req, res, user) {
  if (!can(user, 'ar_view')) throw bad('ไม่มีสิทธิ์ดูหน้าติดตามหนี้', 403);
  // The home dashboard (?brief=1) may share a read for a few seconds; the work page always reads fresh.
  const lite = req.query.brief || req.query.drill;
  const rd = lite ? { cache: 20e3 } : {};
  const [rows, fus, ivreqs, pns, rts] = await Promise.all([hub.readTable('Invoices', rd), lite ? [] : hub.readTable('FollowUps'), lite ? [] : hub.readTable('InvoiceRequests').catch(() => []),
    hub.readTable('PaymentNotices', rd).catch(() => []), lite ? [] : hub.readTable('ReceiptRequests').catch(() => [])]);
  const today = ar.todayMs();
  // Rounds of money confirmed on each INV (an INV can be paid in several), and whether each has its own receipt.
  const rounds = new Map();
  for (const n of pns) {
    if (n.status !== 'confirmed') continue;
    const k = String(n.ivNo).toUpperCase(); if (!rounds.has(k)) rounds.set(k, []);
    const ms = ar.parseDate(n.paidDate);
    rounds.get(k).push({ noticeId: n.noticeId, paidDate: n.paidDate, week: ms === null ? '' : ar.fmt(ar.weekEnd(ms)), amount: ar.num(n.amount), by: n.source === 'sales' ? n.salesName : n.doneBy, note: n.note || '' });
  }
  // The rounds of an INV, when they add up to what the INV says was received: still open and part-paid, or paid in more than one round.
  const roundsOf = (r) => {
    const xs = rounds.get(String(r.ivNo).toUpperCase()) || []; if (!xs.length) return null;
    const sum = round2(xs.reduce((t, x) => t + x.amount, 0));
    if (r.partial) return Math.abs(sum - r.received) <= 0.01 ? xs : null;
    return r.state === 'Paid' && xs.length > 1 && Math.abs(sum - ar.num(r.paidAmount)) <= 0.01 ? xs : null;
  };
  for (const [k, xs] of rounds) {
    const live = rts.filter((x) => String(x.refDoc).toUpperCase() === k && !DEAD.has(x.status));
    const whole = live.some((x) => !rtRound(x));
    for (const x of xs) { const r = live.find((y) => (rtRound(y) || {}).id === x.noticeId); x.rt = r ? r.peakRtNo || 'Draft' : whole ? 'รวม' : ''; }
  }
  // Customer contact from the INV request, to prefill where the receipt goes.
  const contact = new Map(ivreqs.map((v) => [v.ivRequestId, { financeEmail: v.financeEmail || '', deliveryAddress: v.originalAddress || v.deliveryAddress || '' }]));
  const sees = await arSees(user);
  const mine = rows.filter((r) => r.ivNo && sees(r)).map((r) => ({ ...ar.enrich(r, today), preVatN: ar.num(r.preVat) }));
  // ?seg= narrows the summary to one customer group; ?brief=1 returns the summary only (home dashboard).
  const seg = text(req.query.seg, 20);
  const segments = [...new Set(mine.map((r) => r.segment || 'Others'))].sort();
  const all = seg ? mine.filter((r) => (r.segment || 'Others') === seg) : mine;
  const events = cashEvents(all, roundsOf);
  if (req.query.drill) return res.status(200).json({ ok: true, seg, ...drillRows(all, today, text(req.query.drill, 120), events) });
  if (req.query.brief) return res.status(200).json({ ok: true, summary: summarise(all, today, events), segments, seg });
  const byIv = new Map();
  for (const f of fus) { if (!byIv.has(f.ivNo)) byIv.set(f.ivNo, []); byIv.get(f.ivNo).push(f); }
  const keep = all.filter((r) => r.state === 'Outstanding' || r.state === 'Overdue' || (r.paidMs !== null && r.paidMs >= today - 120 * 86400e3) || (r.issueMs !== null && r.issueMs >= today - 120 * 86400e3));
  const out = keep.map(({ _row, issueMs, dueMs, paidMs, planMs, paidWeekMs, preVatN, ...r }) => ({ ...r, ...(contact.get(r.ivRequestId) || {}), followUps: (byIv.get(r.ivNo) || []).slice(-20).map(({ _row: x, ...f }) => f),
    // Only worth showing when the INV was (or is being) paid in more than one round.
    rounds: roundsOf(r) || undefined }));
  const canOwner = isOp(user) || can(user, 'team_view');
  const owners = canOwner ? (await users.list()).filter((u) => ['sales', 'lead'].includes(u.role)).map((u) => ({ email: u.email, name: u.name || u.email })) : [];
  res.status(200).json({ ok: true, peakLive: require('../lib/peak').mode() !== 'off', summary: summarise(all, today, events), segments, seg, invoices: out, total: all.length, canOwner, owners,
    lists: { docStatus: ar.DOC_STATUS, payMethods: ar.PAY_METHODS, channels: ar.CHANNELS, follow: ar.FOLLOW, delay: ar.DELAY } });
}

// Hand an INV (and the INV request sales see under "คำขอของฉัน") to another salesperson, e.g. when the
// original one left or an imported INV had no owner. Accounting / collectors, and sales leads for INVs they can see.
async function arOwner(req, res, user) {
  const b = req.body || {};
  if (!isOp(user) && !can(user, 'team_view')) throw bad('ไม่มีสิทธิ์เปลี่ยนเซลเจ้าของ', 403);
  const ivNo = text(b.ivNo, 40);
  const email = text(b.salesEmail, 120).toLowerCase();
  if (!/^[^\s@]+@globish\.co\.th$/.test(email)) throw bad('ใส่อีเมล @globish.co.th ของเซลคนใหม่');
  const [rows, ivreqs, people] = await Promise.all([hub.readTable('Invoices'), hub.readTable('InvoiceRequests'), users.list()]);
  const row = rows.find((x) => x.ivNo === ivNo);
  if (!row) throw bad('ไม่พบ INV นี้ใน AR', 404);
  if (!(await arSees(user))(row)) throw bad('INV นี้ไม่อยู่ในทีมของคุณ', 403);
  const p = people.find((u) => u.email.toLowerCase() === email);
  const name = (p && p.name) || text(b.salesName, 80) || email.split('@')[0];
  const at = hub.sheetDateTime();
  await hub.updateRow('Invoices', row._row, { salesEmail: email, salesName: name });
  const linked = ivreqs.filter((x) => (row.ivRequestId && x.ivRequestId === row.ivRequestId) || String(x.peakIvNo || '').toUpperCase() === String(ivNo).toUpperCase());
  for (const x of linked) await hub.updateRow('InvoiceRequests', x._row, { requestedBy: email, salesName: name, updatedAt: at });
  await hub.log('catalog', 'ar_owner', ivNo, `${user.email} · ${row.salesEmail || '-'} → ${email}`);
  res.status(200).json({ ok: true, salesEmail: email, salesName: name });
}

// "↻ อัปเดตจาก PEAK" on an AR row: read the INV (and its receipt) as they now are in PEAK and apply
// edits / voids / classification, the same as the webhook does. For when the webhook missed something.
// Read one INV (and its receipt) as they now are in PEAK and bring the AR row in line. Returns { changes, status }.
async function refreshFromPeak(ivNo) {
  const peak = require('../lib/peak');
  const row = (await hub.readTable('Invoices')).find((x) => x.ivNo === ivNo);
  if (!row) throw bad('ไม่พบ INV นี้ใน AR', 404);
  const ps = require('../lib/peaksync');
  let iv = row.peakIvId ? await peak.getInvoice(row.peakIvId) : await peak.findInvoiceByCode(row.ivNo);
  if (!iv) throw bad(`ไม่พบ ${row.ivNo} ใน PEAK`, 404);
  const pre = [];
  // Accounting voided the INV in PEAK and issued a new one under the same number: the row still points at the
  // voided document. Move it to the approved document that now carries the number.
  if (row.peakIvId && !ps.isApproved(iv)) {
    const live = await peak.findInvoiceByCode(row.ivNo);
    if (live && live.id !== iv.id && ps.isApproved(live)) {
      const at = hub.sheetDateTime();
      await hub.updateRow('Invoices', row._row, { peakIvId: live.id, peakDocLink: live.documentLink || row.peakDocLink, docStatus: 'Active',
        note: [row.note, `ออกใหม่ใน PEAK เลขเดิม เอกสารเดิมถูกยกเลิก (${at})`].filter(Boolean).join(' · ').slice(0, 500) });
      for (const x of (await hub.readTable('InvoiceRequests')).filter((v) => v.peakIvId === row.peakIvId)) {
        await hub.updateRow('InvoiceRequests', x._row, { peakIvId: live.id, peakDocLink: live.documentLink || x.peakDocLink, ...(x.status === 'iv_void' ? { status: 'iv_issued' } : {}), updatedAt: at });
      }
      pre.push('ออกใหม่ใน PEAK เลขเดิม: ย้ายไปใช้เอกสารใบที่อนุมัติอยู่');
      iv = live;
    } else if (!ps.isVoid(iv)) pre.push('INV นี้ใน PEAK ไม่ได้อยู่ในสถานะอนุมัติ (ถูกยกเลิกหรือดึงกลับเป็นร่าง) และไม่พบใบที่ออกใหม่เลขเดิม ตรวจใน PEAK');
  }
  const a = await ps.syncInvoice(iv, { classes: true });
  const changes = [...pre, ...((a && a.changes) || [])];
  if (a && a.classError) changes.push('อ่านกลุ่มจัดประเภทจาก PEAK ไม่ได้ (ลองใหม่ภายหลัง)');
  if (row.rtNo) {
    const rt = await peak.findReceiptByCode(row.rtNo).catch(() => null);
    if (rt) changes.push(...(((await ps.syncReceipt(rt, { classes: true })) || {}).changes || []));
  }
  return { changes, status: iv.status || '' };
}

// "↻ อัปเดตจาก PEAK" on an AR row: applies edits / voids / classification, the same as the webhook does.
async function arRefresh(req, res, user) {
  if (!isOp(user) && !can(user, 'approve')) throw bad('ไม่มีสิทธิ์', 403);
  if (require('../lib/peak').mode() === 'off') throw bad('ยังไม่ได้เปิดการเชื่อมต่อ PEAK API', 503);
  const ivNo = text((req.body || {}).ivNo, 40);
  const out = await refreshFromPeak(ivNo);
  await hub.log('catalog', 'ar_refresh', ivNo, `${user.email} · ${out.changes.join(', ') || 'no change'}`);
  res.status(200).json({ ok: true, ...out });
}

// Check open INVs against PEAK: read each one and say whether it is paid, still open, or no longer an approved
// document. Works for any INV still open in the app, and for "ข้อมูลเก่ารอตรวจ" (imported, nobody has checked).
// apply: true writes the paid result; for a waiting-for-check row it also writes the still-open result.
// Anything else is only reported, for accounting to decide.
async function arPeakCheck(req, res, user) {
  if (!isOp(user) && !can(user, 'approve')) throw bad('ไม่มีสิทธิ์', 403);
  const peak = require('../lib/peak'), ps = require('../lib/peaksync');
  if (peak.mode() === 'off') throw bad('ยังไม่ได้เปิดการเชื่อมต่อ PEAK API', 503);
  const b = req.body || {};
  const nos = (Array.isArray(b.ivNos) ? b.ivNos : []).map((x) => text(x, 40)).filter(Boolean).slice(0, 6);
  if (!nos.length) throw bad('ไม่มีรายการให้ตรวจ');
  const rows = await hub.readTable('Invoices');
  const [rtsAll, ivreqsAll] = b.apply ? await Promise.all([hub.readTable('ReceiptRequests').catch(() => []), hub.readTable('InvoiceRequests').catch(() => [])]) : [[], []];
  const at = hub.sheetDateTime(), today = ar.todayMs();
  const dmyOf = (ymd) => { const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(String(ymd || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
  const results = [];
  for (const ivNo of nos) {
    const row = rows.find((x) => x.ivNo === ivNo);
    const e = row ? ar.enrich(row, today) : null;
    const base = { ivNo, company: row ? row.company : '', expected: e ? e.expected : 0 };
    if (!row || !(e.state === 'Outstanding' || e.state === 'Overdue')) { results.push({ ...base, result: 'skip', text: 'ไม่ใช่รายการค้างชำระแล้ว' }); continue; }
    let iv = null;
    try { iv = await peak.findInvoiceByCode(ivNo); } catch (err) { results.push({ ...base, result: 'error', text: 'อ่านจาก PEAK ไม่ได้: ' + err.message }); continue; }
    if (!iv) { results.push({ ...base, result: 'notfound', text: 'ไม่พบเลขนี้ในใบแจ้งหนี้ของ PEAK' }); continue; }
    if (!ps.isApproved(iv)) { results.push({ ...base, result: 'void', text: 'ไม่พบใบที่อนุมัติอยู่ใน PEAK (ถูกยกเลิกหรือยังเป็นร่าง)', link: iv.documentLink || '' }); continue; }
    const pays = iv.paidPayments || [];
    const remain = ar.num(iv.remainAmount), net = ar.num(iv.netAmount);
    const link = { peakIvId: iv.id || row.peakIvId, peakDocLink: iv.documentLink || row.peakDocLink };
    const note = (t) => [row.note, `${t} (${at} · ${user.name || user.email})`].filter(Boolean).join(' · ').slice(0, 500);
    if (pays.length && remain <= 0.01) {
      const paidDate = dmyOf(pays.map((p) => p.paymentDate).filter(Boolean).sort().pop()) || '';
      const cash = round2(pays.reduce((t, p) => t + (p.payments || []).reduce((u, q) => u + ar.num(q.amount), 0), 0)) || round2(pays.reduce((t, p) => t + ar.num(p.paymentTotal), 0));
      if (!paidDate) { results.push({ ...base, result: 'error', text: 'PEAK ไม่มีวันที่รับเงิน ตรวจใน PEAK', link: link.peakDocLink }); continue; }
      // Paid long ago in PEAK usually means the receipt exists there too: take its number, so the INV does not
      // land in the "receipt to issue" queue.
      let rt = null;
      if (b.apply && !row.rtNo) rt = await peak.findReceiptForInvoice(ivNo).catch(() => null);
      const rtNo = rt ? { rtNo: String(rt.code).toUpperCase() } : {};
      if (rt && b.apply) await rtRowFromPeak({ ...row, paidDate }, rt, user, rtsAll, ivreqsAll);
      // A receipt dated ahead, or a cheque: PEAK's date is not the day the money came in. Keep the INV open as
      // "receipt issued, waiting for the money" until accounting confirms.
      const pp = ar.fromPeakPayment(row, { payDate: paidDate, cheque: await peak.isChequePayment(pays), today });
      if (pp.mode === 'await') {
        if (b.apply) await hub.updateRow('Invoices', row._row, { ...pp.fields, followStatus: e.legacyCheck ? '' : row.followStatus, ...link, ...rtNo, note: note(pp.why === 'cheque' ? 'PEAK ลงรับเป็นเช็ค รอยืนยันเงินเข้า' : 'PEAK ออกใบเสร็จล่วงหน้า รอยืนยันเงินเข้า') });
        results.push({ ...base, result: 'await', text: pp.why === 'cheque' ? 'PEAK ลงรับเงินเป็นเช็ค ยังไม่นับว่าจ่ายจนกว่าบัญชียืนยันวันเงินเข้า' : 'ใบเสร็จใน PEAK ลงวันที่ล่วงหน้า ยังไม่นับว่าจ่ายจนกว่าบัญชียืนยันเงินเข้า', paidDate, amount: cash, net, link: link.peakDocLink, rtNo: rt ? rt.code : '', applied: !!b.apply });
        continue;
      }
      if (b.apply) await hub.updateRow('Invoices', row._row, { ...pp.fields, paidAmount: cash, followStatus: '', ...link, ...rtNo, note: note('รับเงินตาม PEAK (ตรวจกับ PEAK)') });
      results.push({ ...base, result: 'paid', text: 'จ่ายแล้วใน PEAK', paidDate, amount: cash, net, link: link.peakDocLink, rtNo: rt ? rt.code : '', applied: !!b.apply });
    } else if (pays.length) {
      results.push({ ...base, result: 'partial', text: `รับเงินบางส่วนใน PEAK คงเหลือ ${remain}`, link: link.peakDocLink });
    } else if (remain <= 0.01 && net > 0.01) {
      // Nothing left to pay in PEAK but no payment on the INV itself: settled by another document (one receipt for
      // several INVs, a credit note). PEAK gives no paid date here, so accounting records the payment by hand.
      results.push({ ...base, result: 'settled', text: 'ยอดคงเหลือใน PEAK เป็น 0 แต่ไม่มีรายการรับเงินบนใบนี้ (มักรับผ่านใบเสร็จรวมหลายใบ หรือใบลดหนี้) ให้บัญชีบันทึกรับเงินพร้อมวันที่และเลขใบเสร็จ', amount: net, net, link: link.peakDocLink });
    } else if (!e.legacyCheck) {
      results.push({ ...base, result: 'open', text: 'ยังค้างชำระใน PEAK', amount: remain || net, net, link: link.peakDocLink, applied: false });
    } else {
      if (b.apply) await hub.updateRow('Invoices', row._row, { followStatus: '', commitDate: row.commitDate || e.dueDate, ...link, note: note('ตรวจกับ PEAK แล้ว ยังค้างชำระ') });
      results.push({ ...base, result: 'open', text: 'ยังค้างชำระใน PEAK', amount: remain || net, net, link: link.peakDocLink, applied: !!b.apply });
    }
  }
  if (b.apply) await hub.log('catalog', 'ar_peakcheck', nos.join(','), `${user.email} · ${results.map((r) => r.result).join(',')}`);
  res.status(200).json({ ok: true, results });
}

// A receipt that already exists in PEAK (issued there, not through the app) gets a ReceiptRequests row too, so the
// salesperson finds it under "คำขอของฉัน › ใบเสร็จ" like any receipt issued through the app.
async function rtRowFromPeak(a, rt, user, rts, ivreqs) {
  const ivNo = String(a.ivNo).toUpperCase();
  if ((rts || []).some((x) => String(x.refDoc).toUpperCase() === ivNo && !DEAD.has(x.status))) return false;
  const iv = (ivreqs || []).find((x) => x.ivRequestId === a.ivRequestId) || {};
  const at = hub.sheetDateTime(), no = String(rt.code).toUpperCase();
  await hub.appendRows('ReceiptRequests', [{ rtRequestId: shortId('RTREQ'), createdAt: at, requestedBy: iv.requestedBy || a.salesEmail || user.email, salesName: a.salesName || iv.salesName || '',
    segment: a.segment || 'B2B', docKind: RT_KIND.company, refDoc: ivNo, whStudent: '', billName: a.company, taxId: a.taxId, branch: a.branch || '00000', address: '', deliveryAddress: '', email: '',
    whtRate: String(Math.round(ar.num(a.whtRate) < 1 ? ar.num(a.whtRate) * 100 : ar.num(a.whtRate))), packages: a.keyHS || '', description: a.packageName || '', price: ar.num(a.preVat), discount: 0,
    paidDate: a.paidDate || '', paymentProof: '', deliveryChannel: '', docLang: 'TH', note: `ออกจาก INV ${ivNo}`, status: 'issued', peakRtNo: no, peakDocLink: rt.documentLink || '',
    sentStatus: 'sent', sentAt: at, trackingNo: '', accountNote: `ใบเสร็จออกใน PEAK ไว้แล้ว ระบบดึงเลขมาให้ — ${user.name || user.email}`, updatedAt: at, peakRtId: rt.id || '' }]);
  return true;
}

// Paid INVs with no receipt number in the app: look in PEAK for the receipt issued from each INV and
// record its number (receipts issued in PEAK before the app, or outside it). Nothing is created in PEAK.
async function rtFind(req, res, user) {
  if (!can(user, 'approve') && !isOp(user)) throw bad('ไม่มีสิทธิ์', 403);
  const peak = require('../lib/peak');
  if (peak.mode() === 'off') throw bad('ยังไม่ได้เปิดการเชื่อมต่อ PEAK API', 503);
  const nos = (Array.isArray((req.body || {}).ivNos) ? req.body.ivNos : []).map((x) => text(x, 40).toUpperCase()).filter(Boolean).slice(0, 6);
  if (!nos.length) throw bad('ไม่มีรายการให้ตรวจ');
  const [invs, rts, ivreqs] = await Promise.all([hub.readTable('Invoices'), hub.readTable('ReceiptRequests'), hub.readTable('InvoiceRequests').catch(() => [])]);
  const at = hub.sheetDateTime();
  const results = [];
  for (const ivNo of nos) {
    const a = invs.find((x) => String(x.ivNo).toUpperCase() === ivNo);
    if (!a || !a.paidDate || a.rtNo || rts.some((x) => String(x.refDoc).toUpperCase() === ivNo && !DEAD.has(x.status))) { results.push({ ivNo, result: 'skip' }); continue; }
    let rt = null;
    try { rt = await peak.findReceiptForInvoice(ivNo); } catch (e) { results.push({ ivNo, result: 'error', text: e.message }); continue; }
    if (!rt) { results.push({ ivNo, company: a.company, result: 'none' }); continue; }
    const no = String(rt.code).toUpperCase();
    await hub.updateRow('Invoices', a._row, { rtNo: no, note: [a.note, `ใบเสร็จ ${no} ออกใน PEAK ไว้แล้ว (${at})`].filter(Boolean).join(' · ').slice(0, 500) });
    await rtRowFromPeak(a, rt, user, rts, ivreqs);
    results.push({ ivNo, company: a.company, result: 'found', rtNo: no, link: rt.documentLink || '' });
  }
  await hub.log('catalog', 'rt_find', nos.join(','), `${user.email} · ${results.map((r) => r.result).join(',')}`);
  res.status(200).json({ ok: true, results });
}

async function arUpdate(req, res, user) {
  checkOrigin(req);
  if ((req.body || {}).action === 'ar_peakcheck') return arPeakCheck(req, res, user);
  if ((req.body || {}).action === 'ar_owner') return arOwner(req, res, user);
  if ((req.body || {}).action === 'ar_refresh') return arRefresh(req, res, user);
  if ((req.body || {}).action === 'ar_reclass') {
    if (!can(user, 'users')) throw bad('เฉพาะผู้ดูแลสิทธิ์', 403);
    const b = req.body || {};
    const out = await require('../lib/peaksync').reclassLegacy(b.kind === 'qt' ? 'qt' : 'inv', Math.max(0, Number(b.offset) || 0), Math.min(15, Math.max(1, Number(b.limit) || 10)));
    if (out.changed) await hub.log('catalog', 'legacy_reclass', b.kind || 'inv', `${user.email} · ${out.offset}+${out.done} changed ${out.changed}`);
    return res.status(200).json({ ok: true, ...out });
  }
  if (!isOp(user)) throw bad('ไม่มีสิทธิ์บันทึกติดตามหนี้', 403);
  const b = req.body || {};
  const ivNo = text(b.ivNo, 40);
  const rows = await hub.readTable('Invoices');
  const row = rows.find((x) => x.ivNo === ivNo);
  if (!row) throw bad('ไม่พบ INV นี้ใน AR', 404);
  const at = hub.sheetDateTime();
  const who = user.name || user.email;
  const dateIn = (v, label) => { const s = text(v, 10); if (!s) return ''; const d = dmy(s) || s; if (!ar.parseDate(d)) throw bad(`${label} ไม่ถูกต้อง`); return d; };
  if (b.action === 'ar_followup') {
    const channel = text(b.channel, 30);
    if (!ar.CHANNELS.includes(channel)) throw bad('เลือกช่องทางติดตาม');
    const result = text(b.result, 80);
    if (!result) throw bad('เลือกผลการติดตาม');
    const next = dateIn(b.nextActionDate, 'วันที่ติดตามครั้งถัดไป');
    const note = text(b.note, 500);
    const commit = dateIn(b.commitDate, 'วันนัดจ่าย');
    // An open INV always carries a commit date that has not passed: it is what the cash forecast runs on.
    const e = ar.enrich(row);
    if (e.state === 'Outstanding' || e.state === 'Overdue') {
      const c = ar.parseDate(commit || row.commitDate);
      if (c === null) throw bad('ใส่วันที่ลูกค้านัดจ่าย ถ้ายังไม่ทราบให้ใส่วันที่คาดว่าจะจ่าย');
      if (c < ar.todayMs()) throw bad('วันนัดจ่ายเลยมาแล้ว ใส่วันนัดใหม่ ถ้ายังไม่ทราบให้ใส่วันที่คาดว่าจะจ่าย');
    }
    await hub.appendRows('FollowUps', [{ loggedAt: at, ivNo, channel, by: who, result, nextActionDate: next, note, commitDate: commit || row.commitDate || '' }]);
    const f = { followStatus: result, nextActionDate: next };
    if (commit) f.commitDate = commit;
    await hub.updateRow('Invoices', row._row, f);
    await hub.log('catalog', 'ar_followup', ivNo, `${user.email} · ${channel} · ${result}`);
    return res.status(200).json({ ok: true });
  }
  if (b.action === 'ar_update') {
    const f = {};
    if ('commitDate' in b) { f.commitDate = dateIn(b.commitDate, 'วันนัดจ่าย'); if (!f.commitDate) throw bad('ต้องมีวันนัดจ่ายเสมอ ถ้ายังไม่ทราบให้ใส่วันครบกำหนด'); }
    if ('paidDate' in b) f.paidDate = dateIn(b.paidDate, 'วันที่เงินเข้า');
    // Date Paid is the day the money reached the bank, so it cannot be ahead of today.
    if (f.paidDate && ar.parseDate(f.paidDate) > ar.todayMs()) throw bad('วันที่เงินเข้าเป็นวันในอนาคตไม่ได้ ถ้าออกใบเสร็จล่วงหน้าหรือรับเช็คมาแล้ว ให้ใส่ "วันที่ใบเสร็จ / วันรับเช็ค" และวันนัดจ่าย แล้วค่อยยืนยันเมื่อเงินเข้าจริง');
    if ('rtDate' in b) f.rtDate = dateIn(b.rtDate, 'วันที่ใบเสร็จ / วันรับเช็ค');
    if (f.paidDate) Object.assign(f, ar.onPaid(row, f.paidDate));
    else if ('paidDate' in b && row.paidDate) Object.assign(f, { commitDate: row.commitAtPaid || row.commitDate, commitAtPaid: '' });
    if ('paidAmount' in b) { const n = b.paidAmount === '' ? '' : Number(String(b.paidAmount).replace(/,/g, '')); if (n !== '' && !(n > 0)) throw bad('ยอดรับเงินไม่ถูกต้อง'); f.paidAmount = n; }
    if ('paymentMethod' in b) { const m = text(b.paymentMethod, 40); if (m && !ar.PAY_METHODS.includes(m)) throw bad('วิธีชำระเงินไม่ถูกต้อง'); f.paymentMethod = m; }
    if ('rtNo' in b) { f.rtNo = text(b.rtNo, 40).toUpperCase(); if (f.rtNo && f.rtNo !== String(row.rtNo || '').toUpperCase()) await assertDoc('RT', { no: f.rtNo, ref: 'paid:' + row.ivNo, taxId: row.taxId }); }
    if ('whtRate' in b) { const w = ar.whtIn(b.whtRate); if (w !== null && Number(w) !== ar.whtPct(row)) f.whtRate = String(Number(w) / 100); }
    if ('delayReason' in b) f.delayReason = text(b.delayReason, 200);
    if ('docStatus' in b) { const d = text(b.docStatus, 20); if (!ar.DOC_STATUS.includes(d)) throw bad('สถานะเอกสารไม่ถูกต้อง'); f.docStatus = d; }
    if ('note' in b) f.note = text(b.note, 500);
    const got = ar.enrich(row, ar.todayMs()).received, thisRound = typeof f.paidAmount === 'number' ? f.paidAmount : 0;
    if (b.partial === true) {
      // One round of several: the INV stays open, the amount is added to what was received, and the round is kept in PaymentNotices.
      if (row.paidDate) throw bad('INV นี้บันทึกรับเงินครบแล้ว', 409);
      if (!f.paidDate || !(thisRound > 0)) throw bad('ใส่วันที่เงินเข้าและยอดที่ได้รับของรอบนี้');
      const method = f.paymentMethod || row.paymentMethod; if (!method) throw bad('เลือกวิธีชำระเงิน');
      if (!b.file) throw bad('แนบสลิป / หลักฐานการรับเงิน');
      const full = ar.expectedAt(row, f.whtRate ? Number(f.whtRate) * 100 : ar.whtPct(row)), total = round2(got + thisRound);
      if (total >= full - 1) throw bad('ยอดรับครบแล้ว เลือก "รับครบแล้ว ปิด INV"');
      const slip = await drive.upload(b.file, { kind: 'payment', docNo: row.ivNo, company: row.company, ref: row.ivNo });
      await hub.updateRow('Invoices', row._row, { paidAmount: total, paymentMethod: method, ...(f.whtRate ? { whtRate: f.whtRate } : {}),
        note: [row.note, `รับเงินบางส่วน ${money(thisRound)} (${f.paidDate}) บันทึกโดย ${user.name || user.email}`].filter(Boolean).join(' · ').slice(-500) });
      const at = hub.sheetDateTime(), who = user.name || user.email, nid = shortId('PAY');
      await hub.appendRows('PaymentNotices', [{ noticeId: nid, createdAt: at, requestedBy: user.email, salesName: who, ivRequestId: row.ivRequestId || '', ivNo: String(row.ivNo).toUpperCase(),
        company: row.company, paidDate: f.paidDate, amount: thisRound, paymentMethod: method, slipLink: slip, deliveryChannel: '', email: '', deliveryAddress: '', note: text(b.payNote, 500),
        status: 'confirmed', source: 'accounting', accountNote: 'ลูกค้าแจ้งฝ่ายบัญชีโดยตรง (รับบางส่วน)', doneBy: who, updatedAt: at }]);
      await Promise.all([hub.log('catalog', 'ar_partial', ivNo, `${user.email} · ${thisRound} · เหลือ ${round2(full - total)}`),
        attachToPeak('invoice', row.peakIvId, b.file, `PAYMENT_${row.ivNo}`),
        notify.chat(`💰 บัญชีบันทึกรับเงินบางส่วน ${ivNo} · ${notify.co(row.company)} · รับแล้ว ${money(total)} จาก ${money(full)} (เหลือ ${money(round2(full - total))})${row.salesEmail ? ' · ' + await notify.at(row.salesEmail, row.salesName) : ''}`)]);
      return res.status(200).json({ ok: true, partial: true, received: total, remaining: round2(full - total), noticeId: nid });
    }
    // Closing an INV that was paid in part before: the amount typed is this round; the INV keeps the total.
    if (f.paidDate && !row.paidDate && got > 0 && thisRound > 0) f.paidAmount = round2(got + thisRound);
    if (f.paidDate && !(f.paidAmount || ar.num(row.paidAmount))) throw bad('ใส่ยอดเงินที่ได้รับ');
    if (f.paidDate && !(f.paymentMethod || row.paymentMethod)) throw bad('เลือกวิธีชำระเงิน');
    if (!Object.keys(f).length) throw bad('ไม่มีข้อมูลที่จะบันทึก');
    const newlyPaid = !!f.paidDate && !row.paidDate;
    // Receipt delivery for a new payment: checked before anything is saved.
    let delivery = null;
    // The receipt is already out (issued ahead / cheque): confirming the money needs no delivery choice.
    if (newlyPaid && row.rtNo) { if (!b.file) throw bad('แนบสลิป / หลักฐานเงินเข้า'); delivery = { deliveryChannel: '', email: '', deliveryAddress: '', note: text(b.payNote, 500) || 'ยืนยันเงินเข้า (ออกใบเสร็จไว้ก่อนแล้ว)' }; }
    else if (newlyPaid) {
      if (!b.file) throw bad('แนบสลิป / หลักฐานการรับเงิน');
      const ch = text(b.deliveryChannel, 20) || 'sales';
      if (!PAY_CHANNELS.includes(ch)) throw bad('เลือกช่องทางส่งใบเสร็จ');
      const email = text(b.email, 120), addr = text(b.deliveryAddress, 600);
      if (needsEmail(ch) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('ใส่อีเมลลูกค้าสำหรับส่งใบเสร็จ');
      if (needsPost(ch) && !addr) throw bad('ใส่ที่อยู่ส่งใบเสร็จตัวจริง');
      delivery = { deliveryChannel: ch, email, deliveryAddress: addr, note: text(b.payNote, 500) };
    }
    // Slip is required for a new payment, the same as a Sales notice.
    const slip = newlyPaid && b.file ? await drive.upload(b.file, { kind: 'payment', docNo: row.ivNo, company: row.company, ref: row.ivNo }) : '';
    await hub.updateRow('Invoices', row._row, f);
    await hub.log('catalog', 'ar_update', ivNo, `${user.email} · ${Object.keys(f).join(',')}`);
    if (newlyPaid) {
      await paidDirectly(row, { ...f, paidAmount: thisRound || f.paidAmount }, slip, user, delivery);
      await attachToPeak('invoice', row.peakIvId, b.file, `PAYMENT_${row.ivNo}`);
    }
    return res.status(200).json({ ok: true });
  }
  throw bad('คำสั่งไม่ถูกต้อง');
}

// ---------------------------------------------------------------- payment notices (เงินเข้า)
// Two ways accounting learns a customer paid an INV:
//   1. customer → Sales → "แจ้งบัญชีว่าลูกค้าจ่ายแล้ว" (slip required) → accounting / collector confirms against the bank
//   2. customer → accounting directly → "บันทึกรับเงิน" on /ar (slip required too)
// Both end in Invoices paidDate/paidAmount/paymentMethod, then the RT queue. An INV is paid once (no instalments).
const canConfirmPay = (u) => can(u, 'approve') || can(u, 'ar');
const PAY_CHANNELS = ['sales', 'email', 'post', 'email_post'];

async function createPayNotice(req, res, user) {
  checkOrigin(req);
  if (!can(user, 'request')) throw bad('ไม่มีสิทธิ์', 403);
  const b = req.body || {};
  const [ivreqs, invs, notices] = await Promise.all([hub.readTable('InvoiceRequests'), hub.readTable('Invoices'), hub.readTable('PaymentNotices')]);
  const iv = ivreqs.find((x) => x.ivRequestId === text(b.ivRequestId, 60));
  const sees = await visibility(user);
  if (!iv || !sees(iv.requestedBy)) throw bad('ไม่พบ INV นี้', 404);
  if (iv.status !== 'iv_issued' || !iv.peakIvNo) throw bad('INV นี้ยังไม่ได้ออก แจ้งจ่ายได้หลังฝ่ายบัญชีออก INV แล้ว', 409);
  const ivNo = String(iv.peakIvNo).toUpperCase();
  const a = invs.find((x) => x.ivRequestId === iv.ivRequestId) || invs.find((x) => String(x.ivNo).toUpperCase() === ivNo);
  if (!a) throw bad('INV นี้ยังไม่อยู่ในหน้าติดตามหนี้ รอระบบอัปเดตแล้วลองใหม่ หรือแจ้งฝ่ายบัญชี', 409);
  if (a.docStatus === 'Cancelled' || a.docStatus === 'Replaced') throw bad('INV นี้ถูกยกเลิก / เปลี่ยนเอกสารแล้ว', 409);
  if (a.paidDate) throw bad(`ฝ่ายบัญชีบันทึกรับเงิน INV นี้แล้ว (${a.paidDate})`, 409);
  const paidDate = dmy(text(b.paidDate, 10));
  if (!paidDate || !ar.parseDate(paidDate)) throw bad('ใส่วันที่ลูกค้าโอน');
  if (ar.parseDate(paidDate) > ar.todayMs() + 86400e3) throw bad('วันที่โอนอยู่ในอนาคต');
  const amount = Number(String(b.amount ?? '').replace(/,/g, ''));
  if (!(amount > 0 && amount < 1e9)) throw bad('ใส่ยอดที่ลูกค้าโอน');
  // An INV can be paid in several rounds, each reported on its own. The same round reported twice is refused.
  const same = notices.find((x) => String(x.ivNo).toUpperCase() === ivNo && x.status === 'new' && x.paidDate === paidDate && Math.abs(ar.num(x.amount) - amount) < 0.01);
  if (same) throw bad(`แจ้งจ่ายรอบนี้ไปแล้ว (${money(amount)} บาท วันที่ ${paidDate}) รอฝ่ายบัญชีตรวจ (${same.noticeId})`, 409);
  const method = text(b.paymentMethod, 40);
  if (!ar.PAY_METHODS.includes(method)) throw bad('เลือกวิธีชำระเงิน');
  // Paid through Whitehouse (B2C / B2E): the WH order and the receipt WH already issued, so accounting can
  // reconcile. With either of them the slip is optional (the WH record is the evidence).
  const whOrder = text(b.whOrderId, 60), whRt = text(b.whReceiptNo, 60);
  // Paid through WH means both are known: the order and the receipt WH issued for it.
  if (b.viaWh === true || whOrder || whRt) { if (!whOrder || !whRt) throw bad('จ่ายผ่าน Whitehouse ต้องใส่ทั้ง Order ID และเลขใบเสร็จที่ WH ออก'); }
  else if (!b.file) throw bad('แนบสลิป / หลักฐานการโอน (ถ้าลูกค้าจ่ายผ่าน Whitehouse ให้เลือก "จ่ายผ่าน Whitehouse" แล้วใส่ Order ID และเลขใบเสร็จของ WH)');
  const ch = text(b.deliveryChannel, 20);
  if (!PAY_CHANNELS.includes(ch)) throw bad('เลือกช่องทางส่งใบเสร็จ');
  const email = text(b.email, 120), addr = text(b.deliveryAddress, 600);
  if (needsEmail(ch) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('ใส่อีเมลลูกค้าสำหรับส่งใบเสร็จ');
  if (needsPost(ch) && !addr) throw bad('ใส่ที่อยู่ส่งใบเสร็จตัวจริง');
  const id = shortId('PAY');
  const slip = b.file ? await drive.upload(b.file, { kind: 'payment', docNo: ivNo, company: a.company, ref: id }) : '';
  const whRef = [whOrder && `Order ${whOrder}`, whRt && `ใบเสร็จ WH ${whRt}`].filter(Boolean).join(' · ');
  // The customer withheld tax at a rate the INV does not carry: Sales says so, accounting confirms it (and only then is the INV changed).
  const wht = ar.whtIn(b.whtRate);
  const whtNote = wht !== null && Number(wht) !== ar.whtPct(a) ? (wht === '0' ? 'ลูกค้าไม่หัก ณ ที่จ่าย' : `หัก ณ ที่จ่าย ${wht}%`) : '';
  const at = hub.sheetDateTime();
  await hub.appendRows('PaymentNotices', [{ noticeId: id, createdAt: at, requestedBy: user.email, salesName: user.name, ivRequestId: iv.ivRequestId, ivNo,
    company: a.company, paidDate, amount: round2(amount), paymentMethod: method, slipLink: slip, deliveryChannel: ch, email, deliveryAddress: addr,
    note: [whRef && `จ่ายผ่าน WH · ${whRef}`, whtNote, text(b.note, 500)].filter(Boolean).join(' · ').slice(0, 700), status: 'new', source: 'sales', accountNote: '', doneBy: '', updatedAt: at }]);
  // What is still owed on the INV (less the rounds confirmed so far, and the other rounds waiting for accounting).
  const en = ar.enrich(a, ar.todayMs());
  const waiting = notices.filter((x) => String(x.ivNo).toUpperCase() === ivNo && x.status === 'new').reduce((t, x) => t + ar.num(x.amount), 0);
  const exp = round2((wht !== null ? ar.expectedAt(a, wht) : en.expectedFull) - en.received - waiting);
  await Promise.all([hub.log('catalog', 'pay_notice', id, `${user.email} · ${ivNo} · ${amount}`),
    notify.chat(`💰 แจ้งลูกค้าจ่าย ${ivNo} · ${notify.co(a.company)} · ${money(amount)} บาท${amount < exp - 1 ? ` · จ่ายบางส่วน (ยังเหลือ ${money(round2(exp - amount))})` : amount > exp + 1 ? ' · ⚠️ ยอดเกินที่ค้าง' : ''}${whRef ? ` · จ่ายผ่าน WH: ${whRef.replace(' · ', ', ')}` : ''} · ${user.name || user.email} · ${notify.link('ar', 'ตรวจและยืนยัน', { q: ivNo })}`)]);
  res.status(200).json({ ok: true, noticeId: id, message: 'แจ้งฝ่ายบัญชีแล้ว รอตรวจเงินเข้า' });
}

async function updatePayNotice(req, res, user) {
  checkOrigin(req);
  if (!canConfirmPay(user)) throw bad('ไม่มีสิทธิ์ยืนยันเงินเข้า', 403);
  const b = req.body || {};
  const row = (await hub.readTable('PaymentNotices')).find((x) => x.noticeId === text(b.noticeId, 40));
  if (!row) throw bad('ไม่พบรายการนี้', 404);
  if (row.status !== 'new') throw bad(`รายการนี้${row.status === 'confirmed' ? 'ยืนยันแล้ว' : row.status === 'matched' ? 'ปิดแล้ว (บันทึกรับเงินไปแล้ว)' : 'ตีกลับแล้ว'} รีเฟรชหน้า`, 409);
  const at = hub.sheetDateTime(), who = user.name || user.email, note = text(b.note, 500);
  if (b.action === 'pay_reject') {
    if (!note) throw bad('ใส่เหตุผล เช่น ยังไม่เห็นเงินเข้าบัญชี');
    await hub.updateRow('PaymentNotices', row._row, { status: 'rejected', accountNote: note, doneBy: who, updatedAt: at });
    await Promise.all([hub.log('catalog', 'pay_reject', row.noticeId, `${user.email} · ${note}`),
      notify.chat(`↩️ ยังไม่ยืนยันเงินเข้า ${row.ivNo} · ${notify.co(row.company)} · ${await notify.at(row.requestedBy, row.salesName)} · ${notify.link('mine', undefined, { t: 'inv', q: row.ivNo })}\nเหตุผล: ${notify.why(note)}`)]);
    return res.status(200).json({ ok: true });
  }
  if (b.action !== 'pay_confirm') throw bad('คำสั่งไม่ถูกต้อง');
  const invs = await hub.readTable('Invoices');
  const a = invs.find((x) => x.ivRequestId === row.ivRequestId) || invs.find((x) => String(x.ivNo).toUpperCase() === String(row.ivNo).toUpperCase());
  if (!a) throw bad('ไม่พบ INV นี้ในหน้าติดตามหนี้', 404);
  if (a.paidDate) {
    await hub.updateRow('PaymentNotices', row._row, { status: 'matched', accountNote: `บันทึกรับเงินไว้แล้ว ${a.paidDate}`, doneBy: who, updatedAt: at });
    return res.status(200).json({ ok: true, matched: true });
  }
  // Accounting may correct the date / amount after checking the bank statement.
  const paidDate = b.paidDate ? dmy(text(b.paidDate, 10)) : row.paidDate;
  if (!ar.parseDate(paidDate)) throw bad('วันที่รับเงินไม่ถูกต้อง');
  if (ar.parseDate(paidDate) > ar.todayMs()) throw bad('วันที่เงินเข้าเป็นวันในอนาคตไม่ได้');
  const amount = b.amount !== undefined && b.amount !== '' ? Number(String(b.amount).replace(/,/g, '')) : ar.num(row.amount);
  if (!(amount > 0)) throw bad('ยอดรับเงินไม่ถูกต้อง');
  const wht = ar.whtIn(b.whtRate), whtNew = wht !== null && Number(wht) !== ar.whtPct(a);
  // Rounds: what was confirmed before plus this one. The INV closes when the whole amount is in (or accounting says
  // this round closes it); until then it stays open with the rest still owed.
  const got = ar.enrich(a, ar.todayMs()).received, total = round2(got + amount);
  const full = ar.expectedAt(a, wht !== null ? wht : ar.whtPct(a));
  const close = b.close === undefined ? total >= full - 1 : b.close === true;
  const rest = close ? 0 : round2(full - total);
  if (!close && rest <= 0) throw bad('ยอดรับครบแล้ว เลือก "รับครบแล้ว ปิด INV"');
  await hub.updateRow('Invoices', a._row, { ...(close ? { paidDate, ...ar.onPaid(a, paidDate) } : {}), paidAmount: total, paymentMethod: row.paymentMethod, ...(whtNew ? { whtRate: String(Number(wht) / 100) } : {}),
    note: [a.note, `${close ? 'รับเงิน' : 'รับเงินบางส่วน'}ตามที่ ${row.salesName || row.requestedBy} แจ้ง (${row.noticeId} · ${money(amount)}) ยืนยันโดย ${who}`].filter(Boolean).join(' · ').slice(-500) });
  await hub.updateRow('PaymentNotices', row._row, { status: 'confirmed', paidDate, amount: round2(amount), accountNote: note, doneBy: who, updatedAt: at });
  if (a.peakIvId && require('../lib/peak').mode() !== 'off') {
    const slipFile = await drive.download(row.slipLink).catch(() => null);
    if (slipFile) await attachToPeak('invoice', a.peakIvId, slipFile, `PAYMENT_${row.ivNo}`);
  }
  await Promise.all([hub.log('catalog', 'pay_confirm', row.noticeId, `${user.email} · ${row.ivNo} · ${amount}${close ? '' : ` · บางส่วน เหลือ ${rest}`}${whtNew ? ` · หัก ณ ที่จ่าย ${ar.whtPct(a)}% → ${wht}%` : ''}`),
    notify.chat(`✅ ยืนยันเงินเข้า ${row.ivNo} · ${notify.co(row.company)}${close ? '' : ` · รับแล้ว ${money(total)} จาก ${money(full)} (เหลือ ${money(rest)})`} · ${await notify.at(row.requestedBy, row.salesName)}`)]);
  res.status(200).json({ ok: true, partial: !close, received: total, remaining: rest, noticeId: row.noticeId });
}

// Accounting recorded the payment on /ar (customer told them directly): close any Sales notice for
// that INV, keep one PaymentNotices row as the record (with the slip if attached), and tell Sales.
async function paidDirectly(row, f, slip, user, d = {}) {
  const notices = await hub.readTable('PaymentNotices');
  const ivNo = String(row.ivNo).toUpperCase(), at = hub.sheetDateTime(), who = user.name || user.email;
  for (const n of notices.filter((x) => String(x.ivNo).toUpperCase() === ivNo && x.status === 'new')) {
    await hub.updateRow('PaymentNotices', n._row, { status: 'matched', accountNote: `บัญชีบันทึกรับเงินจากหน้าติดตามหนี้แล้ว (${f.paidDate})`, doneBy: who, updatedAt: at });
  }
  await hub.appendRows('PaymentNotices', [{ noticeId: shortId('PAY'), createdAt: at, requestedBy: user.email, salesName: who, ivRequestId: row.ivRequestId || '', ivNo,
    company: row.company, paidDate: f.paidDate, amount: f.paidAmount || row.paidAmount, paymentMethod: f.paymentMethod || row.paymentMethod, slipLink: slip,
    deliveryChannel: d.deliveryChannel || '', email: d.email || '', deliveryAddress: d.deliveryAddress || '', note: d.note || '', status: 'confirmed', source: 'accounting', accountNote: 'ลูกค้าแจ้งฝ่ายบัญชีโดยตรง', doneBy: who, updatedAt: at }]);
  await notify.chat(`💰 บัญชีบันทึกรับเงิน ${ivNo} · ${notify.co(row.company)}${row.salesEmail ? ' · ' + await notify.at(row.salesEmail, row.salesName) : ''}`);
}

async function listPayNotices(req, res, user) {
  if (!canConfirmPay(user)) throw bad('ไม่มีสิทธิ์', 403);
  const rows = await hub.readTable('PaymentNotices');
  if (req.query && req.query.count) return res.status(200).json({ ok: true, open: rows.filter((r) => r.status === 'new').length });
  res.status(200).json({ ok: true, notices: rows.filter((r) => r.source === 'sales').reverse().slice(0, 150).map(({ _row, ...r }) => r) });
}

// ---------------------------------------------------------------- receipts (ใบเสร็จ / ใบกำกับภาษี)
const RT_SEGMENTS = ['B2C', 'B2E', 'MaoMao', 'B2B', 'B2S', 'Others'];
const RT_KIND = { company: 'ใบเสร็จ/ใบกำกับภาษี ในนามบริษัท', person: 'ใบเสร็จ/ใบกำกับภาษี ในนามบุคคล' };
const RT_CHANNEL = { email: 'ส่งอีเมลลูกค้า', sales: 'ส่งไฟล์ให้ Sales', post: 'ส่งตัวจริงตามที่อยู่', email_post: 'ส่งอีเมลและส่งตัวจริง' };
const needsPost = (c) => c === 'post' || c === 'email_post';
const needsEmail = (c) => c === 'email' || c === 'email_post';
const shortId = (p) => { const t = new Date(Date.now() + 7 * 3600e3); const z = (x) => String(x).padStart(2, '0'); return `${p}-${String(t.getUTCFullYear()).slice(2)}${z(t.getUTCMonth() + 1)}${z(t.getUTCDate())}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; };

// Receipts already issued for the same customer, the same amount and the same payment date as a receipt request:
// most likely the same money (e.g. Sales ask for a receipt that accounting already issued from the INV).
// r: { taxId, price, discount, paidDate (dd/mm/yyyy), rtRequestId? }
function rtTwins(r, rows, invs) {
  const tax = String(r.taxId || '').replace(/\D/g, ''), net = round2(ar.num(r.price) - ar.num(r.discount)), day = ar.parseDate(r.paidDate);
  if (!tax || !(net > 0) || day === null) return [];
  const out = [], seen = new Set();
  const add = (rtNo, ivNo, src) => { const k = String(rtNo).toUpperCase(); if (rtNo && !seen.has(k)) { seen.add(k); out.push({ rtNo, ivNo: /^IV-/i.test(ivNo || '') ? ivNo : '', paidDate: r.paidDate, amount: net, src }); } };
  for (const x of rows) {
    if (x.rtRequestId === r.rtRequestId || x.status !== 'issued' || !x.peakRtNo) continue;
    if (String(x.taxId || '').replace(/\D/g, '') === tax && Math.abs(round2(ar.num(x.price) - ar.num(x.discount)) - net) < 0.01 && ar.parseDate(x.paidDate) === day) add(x.peakRtNo, x.refDoc, 'rt');
  }
  for (const a of invs) {
    if (!a.rtNo || a.docStatus === 'Cancelled' || a.docStatus === 'Replaced') continue;
    if (String(a.taxId || '').replace(/\D/g, '') === tax && Math.abs(ar.num(a.preVat) - net) < 0.01 && ar.parseDate(a.paidDate) === day) String(a.rtNo).split(/\s*,\s*/).forEach((no) => add(no, a.ivNo, 'inv'));
  }
  return out.slice(0, 5);
}

async function createReceipt(req, res, user) {
  checkOrigin(req);
  if (!can(user, 'request')) throw bad('ไม่มีสิทธิ์ขอเอกสาร', 403);
  const b = req.body || {};
  const r = {
    segment: text(b.segment, 20), docKind: text(b.docKind, 20), refDoc: text(b.refDoc, 120), whStudent: text(b.whStudent, 200),
    billName: text(b.billName, 200), taxId: text(b.taxId, 20).replace(/[\s-]/g, ''), branch: text(b.branch, 20),
    address: text(b.address, 600), deliveryAddress: text(b.deliveryAddress, 600), email: text(b.email, 120),
    whtRate: String(b.whtRate ?? '').trim(), packages: text(b.packages, 300), description: text(b.description, 1500),
    price: num(b.price), discount: num(b.discount) || 0, paidDate: text(b.paidDate, 10), deliveryChannel: text(b.deliveryChannel, 20),
    docLang: text(b.docLang, 2).toUpperCase() || 'TH', note: text(b.note, 1000),
  };
  // Customer type (PEAK G012) + other PEAK classification picked on the form (e.g. Business Unit).
  const ctype = await require('../lib/types').resolve(b.customerType || b.segment);
  r.segment = ctype.name;
  const picks = { ...(await require('../lib/classrules').cleanPicks(b.classPicks, await hub.readTable('Users').catch(() => [])) || {}), G012: ctype.code };
  r.classPicks = JSON.stringify(picks);
  const whStudentNeeded = ctype.kinds.includes('service') && !ctype.prefix; // WH packages (B2C)
  if (!RT_KIND[r.docKind]) throw bad('เลือกประเภทเอกสาร (ในนามบริษัท / ในนามบุคคล)');
  if (!r.billName) throw bad('ใส่ชื่อที่จะออกในเอกสาร');
  if (!/^\d{13}$/.test(r.taxId)) throw bad(r.docKind === 'person' ? 'ใส่เลขบัตรประชาชน 13 หลักของผู้ที่ออกในนาม' : 'ใส่เลขประจำตัวผู้เสียภาษี 13 หลัก');
  const br = r.docKind === 'person' ? '00000' : normBranch(r.branch);
  if (br === null) throw bad('สาขาต้องเป็นรหัส 5 หลัก เช่น 00000');
  r.branch = br;
  if (!r.address) throw bad('ใส่ที่อยู่ตามที่จะออกในเอกสาร');
  if (whStudentNeeded && !r.whStudent) throw bad('ใส่ชื่อ / ID ผู้เรียนใน Whitehouse');
  if (whStudentNeeded && !r.packages) throw bad('ใส่ Package ID / รหัสคอร์ส');
  if (!r.packages && !r.description) throw bad('ใส่ชื่อคอร์ส / รายละเอียดที่ให้ขึ้นในเอกสาร');
  if (!(r.price > 0 && r.price < 1e9)) throw bad('ใส่ราคาขาย (ก่อนหักส่วนลด)');
  if (!(r.discount >= 0 && r.discount < r.price)) throw bad('ส่วนลดไม่ถูกต้อง');
  if (!['0', '1', '2', '3', '5'].includes(r.whtRate)) throw bad('เลือกหัก ณ ที่จ่าย');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.paidDate)) throw bad('ใส่วันที่ลูกค้าชำระเงิน');
  if (!RT_CHANNEL[r.deliveryChannel]) throw bad('เลือกช่องทางส่งเอกสาร');
  if (needsEmail(r.deliveryChannel) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) throw bad('ใส่อีเมลลูกค้าสำหรับส่งเอกสาร');
  if (needsPost(r.deliveryChannel) && !(r.deliveryAddress || r.address)) throw bad('ใส่ที่อยู่จัดส่ง');
  if (!['TH', 'EN'].includes(r.docLang)) throw bad('เลือกภาษาเอกสาร');
  const rows = await hub.readTable('ReceiptRequests');
  if (b.confirmDuplicate !== true) {
    // A receipt for this customer, amount and payment date is already out: say which one before anything else.
    const twins = rtTwins({ ...r, paidDate: dmy(r.paidDate) }, rows, await hub.readTable('Invoices', { cache: 30e3 }).catch(() => []));
    if (twins.length) {
      const e = bad(`ใบเสร็จของ ${r.billName} ยอด ${money(r.price - r.discount)} ชำระ ${dmy(r.paidDate)} ออกไปแล้ว`, 409);
      e.extra = { duplicate: true, issued: twins, matches: [] };
      throw e;
    }
    const since = Date.now() - 14 * 86400e3;
    const same = rows.filter((x) => x.taxId === r.taxId && Math.abs(ar.num(x.price) - r.price) < 0.01 && !DEAD.has(x.status)
      && (ar.parseDate(x.createdAt) || 0) > since - 86400e3);
    if (same.length) {
      const e = bad(`มีคำขอใบเสร็จของ ${r.billName} ยอดเดียวกันอยู่แล้ว ${same.length} ใบ`, 409);
      e.extra = { duplicate: true, matches: same.slice(-5).map((x) => ({ id: x.rtRequestId, createdAt: x.createdAt, by: x.salesName, status: x.status, ivNo: x.peakRtNo, amount: x.price })) };
      throw e;
    }
  }
  const id = shortId('RTREQ');
  const proof = b.file ? await drive.upload(b.file, { kind: 'payment', docNo: r.refDoc || r.packages.split(/[ ,]/)[0], company: r.billName, ref: id }) : '';
  const at = hub.sheetDateTime();
  await hub.appendRows('ReceiptRequests', [{ rtRequestId: id, createdAt: at, requestedBy: user.email, salesName: user.name, ...r,
    docKind: RT_KIND[r.docKind], deliveryChannel: RT_CHANNEL[r.deliveryChannel], paidDate: dmy(r.paidDate), paymentProof: proof,
    status: 'new', peakRtNo: '', peakDocLink: '', sentStatus: needsPost(r.deliveryChannel) ? 'waiting' : '', sentAt: '', trackingNo: '', accountNote: '', updatedAt: at }]);
  await Promise.all([hub.log('catalog', 'receipt_requested', id, `${user.email} · ${r.billName} · ${r.price}`),
    notify.chat(`🧾 ขอใบเสร็จ · ${notify.co(r.billName)} · ${money(r.price - r.discount)} บาท · ${user.name || user.email} · ${notify.link('pend', undefined, { t: 'rt', q: id })}`)]);
  res.status(200).json({ ok: true, rtRequestId: id, message: 'ส่งคำขอใบเสร็จแล้ว ฝ่ายบัญชีจะออกใน PEAK และแจ้งเลขเอกสารในหน้า "คำขอของฉัน"' });
}

async function listReceipts(req, res, user) {
  const rows = await hub.readTable('ReceiptRequests');
  const sees = await visibility(user);
  const waiting = rows.some((r) => r.status === 'new');
  const invs = waiting && can(user, 'approve') ? await hub.readTable('Invoices', { cache: 30e3 }).catch(() => []) : null;
  const out = rows.filter((r) => sees(r.requestedBy)).reverse().slice(0, 150).map(({ _row, ...r }) => {
    // For accounting: a waiting request that looks like money already receipted.
    const twins = invs && r.status === 'new' ? rtTwins(r, rows, invs) : [];
    return docLinkFor(user, 'RT', twins.length ? { ...r, twins } : r);
  });
  res.status(200).json({ ok: true, requests: out });
}

// Receipt issued from a paid INV (B2B): the collector recorded the payment on /ar, accounting issues the RT
// from that INV in PEAK and enters it here. No Whitehouse fields; customer details come from the INV.
async function rtFromInv(req, res, user) {
  const b = req.body || {};
  const ivNo = text(b.ivNo, 40).toUpperCase();
  const [invs, ivreqs, rts, pns] = await Promise.all([hub.readTable('Invoices'), hub.readTable('InvoiceRequests'), hub.readTable('ReceiptRequests'), hub.readTable('PaymentNotices').catch(() => [])]);
  const a = invs.find((x) => String(x.ivNo).toUpperCase() === ivNo);
  if (!a) throw bad('ไม่พบ INV นี้ในหน้าติดตามหนี้', 404);
  const plan = rtPlan(a, rts, pns, text(b.noticeId, 40));
  const no = text(b.peakRtNo, 40).toUpperCase();
  if (!/^[A-Z0-9-]{6,40}$/.test(no)) throw bad('ใส่เลขใบเสร็จจาก PEAK เช่น RT-20261100001');
  const link = text(b.peakDocLink, 500);
  if (!/^https:\/\/(doc|secure)\.peakaccount\.com\//.test(link)) throw bad('ใส่ลิงก์เอกสารจาก PEAK');
  await assertDoc('RT', { no, link, ref: 'paid:' + ivNo, taxId: a.taxId });
  const ch = text(b.deliveryChannel, 20);
  if (!RT_CHANNEL[ch]) throw bad('เลือกช่องทางส่งใบเสร็จ');
  const email = text(b.email, 120), addr = text(b.deliveryAddress, 600);
  if (needsEmail(ch) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('ใส่อีเมลลูกค้า');
  if (needsPost(ch) && !addr) throw bad('ใส่ที่อยู่ส่งใบเสร็จตัวจริง');
  const iv = ivreqs.find((x) => x.ivRequestId === a.ivRequestId) || {};
  const at = hub.sheetDateTime(); const id = shortId('RTREQ');
  const sent = !needsPost(ch);
  await hub.appendRows('ReceiptRequests', [{ rtRequestId: id, createdAt: at, requestedBy: iv.requestedBy || a.salesEmail || user.email, salesName: a.salesName || iv.salesName || '',
    segment: a.segment || 'B2B', docKind: RT_KIND.company, refDoc: ivNo, whStudent: '', billName: a.company, taxId: a.taxId, branch: a.branch || '00000', address: '', deliveryAddress: addr, email,
    whtRate: String(Math.round(ar.num(a.whtRate) < 1 ? ar.num(a.whtRate) * 100 : ar.num(a.whtRate))), packages: a.keyHS || '', description: a.packageName || '', price: ar.num(a.preVat), discount: 0,
    paidDate: plan.paidDate, paymentProof: plan.slip || '', deliveryChannel: RT_CHANNEL[ch], docLang: 'TH', note: `ออกจาก INV ${ivNo}${plan.tag}`, status: 'issued', peakRtNo: no, peakDocLink: link,
    sentStatus: sent ? 'sent' : 'waiting', sentAt: sent ? at : '', trackingNo: '', accountNote: `ออกใบเสร็จจาก INV — ${user.name || user.email}`, updatedAt: at }]);
  await hub.updateRow('Invoices', a._row, { rtNo: rtNoAdd(a.rtNo, no) });
  await Promise.all([hub.log('catalog', 'rt_from_inv', ivNo, `${user.email} · ${no}`), notify.chat(`🧾 ใบเสร็จ ${no} ออกแล้ว · ${ivNo} · ${notify.co(a.company)}${a.salesEmail ? ' · ' + await notify.at(a.salesEmail, a.salesName) : ''} · ${notify.link('mine', undefined, { t: 'rt', q: no })}`)]);
  res.status(200).json({ ok: true, rtRequestId: id });
}

// PEAK API on: RT Draft from the paid INV (POST /Receipts/createbyinvoice), with the payment accounting
// confirmed (date, amount, the PEAK account the money went to). Accounting approves it in PEAK; then the
// webhook or "อนุมัติใน PEAK แล้ว" (rt_check) finishes it like rt_from_inv.
async function rtMake(req, res, user) {
  const peak = require('../lib/peak');
  if (peak.mode() === 'off') throw bad('ยังไม่ได้เปิดการเชื่อมต่อ PEAK API', 409);
  const b = req.body || {};
  const ivNo = text(b.ivNo, 40).toUpperCase();
  const [invs, ivreqs, rts, users, pns] = await Promise.all([hub.readTable('Invoices'), hub.readTable('InvoiceRequests'), hub.readTable('ReceiptRequests'), hub.readTable('Users'), hub.readTable('PaymentNotices').catch(() => [])]);
  const a = invs.find((x) => String(x.ivNo).toUpperCase() === ivNo);
  if (!a) throw bad('ไม่พบ INV นี้ในหน้าติดตามหนี้', 404);
  // The whole payment, one round of several, or what is left after round receipts.
  const plan = rtPlan(a, rts, pns, text(b.noticeId, 40));
  const iv = ivreqs.find((x) => x.ivRequestId === a.ivRequestId) || {};
  let ivId = a.peakIvId || iv.peakIvId;
  // An INV issued before the app (imported row) has no PEAK id yet: find it in PEAK by its number, and keep the id.
  if (!ivId) {
    const found = await peak.findInvoiceByCode(ivNo).catch(() => null);
    if (found && found.id && Number(found.isVoid) !== 1) { ivId = found.id; await hub.updateRow('Invoices', a._row, { peakIvId: ivId }); }
  }
  if (!ivId) throw bad(`ไม่พบ ${ivNo} ใน PEAK ออกใบเสร็จใน PEAK เอง แล้วใส่เลข`, 409);
  const methods = await peak.listPaymentMethods();
  const pm = methods.find((m) => m.code === text(b.paymentMethodCode, 40));
  if (!pm) throw bad('เลือกบัญชีที่รับเงินใน PEAK');
  const ch = text(b.deliveryChannel, 20);
  if (!RT_CHANNEL[ch]) throw bad('เลือกช่องทางส่งใบเสร็จ');
  const email = text(b.email, 120), addr = text(b.deliveryAddress, 600);
  if (needsEmail(ch) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('ใส่อีเมลลูกค้า');
  if (needsPost(ch) && !addr) throw bad('ใส่ที่อยู่ส่งใบเสร็จตัวจริง');

  // Payment vs. the INV in PEAK: the customer pays the net, or the net less withholding tax.
  const d = await peak.getInvoice(ivId);
  if (!d) throw bad('ไม่พบ INV นี้ใน PEAK', 404);
  if (/draft/i.test(d.status || '') || Number(d.isVoid) === 1) throw bad(`INV ${d.code} ใน PEAK ${Number(d.isVoid) === 1 ? 'ถูกยกเลิกแล้ว' : 'ยังเป็น Draft'}`, 409);
  const net = ar.num(d.netAmount), paid = plan.amount;
  // Withholding tax is the gap between the INV and all the money received; it goes on the receipt that closes the INV.
  const wht = plan.round ? 0 : round2(net - (plan.rest ? plan.total : paid));
  if (plan.round ? paid > net + 0.01 : wht < -0.01 || wht > net * 0.06) throw bad(`ยอดรับเงิน ${money(paid)} ไม่ตรงกับ INV ${d.code} (${money(net)}${wht > 0 ? ` ส่วนต่าง ${money(wht)} เกินหัก ณ ที่จ่ายปกติ` : ''}) ตรวจยอดที่บันทึกรับเงิน`, 409);
  const ymd = (dmy) => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(dmy || '')); return m ? `${m[3]}${m[2].padStart(2, '0')}${m[1].padStart(2, '0')}` : ''; };
  const payDate = ymd(plan.paidDate);
  const qt = a.requestId ? (await hub.readTable('Requests')).find((x) => x.requestId === a.requestId) : null;
  const body = { PeakReceipts: { invoiceId: ivId, receipts: {
    issuedDate: payDate, status: 'Draft', isTaxInvoice: 1, reference: ivNo.slice(0, 32),
    tags: [a.requestId, a.ivRequestId].filter(Boolean),
    paidPayments: { paymentDate: payDate, payments: [{ paymentMethodCode: pm.code, amount: paid }], ...(wht > 0.009 ? { withHoldingTaxAmount: wht.toFixed(2) } : {}) },
  } } };
  const made = await peak.createReceiptFromInvoiceDraft(body);
  const notes = [`RT Draft ${made.code} รอฝ่ายบัญชีอนุมัติใน PEAK`, `รับเงินเข้า ${pm.name}`];
  if (qt) notes.push(...await require('../lib/qtdraft').classifyDoc(made.id, 103, qt, users));
  // The payment slip goes on the receipt too.
  const notice = plan.round ? (plan.slip ? { slipLink: plan.slip } : null) : pns.filter((n) => String(n.ivNo).toUpperCase() === ivNo && n.slipLink && ['confirmed', 'matched'].includes(n.status)).pop();
  const slip = notice ? await drive.download(notice.slipLink).catch(() => null) : null;
  if (slip) await attachToPeak('receipt', made.id, slip, `PAYMENT_${ivNo}`);

  const at = hub.sheetDateTime(); const id = shortId('RTREQ');
  await hub.appendRows('ReceiptRequests', [{ rtRequestId: id, createdAt: at, requestedBy: iv.requestedBy || a.salesEmail || user.email, salesName: a.salesName || iv.salesName || '',
    segment: a.segment || 'B2B', docKind: RT_KIND.company, refDoc: ivNo, whStudent: '', billName: a.company, taxId: a.taxId, branch: a.branch || '00000', address: '', deliveryAddress: addr, email,
    whtRate: String(Math.round(ar.num(a.whtRate) < 1 ? ar.num(a.whtRate) * 100 : ar.num(a.whtRate))), packages: a.keyHS || '', description: a.packageName || '', price: ar.num(a.preVat), discount: 0,
    paidDate: plan.paidDate, paymentProof: notice ? notice.slipLink : '', deliveryChannel: RT_CHANNEL[ch], docLang: 'TH', note: `ออกจาก INV ${ivNo}${plan.tag}`, status: 'rt_draft', peakRtNo: made.code || '', peakDocLink: made.documentLink || '',
    sentStatus: '', sentAt: '', trackingNo: '', accountNote: `${notes.join(' · ')} — ${user.name || user.email}`.slice(0, 500), updatedAt: at, peakRtId: made.id || '' }]);
  await hub.log('peak', 'rt_live_draft', ivNo, `${user.email} · ${made.code}`);
  res.status(200).json({ ok: true, rtRequestId: id, peakRtNo: made.code, message: notes.join(' · ') });
}

// RT approved in PEAK → issued (number, link), AR gets the receipt number, delivery as chosen. Used by
// rt_check and by the PEAK webhook.
async function finishRt(row, d, who, opts = {}) {
  const at = hub.sheetDateTime();
  const sent = !/ตัวจริง/.test(row.deliveryChannel || '');
  const f = { status: 'issued', peakRtNo: String(d.code || row.peakRtNo).toUpperCase(), peakDocLink: d.documentLink || row.peakDocLink, sentStatus: sent ? 'sent' : 'waiting', sentAt: sent ? at : '', accountNote: `${row.accountNote || ''} · อนุมัติใน PEAK แล้ว — ${who}`.slice(0, 500), updatedAt: at };
  if (opts.checked) await hub.writeChecked('ReceiptRequests', 'rtRequestId', row, f); else await hub.updateRow('ReceiptRequests', row._row, f);
  const invs = await hub.readTable('Invoices');
  const a = invs.find((x) => String(x.ivNo).toUpperCase() === String(row.refDoc).toUpperCase());
  // One receipt per INV keeps the first number; receipts per round are all listed.
  if (a && !a.rtNo) await hub.updateRow('Invoices', a._row, { rtNo: f.peakRtNo });
  else if (a && /รับเงิน /.test(row.note || '')) await hub.updateRow('Invoices', a._row, { rtNo: rtNoAdd(a.rtNo, f.peakRtNo) });
  await notify.chat(`🧾 ใบเสร็จ ${f.peakRtNo} ออกแล้ว · ${row.refDoc} · ${notify.co(row.billName)} · ${await notify.at(row.requestedBy, row.salesName)} · ${notify.link('mine', undefined, { t: 'rt', q: f.peakRtNo })}`);
}

async function updateReceipt(req, res, user) {
  checkOrigin(req);
  if (!can(user, 'approve')) throw bad('ไม่มีสิทธิ์อนุมัติเอกสาร', 403);
  const b = req.body || {};
  if (b.action === 'rt_from_inv') return rtFromInv(req, res, user);
  if (b.action === 'rt_make') return rtMake(req, res, user);
  const rows = await hub.readTable('ReceiptRequests');
  const row = rows.find((x) => x.rtRequestId === text(b.rtRequestId, 40));
  if (!row) throw bad('ไม่พบคำขอนี้', 404);
  hub.checkSeen(row, text(b.seen, 80));
  const at = hub.sheetDateTime(); const who = user.name || user.email; const note = text(b.note, 500);
  if (b.action === 'rt_check') {
    const peak = require('../lib/peak');
    if (row.status !== 'rt_draft' || !row.peakRtId) throw bad('ใบเสร็จนี้ไม่ได้รออนุมัติใน PEAK', 409);
    const d = await peak.getReceipt(row.peakRtId);
    if (!d) throw bad('ไม่พบใบเสร็จนี้ใน PEAK', 404);
    if (Number(d.isVoid) === 1 || /void/i.test(d.status || '')) throw bad(`ใบเสร็จ ${d.code} ถูกยกเลิกใน PEAK แล้ว`, 409);
    if (/draft/i.test(d.status || '')) throw bad(`ใบเสร็จ ${d.code} ใน PEAK ยังเป็น Draft อนุมัติใน PEAK ก่อน แล้วกดอีกครั้ง`, 409);
    await finishRt(row, d, who, { checked: true });
    await hub.log('catalog', 'rt_check', row.rtRequestId, `${user.email} · ${d.code}`);
    return res.status(200).json({ ok: true, peakRtNo: d.code });
  }
  if (b.action === 'rt_issued') {
    if (row.status !== 'new') throw bad(`คำขอนี้อยู่ในสถานะ ${row.status} แล้ว รีเฟรชหน้า`, 409);
    const no = text(b.peakRtNo, 40).toUpperCase();
    if (!/^[A-Z]{0,6}-?\d{6,}[A-Z0-9]*$/.test(no)) throw bad('ใส่เลขใบเสร็จจาก PEAK');
    const link = text(b.peakDocLink, 500);
    if (!/^https:\/\/(doc|secure)\.peakaccount\.com\//.test(link)) throw bad('ใส่ลิงก์เอกสารจาก PEAK');
    await assertDoc('RT', { no, link, ref: row.rtRequestId, taxId: row.taxId });
    const sent = !String(row.deliveryChannel).includes('ตัวจริง');
    await hub.writeChecked('ReceiptRequests', 'rtRequestId', row, { status: 'issued', peakRtNo: no, peakDocLink: link, accountNote: note ? `${note} — ${who}` : row.accountNote, sentStatus: sent ? 'sent' : 'waiting', sentAt: sent ? at : '', updatedAt: at });
  } else if (b.action === 'rt_reject') {
    if (row.status !== 'new') throw bad(`คำขอนี้อยู่ในสถานะ ${row.status} แล้ว`, 409);
    if (!note) throw bad('ใส่เหตุผลที่ตีกลับ');
    await hub.writeChecked('ReceiptRequests', 'rtRequestId', row, { status: 'rejected', accountNote: `${note} — ${who}`, updatedAt: at });
  } else if (b.action === 'rt_reopen') {
    if (row.status !== 'rejected') throw bad('คำขอนี้ไม่ได้ถูกตีกลับ', 409);
    await hub.writeChecked('ReceiptRequests', 'rtRequestId', row, { status: 'new', updatedAt: at });
  } else if (b.action === 'rt_sent') {
    if (row.status !== 'issued') throw bad('ต้องออกใบเสร็จก่อนจึงบันทึกการส่งได้', 409);
    if (row.sentStatus === 'sent') throw bad('บันทึกว่าส่งแล้ว', 409);
    await hub.updateRow('ReceiptRequests', row._row, { sentStatus: 'sent', sentAt: at, trackingNo: text(b.trackingNo, 60), updatedAt: at });
  } else throw bad('คำสั่งไม่ถูกต้อง');
  const owner = ['rt_issued', 'rt_reject'].includes(b.action) ? await notify.at(row.requestedBy, row.salesName) : '';
  const tell = { rt_issued: () => `🧾 ใบเสร็จ ${text(b.peakRtNo, 40).toUpperCase()} ออกแล้ว · ${notify.co(row.billName)} · ${owner} · ${notify.link('mine', undefined, { t: 'rt', q: text(b.peakRtNo, 40).toUpperCase() })}`,
    rt_reject: () => `↩️ ตีกลับคำขอใบเสร็จ · ${notify.co(row.billName)} · ${owner} · ${notify.link('mine', undefined, { t: 'rt', q: row.rtRequestId })}\nเหตุผล: ${notify.why(note)}` }[b.action];
  await Promise.all([hub.log('catalog', b.action, row.rtRequestId, `${user.email}${note ? ' · ' + note : ''}`), tell ? notify.chat(tell()) : null]);
  res.status(200).json({ ok: true });
}

// ---------------------------------------------------------------- edit requests for issued QT / INV
// A document can't be changed once the next step has started on it:
//   QT  → locked when any INV request (not rejected) exists for it
//   INV → locked when a receipt was requested / issued for it or the payment is recorded
async function assertEditable(r) {
  const n = (x) => String(x || '').toUpperCase();
  if (r.docType === 'QT') {
    const ivs = (await hub.readTable('InvoiceRequests')).filter((v) => !DEAD.has(v.status)
      && ((r.refId && v.requestId === r.refId) || n(v.qtNo) === r.docNo));
    if (ivs.length) throw bad(`QT ${r.docNo} ขอ INV ไปแล้ว ${ivs.length} ใบ แก้ QT ไม่ได้ ถ้าต้องเปลี่ยนให้ขอแก้ที่ INV หรือแจ้งฝ่ายบัญชี`, 409);
  }
  if (r.docType === 'INV') {
    const [ars, rts] = await Promise.all([hub.readTable('Invoices'), hub.readTable('ReceiptRequests')]);
    const a = ars.find((x) => n(x.ivNo) === r.docNo && x.docStatus !== 'Cancelled');
    if (a && !a.rtNo && !a.paidDate && ar.num(a.paidAmount) > 0) throw bad(`INV ${r.docNo} รับเงินบางส่วนแล้ว แก้ไม่ได้ แจ้งฝ่ายบัญชี`, 409);
    if (a && (a.rtNo || a.paidDate)) throw bad(`INV ${r.docNo} ${a.rtNo ? `ออกใบเสร็จแล้ว (${a.rtNo})` : 'บันทึกรับเงินแล้ว'} แก้ INV ไม่ได้`, 409);
    if (rts.some((x) => n(x.refDoc) === r.docNo && !DEAD.has(x.status))) throw bad(`INV ${r.docNo} มีคำขอใบเสร็จแล้ว แก้ INV ไม่ได้`, 409);
  }
}

async function createEdit(req, res, user) {
  checkOrigin(req);
  if (!can(user, 'request')) throw bad('ไม่มีสิทธิ์ขอเอกสาร', 403);
  const b = req.body || {};
  const r = { docType: text(b.docType, 5), docNo: text(b.docNo, 40).toUpperCase(), refId: text(b.refId, 60), company: text(b.company, 200), detail: text(b.detail, 1500) };
  // Receipts are never edited once issued (accounting rule): only QT and INV can be changed.
  if (r.docType === 'RT') throw bad('ใบเสร็จออกแล้วแก้ไม่ได้ ถ้าออกผิดให้แจ้งฝ่ายบัญชีโดยตรง');
  if (!['QT', 'INV'].includes(r.docType)) throw bad('เลือกประเภทเอกสาร');
  if (!/^[A-Z0-9-]{6,40}$/.test(r.docNo)) throw bad('ใส่เลขเอกสารที่ต้องการแก้ เช่น QO-20261100012');
  if (r.detail.length < 5) throw bad('อธิบายว่าต้องการแก้อะไร');
  await assertEditable(r);
  const rows = await hub.readTable('EditRequests');
  if (rows.some((x) => x.docNo === r.docNo && x.status === 'new')) throw bad(`มีคำขอแก้ ${r.docNo} ที่ยังรอฝ่ายบัญชีอยู่แล้ว`, 409);
  const id = shortId('EDIT'); const at = hub.sheetDateTime();
  await hub.appendRows('EditRequests', [{ editId: id, createdAt: at, requestedBy: user.email, salesName: user.name, ...r, status: 'new', accountNote: '', newDocNo: '', doneBy: '', updatedAt: at }]);
  await Promise.all([hub.log('catalog', 'edit_requested', id, `${user.email} · ${r.docNo}`), notify.chat(`✏️ ขอแก้ ${r.docType} ${r.docNo} · ${notify.co(r.company)} · ${user.name || user.email} · ${notify.link('pend', undefined, { t: 'edit', q: r.docNo })}`)]);
  res.status(200).json({ ok: true, editId: id });
}
async function listEdits(req, res, user) {
  const rows = await hub.readTable('EditRequests');
  const sees = await visibility(user);
  res.status(200).json({ ok: true, requests: rows.filter((r) => sees(r.requestedBy)).reverse().slice(0, 150).map(({ _row, ...r }) => r) });
}
async function updateEdit(req, res, user) {
  checkOrigin(req);
  if (!can(user, 'approve')) throw bad('ไม่มีสิทธิ์อนุมัติเอกสาร', 403);
  const b = req.body || {};
  const row = (await hub.readTable('EditRequests')).find((x) => x.editId === text(b.editId, 40));
  if (!row) throw bad('ไม่พบคำขอนี้', 404);
  if (row.status !== 'new') throw bad(`คำขอนี้ ${row.status === 'done' ? 'แก้แล้ว' : 'ถูกตีกลับ'} รีเฟรชหน้า`, 409);
  const note = text(b.note, 500); const at = hub.sheetDateTime(); const who = user.name || user.email;
  if (b.action === 'edit_reject' && !note) throw bad('ใส่เหตุผลที่ตีกลับ');
  // Older receipt edit requests can only be closed (rejected), never applied.
  if (b.action === 'edit_done' && row.docType === 'RT') throw bad('ใบเสร็จแก้ไม่ได้ ตีกลับคำขอนี้แทน', 409);
  const newNo = text(b.newDocNo, 40).toUpperCase();
  const newLink = text(b.newLink, 500);
  const newAmt = b.newAmount === '' || b.newAmount === undefined ? null : Number(String(b.newAmount).replace(/,/g, ''));
  if (newNo && !/^[A-Z0-9-]{6,40}$/.test(newNo)) throw bad('เลขเอกสารใหม่ไม่ถูกต้อง');
  if (newLink && !/^https:\/\/(doc|secure)\.peakaccount\.com\//.test(newLink)) throw bad('ลิงก์ต้องเป็นลิงก์เอกสารจาก PEAK');
  if (newNo && newNo !== row.docNo && !newLink) throw bad('ออกเลขใหม่แล้ว ใส่ลิงก์เอกสารใหม่จาก PEAK ด้วย');
  if (newAmt !== null && !(newAmt > 0 && newAmt < 1e9)) throw bad('ยอดก่อน VAT ใหม่ไม่ถูกต้อง');
  // "Done" also updates the request the document came from, so every page shows the corrected document.
  if (b.action === 'edit_done' && (newNo || newLink)) {
    const kind = ['QT', 'INV', 'RT'].includes(row.docType) ? row.docType : '';
    if (kind) {
      // The document being replaced may share the old number/link with the AR row of the same INV.
      const inv = kind === 'INV' ? (await hub.readTable('Invoices')).find((x) => x.ivRequestId === row.refId) : null;
      await assertDoc(kind, { no: newNo && newNo !== row.docNo ? newNo : '', link: newLink, ref: row.refId, extraRefs: inv ? [inv.ivRequestId] : [] });
    }
  }
  if (b.action === 'edit_done') {
    const mark = `แก้ไขแล้ว (${row.editId}${newNo && newNo !== row.docNo ? ` · ${row.docNo} → ${newNo}` : ''}) — ${who}`;
    if (row.docType === 'QT') {
      const q = (await hub.readTable('Requests')).find((x) => x.requestId === row.refId);
      if (q) {
        const f = { peakNote: mark, updatedAt: at };
        if (newNo && newNo !== q.peakQtNo) { f.peakQtNo = newNo; f.peakQtId = ''; }
        if (newLink) f.peakDocLink = newLink;
        if (newAmt !== null) { f.totalPreVat = newAmt; f.totalInclVat = vatSplit(newAmt, false).inclVat; }
        // PEAK API on and the same QT edited in place: take totals and lines straight from PEAK.
        let pq = null; const peak = require('../lib/peak');
        if (peak.mode() !== 'off' && q.peakQtId && !(newNo && newNo !== q.peakQtNo)) pq = await peak.getQuotation(q.peakQtId).catch(() => null);
        if (pq && !(Number(pq.isVoid) === 1 || /void/i.test(pq.status || ''))) {
          const incl = q.vatMode ? q.vatMode === 'incl' : vatIncluded(q.segment);
          const pre = Number(pq.preTaxAmount) || 0, net = Number(pq.netAmount) || 0;
          if (pre) f.totalPreVat = pre;
          if (net) f.totalInclVat = incl ? net : vatSplit(pre, false).inclVat;
          f.qtSig = peak.quotationSig(pq);
          if (pq.documentLink) f.peakDocLink = pq.documentLink;
        }
        await hub.updateRow('Requests', q._row, f);
        if (pq) await require('../lib/qtlines').syncFromPeak(q.requestId, pq).catch(() => null);
      }
    } else if (row.docType === 'INV') {
      const iv = (await hub.readTable('InvoiceRequests')).find((x) => x.ivRequestId === row.refId);
      if (iv) {
        const f = { accountNote: mark, updatedAt: at };
        if (newNo) f.peakIvNo = newNo;
        if (newLink) f.peakDocLink = newLink;
        if (newAmt !== null) { f.amountPreVat = newAmt; f.amountInclVat = vatSplit(newAmt, false).inclVat; }
        await hub.updateRow('InvoiceRequests', iv._row, f);
        const a = (await hub.readTable('Invoices')).find((x) => x.ivRequestId === iv.ivRequestId || String(x.ivNo).toUpperCase() === String(iv.peakIvNo).toUpperCase());
        if (a) {
          const g = { note: [a.note, mark].filter(Boolean).join(' · ') };
          if (newNo) g.ivNo = newNo;
          if (newLink) g.peakDocLink = newLink;
          if (newAmt !== null) g.preVat = newAmt;
          await hub.updateRow('Invoices', a._row, g);
          // Same number kept: accounting may have voided the INV and issued it again (new customer branch,
          // address…), which gives the document a new id and link in PEAK. Bring the row in line right away.
          if (!(newNo && newNo !== row.docNo) && !newLink && require('../lib/peak').mode() !== 'off') {
            try { const out = await refreshFromPeak(g.ivNo || a.ivNo); if (out.changes.length) await hub.log('catalog', 'edit_refresh', a.ivNo, out.changes.join(', ')); } catch (e) { await hub.log('catalog', 'edit_refresh_failed', a.ivNo, e.message).catch(() => {}); }
          }
        }
      }
    } else if (row.docType === 'RT') {
      const r = (await hub.readTable('ReceiptRequests')).find((x) => x.rtRequestId === row.refId);
      if (r) {
        const f = { accountNote: mark, updatedAt: at };
        if (newNo) f.peakRtNo = newNo;
        if (newLink) f.peakDocLink = newLink;
        await hub.updateRow('ReceiptRequests', r._row, f);
      }
    }
  }
  await hub.writeChecked('EditRequests', 'editId', row, { status: b.action === 'edit_done' ? 'done' : 'rejected', accountNote: note, newDocNo: newNo, doneBy: who, updatedAt: at });
  await Promise.all([hub.log('catalog', b.action, row.editId, `${user.email} · ${row.docNo}`),
    notify.chat(b.action === 'edit_done' ? `✅ แก้ ${row.docType} ${row.docNo}${newNo ? ' → ' + newNo : ''} แล้ว · ${notify.co(row.company)} · ${await notify.at(row.requestedBy, row.salesName)} · ${notify.link('mine', undefined, { t: 'edit', q: row.docNo })}` : `↩️ ไม่แก้ ${row.docType} ${row.docNo} · ${notify.co(row.company)} · ${await notify.at(row.requestedBy, row.salesName)} · ${notify.link('mine', undefined, { t: 'edit', q: row.docNo })}\nเหตุผล: ${notify.why(note)}`)]);
  res.status(200).json({ ok: true });
}

// One-off moves from the legacy sheets (file prepared by Claude, uploaded by an admin on /ar).
// invoices → Invoices (+ followUps → FollowUps); quotations → Requests (QTs issued in PEAK before the app).
async function importLegacy(req, res, user) {
  checkOrigin(req);
  if (!can(user, 'users')) throw bad('เฉพาะผู้ดูแลสิทธิ์', 403);
  const b = req.body || {};
  const out = {};
  if (Array.isArray(b.invoices)) {
    const have = new Set((await hub.readTable('Invoices')).map((x) => String(x.ivNo).toUpperCase()));
    const cols = hub.TABLES.Invoices.filter((c) => !c.startsWith('_'));
    const rows = b.invoices.filter((x) => x && /^[A-Z]{2,6}-?\d{6,}$/.test(String(x.ivNo || '').toUpperCase()) && !have.has(String(x.ivNo).toUpperCase()))
      .map((x) => Object.fromEntries(cols.map((c) => [c, x[c] === undefined ? '' : x[c]])));
    if (rows.length) await hub.appendRows('Invoices', rows);
    const ivs = new Set(rows.map((x) => x.ivNo));
    const fus = (Array.isArray(b.followUps) ? b.followUps : []).filter((f) => f && ivs.has(f.ivNo));
    if (fus.length) await hub.appendRows('FollowUps', fus);
    out.invoices = rows.length; out.skipped = b.invoices.length - rows.length; out.followUps = fus.length;
  }
  if (Array.isArray(b.quotations)) {
    const reqs = await hub.readTable('Requests');
    const haveId = new Set(reqs.map((x) => String(x.peakQtId || '')).filter(Boolean));
    const rows = b.quotations.filter((x) => x && x.peakQtId && !haveId.has(String(x.peakQtId)) && x.requestId && x.peakQtNo);
    if (rows.length) await hub.appendRows('Requests', rows.map((x) => ({ ...x, status: 'qt_approved' })));
    out.quotations = rows.length; out.quotationsSkipped = b.quotations.length - rows.length;
  }
  await hub.log('catalog', 'legacy_import', '', `${user.email} · ${JSON.stringify(out)}`);
  res.status(200).json({ ok: true, ...out });
}

async function list(req, res, user) {
  if (req.query && req.query.view === 'ar') return arList(req, res, user);
  if (req.query && req.query.view === 'receipts') return listReceipts(req, res, user);
  // Work log of the debt page (accounting / collectors / admin): follow-ups, commit dates, money in. Read only.
  if (req.query && req.query.view === 'arlog') {
    if (!isOp(user)) throw bad('ไม่มีสิทธิ์ดูประวัติการทำงาน', 403);
    return res.status(200).json({ ok: true, ...(await require('../lib/arlog').load()) });
  }
  // Approval history (accounting): every action from SyncLog joined to its request. Read only.
  if (req.query && req.query.view === 'history') {
    if (!can(user, 'approve') && !isOp(user)) throw bad('ไม่มีสิทธิ์ดูประวัติการอนุมัติ', 403);
    return res.status(200).json({ ok: true, ...(await require('../lib/history').load()) });
  }
  if (req.query && req.query.view === 'edits') return listEdits(req, res, user);
  if (req.query && req.query.view === 'payments') return listPayNotices(req, res, user);
  if (req.query && req.query.view === 'pay-methods') {
    if (!can(user, 'approve')) throw bad('ไม่มีสิทธิ์', 403);
    const peak = require('../lib/peak');
    if (peak.mode() === 'off') throw bad('ยังไม่ได้เปิดการเชื่อมต่อ PEAK API', 503);
    return res.status(200).json({ ok: true, methods: await peak.listPaymentMethods() });
  }
  const [rows, invs, notices] = await Promise.all([hub.readTable('InvoiceRequests'), hub.readTable('Invoices').catch(() => []), hub.readTable('PaymentNotices').catch(() => [])]);
  const lastNotice = new Map(), rounds = new Map();
  for (const n of notices) if (n.ivRequestId) { lastNotice.set(n.ivRequestId, n); if (!rounds.has(n.ivRequestId)) rounds.set(n.ivRequestId, []); rounds.get(n.ivRequestId).push({ noticeId: n.noticeId, status: n.status, source: n.source, paidDate: n.paidDate, amount: n.amount, accountNote: n.accountNote }); }
  // Payment status from AR, so sales see whether their customer has paid.
  const byReq = new Map(), byNo = new Map();
  for (const x of invs) { if (x.ivRequestId) byReq.set(x.ivRequestId, x); if (x.ivNo) byNo.set(String(x.ivNo).toUpperCase(), x); }
  const today = ar.todayMs();
  const sees = await visibility(user);
  const out = rows
    .filter((r) => sees(r.requestedBy))
    .reverse()
    .slice(0, can(user, 'approve') || can(user, 'team_view') ? 1000 : 300)
    .map(({ _row, ...r0 }) => {
      const n = lastNotice.get(r0.ivRequestId);
      const r = n ? { ...r0, payNotice: { noticeId: n.noticeId, status: n.status, source: n.source, paidDate: n.paidDate, amount: n.amount, paymentMethod: n.paymentMethod, slipLink: n.slipLink, deliveryChannel: n.deliveryChannel, email: n.email, deliveryAddress: n.deliveryAddress, accountNote: n.accountNote, salesName: n.salesName, updatedAt: n.updatedAt }, payRounds: rounds.get(r0.ivRequestId) } : r0;
      const a = byReq.get(r.ivRequestId) || (r.peakIvNo && byNo.get(String(r.peakIvNo).toUpperCase()));
      if (!a) return r;
      const e = ar.enrich(a, today);
      return { ...r, ar: { state: e.state, segment: a.segment || '', dueDate: e.dueDate, expected: e.expected, expectedFull: e.expectedFull, received: e.received, preVat: ar.num(a.preVat), whtPct: ar.whtPct(a), paidDate: a.paidDate, paidAmount: a.paidAmount, paymentMethod: a.paymentMethod, rtNo: a.rtNo, daysOverdue: e.daysOverdue, commitDate: a.commitDate, followStatus: a.followStatus } };
    });
  res.status(200).json({ ok: true, uploads: drive.enabled(), requests: out.map((r) => docLinkFor(user, 'INV', r)) });
}

module.exports = (req, res) => require('../lib/hub').scope(req, () => inner(req, res));
async function inner(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const user = await requireUser(req);
    const act = String((req.body || {}).action || '');
    if (req.method === 'POST') return await ({ legacy_import: importLegacy, receipt: createReceipt, edit: createEdit, pay_notice: createPayNotice }[act] || create)(req, res, user);
    if (req.method === 'PATCH' && act === 'qt_adopt') return await adoptQt(req, res, user);
    if (req.method === 'PATCH' && act === 'rt_find') { checkOrigin(req); return await rtFind(req, res, user); }
    if (req.method === 'PATCH') return await (act.startsWith('ar_') ? arUpdate : act.startsWith('rt_') ? updateReceipt : act.startsWith('edit_') ? updateEdit : act.startsWith('pay_') ? updatePayNotice : update)(req, res, user);
    if (req.method === 'GET') return await list(req, res, user);
    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    sendError(res, e);
  }
};

module.exports.issueInv = issueInv;
module.exports.finishRt = finishRt;
module.exports._test = { validate, alreadyInvoiced };
