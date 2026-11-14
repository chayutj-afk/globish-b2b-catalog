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
const { requireUser, can, visibility } = require('../lib/users');
const users = require('../lib/users');
// Requests that no longer count (turned down, or their INV / receipt voided in PEAK).
const DEAD = new Set(['rejected', 'iv_void', 'rt_void']);
const hub = require('../lib/hub');
const drive = require('../lib/drive');
const notify = require('../lib/notify');
const { OPP_RE, normaliseOppId } = require('../lib/crm');
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
  if (r.opportunityId && !OPP_RE.test(r.opportunityId)) throw bad('Opportunity ID ต้องเป็นรูปแบบ CRM-OPP-YYYY-NNNNN');
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
  const [requests, existing] = await Promise.all([r.requestId ? hub.readTable('Requests') : [], hub.readTable('InvoiceRequests')]);
  let linked = null;
  if (r.requestId) {
    linked = requests.find((x) => x.requestId === r.requestId);
    if (!linked || (!can(user, 'approve') && linked.requestedBy !== user.email)) throw bad('ไม่พบคำขอใบเสนอราคาที่เลือก');
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
    if (!r.opportunityId) r.opportunityId = linked.opportunityId || '';
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
  else if (!r.opportunityId) throw bad(`ใส่ Opportunity ID จาก CRM (CRM-OPP-YYYY-NNNNN) สำหรับลูกค้า ${ctype.name}`);

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
  const prior = alreadyInvoiced(existing, r, incl);
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
  after.push(notify.chat([
    `🧾 ขอออก INV ใหม่ ${batchId} จาก ${user.name || user.email}`,
    `QT ${r.qtNo} · ${rows.length} ใบ · รวม${basis} ${money(asked)}${remaining !== null ? ` · คงเหลือ ${money(remaining)}` : ''}`,
    `ออกในนาม: ${entities.join(', ')}`,
    originals ? `📮 ต้องส่งตัวจริง ${originals} ใบ` : '',
    over ? `⚠️ เกินยอด QT: ${r.overReason}` : '',
    !r.requestId ? `⚠️ QT นอกระบบ: ${r.offReason}` : '',
  ].filter(Boolean).join('\n')));
  await Promise.all(after);

  res.status(200).json({
    ok: true, batchId, ivRequestIds: rows.map((x) => x.ivRequestId), evidenceLink, asked, remaining, vatMode: incl ? 'incl' : 'excl',
    message: `ส่งคำขอออก INV ${rows.length} ใบแล้ว ฝ่ายบัญชีจะตรวจหลักฐานและออกเอกสารใน PEAK`,
  });
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
    if (row.status === 'rejected') throw bad('คำขอ INV นี้ถูกตีกลับแล้ว', 409);
    const address = text(b.address, 500) || row.originalAddress;
    const recipient = text(b.recipient, 120) || row.originalRecipient;
    if (want === 'yes' && (!address || !recipient)) throw bad('ใส่ผู้รับและที่อยู่สำหรับส่งเอกสารตัวจริง');
    await hub.updateRow('InvoiceRequests', row._row, {
      originalDoc: want, originalStatus: ORIGINAL[want], originalRecipient: recipient, originalAddress: address,
      deliveryAddress: address, originalRequestedAt: want === 'yes' ? at : '', updatedAt: at,
    });
    await hub.log('catalog', want === 'yes' ? 'original_requested' : 'original_not_needed', id, user.email);
    if (want === 'no' && row.originalStatus === 'requested') {
      await notify.chat(`📭 ลูกค้าไม่ต้องการเอกสารตัวจริงแล้ว ${id}\n${row.company} · QT ${row.qtNo}${row.peakIvNo ? ' · ' + row.peakIvNo : ''}\nแจ้งโดย ${user.name || user.email} (ไม่ต้องส่งตามที่อยู่ ${row.originalAddress || '-'})`);
    }
    if (want === 'yes') {
      await notify.chat(`📮 ลูกค้าขอเอกสารตัวจริง ${id}\n${row.company} · QT ${row.qtNo}${row.peakIvNo ? ' · ' + row.peakIvNo : ''}\nส่งถึง: ${recipient ? recipient + ' · ' : ''}${address}\nแจ้งโดย ${user.name || user.email}`);
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
    await notify.chat(`✅ ส่งเอกสารตัวจริงแล้ว ${id} · ${row.company}${trackingNo ? ' · เลขพัสดุ ' + trackingNo : ''} (แจ้ง ${row.salesName || row.requestedBy})`);
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
      if (row.status !== 'new' || row.peakIvId) throw bad(`คำขอนี้มี INV ใน PEAK แล้ว (${row.peakIvNo || row.status}) รีเฟรชหน้า`, 409);
      const [reqs, users] = await Promise.all([hub.readTable('Requests'), hub.readTable('Users')]);
      const qt = reqs.find((x) => x.requestId === row.requestId);
      // Claim the row first so a double click can't make two INVs.
      await hub.writeChecked('InvoiceRequests', 'ivRequestId', row, { status: 'iv_creating', updatedAt: at });
      let out;
      try { out = (await require('../lib/ivdraft').createForIvRequest(row, qt, users)).fields; }
      catch (e) {
        await hub.updateRow('InvoiceRequests', row._row, { status: 'new', updatedAt: hub.sheetDateTime(), accountNote: `สร้าง INV ใน PEAK ไม่สำเร็จ: ${String(e.message).slice(0, 300)}` });
        await hub.log('peak', 'iv_live_error', id, String(e.message).slice(0, 200));
        throw bad(`สร้าง INV ใน PEAK ไม่สำเร็จ: ${String(e.message).slice(0, 300)}`, e.status === 409 ? 409 : 502);
      }
      out.updatedAt = hub.sheetDateTime();
      out.accountNote = `${out.accountNote} — ${who}`.slice(0, 500);
      await hub.updateRow('InvoiceRequests', row._row, out);
      // The evidence Sales attached goes on the INV too.
      const ev = await drive.download(row.evidenceLink).catch(() => null);
      if (ev) await attachToPeak('invoice', out.peakIvId, ev, `INV-EVIDENCE_${row.ivRequestId}`);
      await hub.log('peak', 'iv_live_draft', id, `${user.email} · ${out.peakIvNo}`);
      return res.status(200).json({ ok: true, status: 'iv_draft', peakIvNo: out.peakIvNo, message: out.accountNote });
    }
    if (!['iv_draft', 'new'].includes(row.status) || !row.peakIvId) throw bad('คำขอนี้ยังไม่มี INV Draft ใน PEAK', 409);
    const d = await peak.getInvoice(row.peakIvId);
    if (!d) throw bad('ไม่พบ INV นี้ใน PEAK', 404);
    if (Number(d.isVoid) === 1 || /void/i.test(d.status || '')) throw bad(`INV ${d.code} ถูกยกเลิกใน PEAK แล้ว`, 409);
    if (/draft/i.test(d.status || '')) throw bad(`INV ${d.code} ใน PEAK ยังเป็น Draft อนุมัติใน PEAK ก่อน แล้วกดอีกครั้ง`, 409);
    const dmyOf = (x) => { const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(x || '').replace(/-/g, '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
    await issueInv(row, { ivNo: String(d.code).toUpperCase(), link: d.documentLink || row.peakDocLink, issueDate: dmyOf(d.issuedDate) || row.wantedIssueDate, note: `อนุมัติ INV ใน PEAK แล้ว — ${who}`, peakIvId: d.id }, { checked: true });
    await hub.log('catalog', 'iv_check', id, `${user.email} · ${d.code}`);
    return res.status(200).json({ ok: true, status: 'iv_issued', peakIvNo: d.code });
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
    } else if (b.action === 'reopen') {
      await hub.writeChecked('InvoiceRequests', 'ivRequestId', row, { status: 'new', updatedAt: at });
    } else {
      const ivNo = text(b.peakIvNo, 40).toUpperCase();
      if (!/^[A-Z]{1,6}-?\d{6,}$/.test(ivNo)) throw bad('ใส่เลข INV จาก PEAK เช่น IV-20261100014');
      // Accounting issues the INV from the QT in PEAK; approving here needs the link to that INV.
      const link = text(b.peakDocLink, 500);
      if (!/^https:\/\/(doc|secure)\.peakaccount\.com\//.test(link)) throw bad('ใส่ลิงก์เอกสาร INV จาก PEAK (https://doc.peakaccount.com/… หรือ https://secure.peakaccount.com/…)');
      await assertDoc('INV', { no: ivNo, link, ref: row.ivRequestId, taxId: row.taxId });
      // Issue date as it is on the INV in PEAK (defaults to the date sales asked for).
      const issueDate = dmy(text(b.issueDate, 10)) || row.wantedIssueDate;
      if (!ar.parseDate(issueDate)) throw bad('ใส่วันที่ออก INV ตามเอกสารใน PEAK');
      await issueInv(row, { ivNo, link, issueDate, note }, { checked: true });
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
      notify.chat(`⚠️ แนบไฟล์ ${label} เข้า PEAK ไม่สำเร็จ (${String(e.message).slice(0, 80)}) แนบเองใน PEAK`).catch(() => {})]);
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
}

// ---------------------------------------------------------------- AR (debt follow-up)
const isOp = (u) => can(u, 'ar');
function summarise(all, today) {
  // Old rows the Debt sheet still showed as unpaid are kept apart until someone checks them in PEAK.
  const check = all.filter((r) => r.legacyCheck);
  const open = all.filter((r) => (r.state === 'Outstanding' || r.state === 'Overdue') && !r.legacyCheck);
  const sum = (xs, f = 'expected') => Math.round(xs.reduce((s, r) => s + (Number(r[f]) || 0), 0) * 100) / 100;
  const buckets = ['Not due', '1-30', '31-60', '61-90', '90+'];
  const segs = [...new Set(open.map((r) => r.segment || 'Others'))].sort();
  const aging = segs.map((sg) => ({ segment: sg, ...Object.fromEntries(buckets.map((b) => [b, sum(open.filter((r) => (r.segment || 'Others') === sg && r.aging === b))])), total: sum(open.filter((r) => (r.segment || 'Others') === sg)) }));
  const DAY = 86400e3;
  const thisThu = today + ((((4 - new Date(today).getUTCDay()) % 7) + 7) % 7) * DAY;
  const weeks = [];
  for (let i = 0; i < 8; i++) {
    const end = thisThu + i * 7 * DAY;
    const xs = open.filter((r) => r.forecastWeek === ar.fmt(end));
    weeks.push({ weekEnd: ar.fmt(end), expected: sum(xs), count: xs.length });
  }
  const earlier = open.filter((r) => { const d = ar.parseDate(r.forecastWeek); return d !== null && d < thisThu; });
  const later = open.filter((r) => { const d = ar.parseDate(r.forecastWeek); return d !== null && d > thisThu + 7 * 7 * DAY; });
  const cash = [];
  for (let i = 1; i <= 8; i++) {
    const end = thisThu - i * 7 * DAY; const start = end - 6 * DAY;
    const xs = all.filter((r) => r.paidMs !== null && r.paidMs >= start && r.paidMs <= end);
    cash.push({ weekEnd: ar.fmt(end), paid: Math.round(xs.reduce((s, r) => s + (ar.num(r.paidAmount) || r.expected), 0) * 100) / 100, count: xs.length });
  }
  const months = [];
  const t = new Date(today);
  for (let i = 0; i < 12; i++) {
    const y = t.getUTCFullYear(), m = t.getUTCMonth() - i;
    const start = Date.UTC(y, m, 1), end = Date.UTC(y, m + 1, 1) - 1;
    const iss = all.filter((r) => r.issueMs !== null && r.issueMs >= start && r.issueMs <= end && r.state !== 'Closed');
    const paid = all.filter((r) => r.paidMs !== null && r.paidMs >= start && r.paidMs <= end);
    months.push({ month: ar.fmt(start).slice(3), invoiced: sum(iss, 'preVatN'), count: iss.length, cash: Math.round(paid.reduce((s, r) => s + (ar.num(r.paidAmount) || r.expected), 0) * 100) / 100,
      bySegment: Object.fromEntries([...new Set(iss.map((r) => r.segment || 'Others'))].map((sg) => [sg, sum(iss.filter((r) => (r.segment || 'Others') === sg), 'preVatN')])) });
  }
  const recentPaid = all.filter((r) => r.paidMs !== null && r.paidMs >= today - 90 * DAY && r.cycleDays !== '');
  return {
    legacyCheck: sum(check), legacyCheckCount: check.length,
    open: sum(open), openCount: open.length, overdue: sum(open.filter((r) => r.state === 'Overdue')), overdueCount: open.filter((r) => r.state === 'Overdue').length,
    avgDaysToPay: recentPaid.length ? Math.round(recentPaid.reduce((s, r) => s + r.cycleDays, 0) / recentPaid.length) : 0,
    aging, buckets, forecast: { earlier: sum(earlier), earlierCount: earlier.length, weeks, later: sum(later), laterCount: later.length }, cash, months,
  };
}

async function arList(req, res, user) {
  if (!can(user, 'ar_view')) throw bad('ไม่มีสิทธิ์ดูหน้าติดตามหนี้', 403);
  const [rows, fus, ivreqs] = await Promise.all([hub.readTable('Invoices'), hub.readTable('FollowUps'), hub.readTable('InvoiceRequests').catch(() => [])]);
  const today = ar.todayMs();
  // Customer contact from the INV request, to prefill where the receipt goes.
  const contact = new Map(ivreqs.map((v) => [v.ivRequestId, { financeEmail: v.financeEmail || '', deliveryAddress: v.originalAddress || v.deliveryAddress || '' }]));
  const all = rows.filter((r) => r.ivNo).map((r) => ({ ...ar.enrich(r, today), preVatN: ar.num(r.preVat) }));
  const byIv = new Map();
  for (const f of fus) { if (!byIv.has(f.ivNo)) byIv.set(f.ivNo, []); byIv.get(f.ivNo).push(f); }
  const keep = all.filter((r) => r.state === 'Outstanding' || r.state === 'Overdue' || (r.paidMs !== null && r.paidMs >= today - 120 * 86400e3) || (r.issueMs !== null && r.issueMs >= today - 120 * 86400e3));
  const out = keep.map(({ _row, issueMs, dueMs, paidMs, preVatN, ...r }) => ({ ...r, ...(contact.get(r.ivRequestId) || {}), followUps: (byIv.get(r.ivNo) || []).slice(-20).map(({ _row: x, ...f }) => f) }));
  const canOwner = isOp(user) || can(user, 'team_view');
  const owners = canOwner ? (await users.list()).filter((u) => ['sales', 'lead'].includes(u.role)).map((u) => ({ email: u.email, name: u.name || u.email })) : [];
  res.status(200).json({ ok: true, peakLive: require('../lib/peak').mode() !== 'off', summary: summarise(all, today), invoices: out, total: all.length, canOwner, owners,
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
  if (!isOp(user) && !(await visibility(user))(row.salesEmail)) throw bad('INV นี้ไม่อยู่ในทีมของคุณ', 403);
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
async function arRefresh(req, res, user) {
  if (!isOp(user) && !can(user, 'approve')) throw bad('ไม่มีสิทธิ์', 403);
  const peak = require('../lib/peak');
  if (peak.mode() === 'off') throw bad('ยังไม่ได้เปิดการเชื่อมต่อ PEAK API', 503);
  const ivNo = text((req.body || {}).ivNo, 40);
  const row = (await hub.readTable('Invoices')).find((x) => x.ivNo === ivNo);
  if (!row) throw bad('ไม่พบ INV นี้ใน AR', 404);
  const ps = require('../lib/peaksync');
  const iv = row.peakIvId ? await peak.getInvoice(row.peakIvId) : await peak.findInvoiceByCode(row.ivNo);
  if (!iv) throw bad(`ไม่พบ ${row.ivNo} ใน PEAK`, 404);
  const a = await ps.syncInvoice(iv, { classes: true });
  const changes = [...((a && a.changes) || [])];
  if (a && a.classError) changes.push('อ่านกลุ่มจัดประเภทจาก PEAK ไม่ได้ (ลองใหม่ภายหลัง)');
  if (row.rtNo) {
    const rt = await peak.findReceiptByCode(row.rtNo).catch(() => null);
    if (rt) changes.push(...(((await ps.syncReceipt(rt, { classes: true })) || {}).changes || []));
  }
  await hub.log('catalog', 'ar_refresh', ivNo, `${user.email} · ${changes.join(', ') || 'no change'}`);
  res.status(200).json({ ok: true, changes, status: iv.status || '' });
}

async function arUpdate(req, res, user) {
  checkOrigin(req);
  if ((req.body || {}).action === 'ar_owner') return arOwner(req, res, user);
  if ((req.body || {}).action === 'ar_refresh') return arRefresh(req, res, user);
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
    await hub.appendRows('FollowUps', [{ loggedAt: at, ivNo, channel, by: who, result, nextActionDate: next, note }]);
    const f = { followStatus: result, nextActionDate: next };
    const commit = dateIn(b.commitDate, 'วันนัดจ่าย');
    if (commit) f.commitDate = commit;
    await hub.updateRow('Invoices', row._row, f);
    await hub.log('catalog', 'ar_followup', ivNo, `${user.email} · ${channel} · ${result}`);
    return res.status(200).json({ ok: true });
  }
  if (b.action === 'ar_update') {
    const f = {};
    if ('commitDate' in b) f.commitDate = dateIn(b.commitDate, 'วันนัดจ่าย');
    if ('paidDate' in b) f.paidDate = dateIn(b.paidDate, 'วันที่รับเงิน');
    if ('paidAmount' in b) { const n = b.paidAmount === '' ? '' : Number(String(b.paidAmount).replace(/,/g, '')); if (n !== '' && !(n > 0)) throw bad('ยอดรับเงินไม่ถูกต้อง'); f.paidAmount = n; }
    if ('paymentMethod' in b) { const m = text(b.paymentMethod, 40); if (m && !ar.PAY_METHODS.includes(m)) throw bad('วิธีชำระเงินไม่ถูกต้อง'); f.paymentMethod = m; }
    if ('rtNo' in b) { f.rtNo = text(b.rtNo, 40).toUpperCase(); if (f.rtNo && f.rtNo !== String(row.rtNo || '').toUpperCase()) await assertDoc('RT', { no: f.rtNo, ref: 'paid:' + row.ivNo, taxId: row.taxId }); }
    if ('delayReason' in b) f.delayReason = text(b.delayReason, 200);
    if ('docStatus' in b) { const d = text(b.docStatus, 20); if (!ar.DOC_STATUS.includes(d)) throw bad('สถานะเอกสารไม่ถูกต้อง'); f.docStatus = d; }
    if ('note' in b) f.note = text(b.note, 500);
    if (f.paidDate && !(f.paidAmount || ar.num(row.paidAmount))) throw bad('ใส่ยอดเงินที่ได้รับ');
    if (f.paidDate && !(f.paymentMethod || row.paymentMethod)) throw bad('เลือกวิธีชำระเงิน');
    if (!Object.keys(f).length) throw bad('ไม่มีข้อมูลที่จะบันทึก');
    const newlyPaid = !!f.paidDate && !row.paidDate;
    // Receipt delivery for a new payment: checked before anything is saved.
    let delivery = null;
    if (newlyPaid) {
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
      await paidDirectly(row, f, slip, user, delivery);
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
  const open = notices.find((x) => String(x.ivNo).toUpperCase() === ivNo && x.status === 'new');
  if (open) throw bad(`แจ้งจ่าย INV นี้ไปแล้ว รอฝ่ายบัญชีตรวจ (${open.noticeId})`, 409);
  const paidDate = dmy(text(b.paidDate, 10));
  if (!paidDate || !ar.parseDate(paidDate)) throw bad('ใส่วันที่ลูกค้าโอน');
  if (ar.parseDate(paidDate) > ar.todayMs() + 86400e3) throw bad('วันที่โอนอยู่ในอนาคต');
  const amount = Number(String(b.amount ?? '').replace(/,/g, ''));
  if (!(amount > 0 && amount < 1e9)) throw bad('ใส่ยอดที่ลูกค้าโอน');
  const method = text(b.paymentMethod, 40);
  if (!ar.PAY_METHODS.includes(method)) throw bad('เลือกวิธีชำระเงิน');
  if (!b.file) throw bad('แนบสลิป / หลักฐานการโอน');
  const ch = text(b.deliveryChannel, 20);
  if (!PAY_CHANNELS.includes(ch)) throw bad('เลือกช่องทางส่งใบเสร็จ');
  const email = text(b.email, 120), addr = text(b.deliveryAddress, 600);
  if (needsEmail(ch) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('ใส่อีเมลลูกค้าสำหรับส่งใบเสร็จ');
  if (needsPost(ch) && !addr) throw bad('ใส่ที่อยู่ส่งใบเสร็จตัวจริง');
  const id = shortId('PAY');
  const slip = await drive.upload(b.file, { kind: 'payment', docNo: ivNo, company: a.company, ref: id });
  const at = hub.sheetDateTime();
  await hub.appendRows('PaymentNotices', [{ noticeId: id, createdAt: at, requestedBy: user.email, salesName: user.name, ivRequestId: iv.ivRequestId, ivNo,
    company: a.company, paidDate, amount: round2(amount), paymentMethod: method, slipLink: slip, deliveryChannel: ch, email, deliveryAddress: addr,
    note: text(b.note, 500), status: 'new', source: 'sales', accountNote: '', doneBy: '', updatedAt: at }]);
  const exp = ar.enrich(a, ar.todayMs()).expected;
  await Promise.all([hub.log('catalog', 'pay_notice', id, `${user.email} · ${ivNo} · ${amount}`),
    notify.chat([`💰 ${user.name || user.email} แจ้งว่าลูกค้าจ่าย ${ivNo} แล้ว · ${a.company}`,
      `โอน ${money(amount)} เมื่อ ${paidDate} · ${method}${Math.abs(exp - amount) > 1 ? ` · ⚠️ ที่ควรได้รับ ${money(exp)}` : ''}`,
      'ตรวจเงินเข้าแล้วกดยืนยันที่หน้าติดตามหนี้'].join('\n'))]);
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
      notify.chat(`↩️ ยังไม่ยืนยันเงินเข้า ${row.ivNo} · ${row.company} (แจ้งโดย ${row.salesName || row.requestedBy})\nเหตุผล: ${note}`)]);
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
  const amount = b.amount !== undefined && b.amount !== '' ? Number(String(b.amount).replace(/,/g, '')) : ar.num(row.amount);
  if (!(amount > 0)) throw bad('ยอดรับเงินไม่ถูกต้อง');
  await hub.updateRow('Invoices', a._row, { paidDate, paidAmount: round2(amount), paymentMethod: row.paymentMethod,
    note: [a.note, `รับเงินตามที่ ${row.salesName || row.requestedBy} แจ้ง (${row.noticeId}) ยืนยันโดย ${who}`].filter(Boolean).join(' · ').slice(0, 500) });
  await hub.updateRow('PaymentNotices', row._row, { status: 'confirmed', paidDate, amount: round2(amount), accountNote: note, doneBy: who, updatedAt: at });
  if (a.peakIvId && require('../lib/peak').mode() !== 'off') {
    const slipFile = await drive.download(row.slipLink).catch(() => null);
    if (slipFile) await attachToPeak('invoice', a.peakIvId, slipFile, `PAYMENT_${row.ivNo}`);
  }
  await Promise.all([hub.log('catalog', 'pay_confirm', row.noticeId, `${user.email} · ${row.ivNo} · ${amount}`),
    notify.chat(`✅ ยืนยันเงินเข้า ${row.ivNo} · ${row.company} ${money(amount)} (แจ้งโดย ${row.salesName || row.requestedBy}) · รอออกใบเสร็จ`)]);
  res.status(200).json({ ok: true });
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
  await notify.chat(`💰 ลูกค้าจ่ายแล้ว ${ivNo} · ${row.company} ${money(f.paidAmount || row.paidAmount)} (บัญชีบันทึก${row.salesName ? ` · แจ้ง ${row.salesName}` : ''}) · รอออกใบเสร็จ`);
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
    notify.chat(`🧾 ขอใบเสร็จ/ใบกำกับภาษี ${id} จาก ${user.name || user.email}\n${r.segment} · ${r.billName} · ${money(r.price - r.discount)} บาท\n${RT_CHANNEL[r.deliveryChannel]}`)]);
  res.status(200).json({ ok: true, rtRequestId: id, message: 'ส่งคำขอใบเสร็จแล้ว ฝ่ายบัญชีจะออกใน PEAK และแจ้งเลขเอกสารในหน้า "คำขอของฉัน"' });
}

async function listReceipts(req, res, user) {
  const rows = await hub.readTable('ReceiptRequests');
  const sees = await visibility(user);
  const out = rows.filter((r) => sees(r.requestedBy)).reverse().slice(0, 150).map(({ _row, ...r }) => r);
  res.status(200).json({ ok: true, requests: out });
}

// Receipt issued from a paid INV (B2B): the collector recorded the payment on /ar, accounting issues the RT
// from that INV in PEAK and enters it here. No Whitehouse fields; customer details come from the INV.
async function rtFromInv(req, res, user) {
  const b = req.body || {};
  const ivNo = text(b.ivNo, 40).toUpperCase();
  const [invs, ivreqs, rts] = await Promise.all([hub.readTable('Invoices'), hub.readTable('InvoiceRequests'), hub.readTable('ReceiptRequests')]);
  const a = invs.find((x) => String(x.ivNo).toUpperCase() === ivNo);
  if (!a) throw bad('ไม่พบ INV นี้ในหน้าติดตามหนี้', 404);
  if (!a.paidDate) throw bad('ยังไม่ได้บันทึกรับเงินของ INV นี้ (บันทึกที่หน้าติดตามหนี้ก่อน)', 409);
  if (a.rtNo || rts.some((x) => x.refDoc === ivNo && !DEAD.has(x.status))) throw bad(`INV นี้ออกใบเสร็จแล้ว${a.rtNo ? ' (' + a.rtNo + ')' : ''}`, 409);
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
    paidDate: a.paidDate, paymentProof: '', deliveryChannel: RT_CHANNEL[ch], docLang: 'TH', note: `ออกจาก INV ${ivNo}`, status: 'issued', peakRtNo: no, peakDocLink: link,
    sentStatus: sent ? 'sent' : 'waiting', sentAt: sent ? at : '', trackingNo: '', accountNote: `ออกใบเสร็จจาก INV — ${user.name || user.email}`, updatedAt: at }]);
  await hub.updateRow('Invoices', a._row, { rtNo: no });
  await Promise.all([hub.log('catalog', 'rt_from_inv', ivNo, `${user.email} · ${no}`), notify.chat(`🧾 ออกใบเสร็จ ${no} จาก ${ivNo} · ${a.company}${sent ? '' : ' · รอส่งตัวจริง'}`)]);
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
  const [invs, ivreqs, rts, users] = await Promise.all([hub.readTable('Invoices'), hub.readTable('InvoiceRequests'), hub.readTable('ReceiptRequests'), hub.readTable('Users')]);
  const a = invs.find((x) => String(x.ivNo).toUpperCase() === ivNo);
  if (!a) throw bad('ไม่พบ INV นี้ในหน้าติดตามหนี้', 404);
  if (!a.paidDate) throw bad('ยังไม่ได้บันทึกรับเงินของ INV นี้', 409);
  if (a.rtNo || rts.some((x) => x.refDoc === ivNo && !DEAD.has(x.status))) throw bad(`INV นี้มีใบเสร็จแล้ว${a.rtNo ? ' (' + a.rtNo + ')' : ''} รีเฟรชหน้า`, 409);
  const iv = ivreqs.find((x) => x.ivRequestId === a.ivRequestId) || {};
  const ivId = a.peakIvId || iv.peakIvId;
  if (!ivId) throw bad('INV นี้ไม่มีรหัสใน PEAK (ออกก่อนเชื่อม API) ออกใบเสร็จใน PEAK เอง แล้วใส่เลข', 409);
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
  const net = ar.num(d.netAmount), paid = round2(ar.num(a.paidAmount));
  const wht = round2(net - paid);
  if (wht < -0.01 || wht > net * 0.06) throw bad(`ยอดรับเงิน ${money(paid)} ไม่ตรงกับ INV ${d.code} (${money(net)}${wht > 0 ? ` ส่วนต่าง ${money(wht)} เกินหัก ณ ที่จ่ายปกติ` : ''}) ตรวจยอดที่บันทึกรับเงิน`, 409);
  const ymd = (dmy) => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(dmy || '')); return m ? `${m[3]}${m[2].padStart(2, '0')}${m[1].padStart(2, '0')}` : ''; };
  const payDate = ymd(a.paidDate);
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
  const notice = (await hub.readTable('PaymentNotices').catch(() => [])).filter((n) => String(n.ivNo).toUpperCase() === ivNo && n.slipLink && ['confirmed', 'matched'].includes(n.status)).pop();
  const slip = notice ? await drive.download(notice.slipLink).catch(() => null) : null;
  if (slip) await attachToPeak('receipt', made.id, slip, `PAYMENT_${ivNo}`);

  const at = hub.sheetDateTime(); const id = shortId('RTREQ');
  await hub.appendRows('ReceiptRequests', [{ rtRequestId: id, createdAt: at, requestedBy: iv.requestedBy || a.salesEmail || user.email, salesName: a.salesName || iv.salesName || '',
    segment: a.segment || 'B2B', docKind: RT_KIND.company, refDoc: ivNo, whStudent: '', billName: a.company, taxId: a.taxId, branch: a.branch || '00000', address: '', deliveryAddress: addr, email,
    whtRate: String(Math.round(ar.num(a.whtRate) < 1 ? ar.num(a.whtRate) * 100 : ar.num(a.whtRate))), packages: a.keyHS || '', description: a.packageName || '', price: ar.num(a.preVat), discount: 0,
    paidDate: a.paidDate, paymentProof: notice ? notice.slipLink : '', deliveryChannel: RT_CHANNEL[ch], docLang: 'TH', note: `ออกจาก INV ${ivNo}`, status: 'rt_draft', peakRtNo: made.code || '', peakDocLink: made.documentLink || '',
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
  if (a && !a.rtNo) await hub.updateRow('Invoices', a._row, { rtNo: f.peakRtNo });
  await notify.chat(`🧾 ออกใบเสร็จ ${f.peakRtNo} จาก ${row.refDoc} · ${row.billName}${sent ? '' : ' · รอส่งตัวจริง'}`);
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
  const tell = { rt_issued: () => `🧾 ออกใบเสร็จแล้ว ${text(b.peakRtNo, 40).toUpperCase()} · ${row.billName} (คำขอ ${row.rtRequestId} ของ ${row.salesName || row.requestedBy})`,
    rt_reject: () => `↩️ ตีกลับคำขอใบเสร็จ ${row.rtRequestId} · ${row.billName} (ของ ${row.salesName || row.requestedBy})\nเหตุผล: ${note}` }[b.action];
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
  await Promise.all([hub.log('catalog', 'edit_requested', id, `${user.email} · ${r.docNo}`), notify.chat(`✏️ ขอแก้ไข ${r.docType} ${r.docNo} (${r.company}) จาก ${user.name || user.email}\n${r.detail}`)]);
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
    notify.chat(b.action === 'edit_done' ? `✅ แก้ ${row.docType} ${row.docNo}${newNo ? ' → ' + newNo : ''} แล้ว · ${row.company} (คำขอของ ${row.salesName || row.requestedBy})` : `↩️ ตีกลับคำขอแก้ ${row.docType} ${row.docNo} · ${row.company} (ของ ${row.salesName || row.requestedBy})\nเหตุผล: ${note}`)]);
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
  if (req.query && req.query.view === 'edits') return listEdits(req, res, user);
  if (req.query && req.query.view === 'payments') return listPayNotices(req, res, user);
  if (req.query && req.query.view === 'pay-methods') {
    if (!can(user, 'approve')) throw bad('ไม่มีสิทธิ์', 403);
    const peak = require('../lib/peak');
    if (peak.mode() === 'off') throw bad('ยังไม่ได้เปิดการเชื่อมต่อ PEAK API', 503);
    return res.status(200).json({ ok: true, methods: await peak.listPaymentMethods() });
  }
  const [rows, invs, notices] = await Promise.all([hub.readTable('InvoiceRequests'), hub.readTable('Invoices').catch(() => []), hub.readTable('PaymentNotices').catch(() => [])]);
  const lastNotice = new Map();
  for (const n of notices) if (n.ivRequestId) lastNotice.set(n.ivRequestId, n);
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
      const r = n ? { ...r0, payNotice: { noticeId: n.noticeId, status: n.status, source: n.source, paidDate: n.paidDate, amount: n.amount, paymentMethod: n.paymentMethod, slipLink: n.slipLink, deliveryChannel: n.deliveryChannel, email: n.email, deliveryAddress: n.deliveryAddress, accountNote: n.accountNote, salesName: n.salesName, updatedAt: n.updatedAt } } : r0;
      const a = byReq.get(r.ivRequestId) || (r.peakIvNo && byNo.get(String(r.peakIvNo).toUpperCase()));
      if (!a) return r;
      const e = ar.enrich(a, today);
      return { ...r, ar: { state: e.state, dueDate: e.dueDate, expected: e.expected, paidDate: a.paidDate, paidAmount: a.paidAmount, paymentMethod: a.paymentMethod, rtNo: a.rtNo, daysOverdue: e.daysOverdue, commitDate: a.commitDate, followStatus: a.followStatus } };
    });
  res.status(200).json({ ok: true, uploads: drive.enabled(), requests: out });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const user = await requireUser(req);
    const act = String((req.body || {}).action || '');
    if (req.method === 'POST') return await ({ legacy_import: importLegacy, receipt: createReceipt, edit: createEdit, pay_notice: createPayNotice }[act] || create)(req, res, user);
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
