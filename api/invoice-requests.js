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
const { requireUser } = require('../lib/users');
const hub = require('../lib/hub');
const drive = require('../lib/drive');
const notify = require('../lib/notify');
const { OPP_RE, normaliseOppId } = require('../lib/crm');
const { validTaxId, normBranch } = require('../lib/taxid');
const ar = require('../lib/ar');

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
  };
  if (!r.qtNo) throw bad('ใส่เลขที่ใบเสนอราคา (QT) ที่ต้องการออก INV');
  if (!['0', '1', '2', '3', '5'].includes(r.whtRate)) throw bad('เลือกหัก ณ ที่จ่าย (ไม่หัก / 1% / 2% / 3% / 5%)');
  if (r.opportunityId && !OPP_RE.test(r.opportunityId)) throw bad('Opportunity ID ต้องเป็นรูปแบบ CRM-OPP-YYYY-NNNNN');
  checkEntity(r, 'ลูกค้าตาม QT');
  if (!EVIDENCE.includes(r.evidenceType)) throw bad('เลือกประเภทหลักฐานที่ลูกค้ายอมรับ');
  if (r.evidenceType === 'อื่นๆ' && !r.evidenceOther) throw bad('ระบุว่าหลักฐานเป็นเอกสารอะไร');
  if (!b.file) throw bad('แนบไฟล์หลักฐาน (PDF / JPG / PNG)');
  if (r.financeEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.financeEmail)) throw bad('อีเมลฝ่ายการเงินไม่ถูกต้อง');

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
      amountPreVat: num(x && x.amountPreVat),
      students: num(x && x.students),
      wantedIssueDate: text(x && x.wantedIssueDate, 10),
      creditTermDays: num(x && x.creditTermDays),
      poNo: text(x && x.poNo, 60),
      originalDoc: Object.prototype.hasOwnProperty.call(ORIGINAL, x && x.originalDoc) ? x.originalDoc : 'unknown',
      originalRecipient: text(x && x.originalRecipient, 120),
      originalAddress: text(x && x.originalAddress, 500),
      note: text(x && x.note, 500),
    };
    if (!same) checkEntity(v, label);
    if (!same && !v.relation) throw bad(`${label}: ระบุความสัมพันธ์กับลูกค้าตาม QT เช่น บริษัทลูก`);
    if (!(v.amountPreVat > 0 && v.amountPreVat < 1e9)) throw bad(`${label}: ใส่ยอดก่อน VAT`);
    v.amountPreVat = round2(v.amountPreVat);
    if (v.students === '') throw bad(`${label}: ใส่จำนวนผู้เรียนในใบนี้`);
    if (!v.wantedIssueDate) throw bad(`${label}: ใส่วันที่ต้องการให้ลงใน INV`);
    if (v.creditTermDays === '') throw bad(`${label}: ใส่เครดิตเทอม (วัน)`);
    if (!(Number.isInteger(v.students) && v.students >= 1 && v.students <= 5000)) throw bad(`${label}: จำนวนผู้เรียนไม่ถูกต้อง`);
    if (v.wantedIssueDate && !/^\d{4}-\d{2}-\d{2}$/.test(v.wantedIssueDate)) throw bad(`${label}: วันที่ออก INV ไม่ถูกต้อง`);
    if (v.creditTermDays !== '' && !(Number.isInteger(v.creditTermDays) && v.creditTermDays >= 0 && v.creditTermDays <= 180)) throw bad(`${label}: เครดิตเทอมต้องอยู่ระหว่าง 0 ถึง 180 วัน`);
    if (v.originalDoc === 'yes' && !v.originalAddress) throw bad(`${label}: ใส่ที่อยู่สำหรับส่งเอกสารตัวจริง`);
    return v;
  });
  return { r, invoices };
}

// Pre-VAT amount already requested against a QT (rejected requests don't count).
function alreadyInvoiced(rows, { requestId, qtNo }) {
  return round2(rows
    .filter((x) => x.status !== 'rejected' && ((requestId && x.requestId === requestId) || (!requestId && qtNo && x.qtNo === qtNo)))
    .reduce((s, x) => s + (Number(String(x.amountPreVat).replace(/,/g, '')) || 0), 0));
}

async function create(req, res, user) {
  checkOrigin(req);
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
    if (!linked || (user.role !== 'op' && linked.requestedBy !== user.email)) throw bad('ไม่พบคำขอใบเสนอราคาที่เลือก');
    // Only a QT accounting has approved in PEAK can be billed.
    if (!['qt_approved', 'accepted', 'iv_requested', 'iv_issued'].includes(linked.status)) throw bad('QT นี้ยังไม่ได้อนุมัติใน PEAK ขอ INV ได้หลังฝ่ายบัญชีอนุมัติ QT แล้ว', 409);
    if (!r.opportunityId) r.opportunityId = linked.opportunityId || '';
    r.segment = linked.segment || r.segment;
  }
  // A QT typed by hand (not a request in this app): no balance or approval check is possible, so a reason is required.
  if (!r.requestId && !r.offReason) throw bad('เลือก QT จากระบบ หรือใส่เหตุผลที่ใช้ QT นอกระบบ');
  // CRM Opportunity ID: required for every segment except B2S.
  if (r.segment === 'B2S') r.opportunityId = '';
  else if (!r.opportunityId) throw bad('ใส่ Opportunity ID จาก CRM (CRM-OPP-YYYY-NNNNN) ยกเว้นลูกค้า B2S');

  // Same QT + same billed tax ID + same amount already requested (not rejected) → probably sent twice.
  if (b.confirmDuplicate !== true) {
    const ref = (x) => (r.requestId ? x.requestId === r.requestId : x.qtNo === r.qtNo);
    const same = existing.filter((x) => x.status !== 'rejected' && ref(x)
      && invoices.some((v) => x.taxId === v.taxId && Math.abs((Number(String(x.amountPreVat).replace(/,/g, '')) || 0) - v.amountPreVat) < 0.01));
    if (same.length) {
      const e = bad(`QT ${r.qtNo} มีคำขอ INV ยอดเดียวกันอยู่แล้ว ${same.length} ใบ`, 409);
      e.extra = { duplicate: true, matches: same.slice(-5).map((x) => ({ id: x.ivRequestId, createdAt: x.createdAt, by: x.salesName || x.requestedBy, status: x.status, amount: x.amountPreVat, ivNo: x.peakIvNo })) };
      throw e;
    }
  }

  // Balance check: never silently bill more than the QT.
  const prior = alreadyInvoiced(existing, r);
  const asked = round2(invoices.reduce((s, v) => s + v.amountPreVat, 0));
  const qtTotal = linked ? Number(String(linked.totalPreVat).replace(/,/g, '')) || 0 : 0;
  const over = linked && qtTotal > 0 && prior + asked > qtTotal + 0.01;
  if (over && !r.overReason) {
    throw bad(`ยอดรวม INV (${money(prior + asked)}) เกินยอด QT (${money(qtTotal)}) ใส่เหตุผลก่อนส่ง หรือแก้ยอด`);
  }

  const evidenceLink = await drive.upload(b.file, `${batchId} ${r.qtNo} ${r.company}`.slice(0, 120));
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
  }));
  await hub.appendRows('InvoiceRequests', rows);

  const remaining = qtTotal > 0 ? round2(qtTotal - prior - asked) : null;
  const after = [
    linked ? hub.updateRow('Requests', linked._row, {
      status: 'iv_requested', ivRequestedAt: linked.ivRequestedAt || at, updatedAt: at,
      peakQtNo: linked.peakQtNo || r.qtNo,
    }) : null,
    hub.log('catalog', 'invoice_requested', batchId,
      `${user.email} · ${r.qtNo} · ${rows.length} INV · ${asked}${over ? ' · over QT: ' + r.overReason : ''}`),
  ];

  const entities = [...new Set(rows.map((x) => x.company))];
  const originals = rows.filter((x) => x.originalDoc === 'yes').length;
  after.push(notify.chat([
    `🧾 ขอออก INV ใหม่ ${batchId} จาก ${user.name || user.email}`,
    `QT ${r.qtNo} · ${rows.length} ใบ · รวมก่อน VAT ${money(asked)}${remaining !== null ? ` · คงเหลือ ${money(remaining)}` : ''}`,
    `ออกในนาม: ${entities.join(', ')}`,
    originals ? `📮 ต้องส่งตัวจริง ${originals} ใบ` : '',
    over ? `⚠️ เกินยอด QT: ${r.overReason}` : '',
    !r.requestId ? `⚠️ QT นอกระบบ: ${r.offReason}` : '',
  ].filter(Boolean).join('\n')));
  await Promise.all(after);

  res.status(200).json({
    ok: true, batchId, ivRequestIds: rows.map((x) => x.ivRequestId), evidenceLink, asked, remaining,
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
  if (!row || (user.role !== 'op' && row.requestedBy !== user.email)) throw bad('ไม่พบคำขอ INV นี้', 404);
  const at = hub.sheetDateTime();
  if (user.role === 'op') hub.checkSeen(row, text(b.seen, 80));

  if (b.action === 'original') {
    const want = b.originalDoc === 'no' ? 'no' : 'yes';
    if (row.originalStatus === 'sent') throw bad('ส่งตัวจริงไปแล้ว', 409);
    if (row.status === 'rejected') throw bad('คำขอ INV นี้ถูกตีกลับแล้ว', 409);
    const address = text(b.address, 500) || row.originalAddress;
    const recipient = text(b.recipient, 120) || row.originalRecipient;
    if (want === 'yes' && !address) throw bad('ใส่ที่อยู่สำหรับส่งเอกสารตัวจริง');
    await hub.updateRow('InvoiceRequests', row._row, {
      originalDoc: want, originalStatus: ORIGINAL[want], originalRecipient: recipient, originalAddress: address,
      deliveryAddress: address, originalRequestedAt: want === 'yes' ? at : '', updatedAt: at,
    });
    await hub.log('catalog', want === 'yes' ? 'original_requested' : 'original_not_needed', id, user.email);
    if (want === 'yes') {
      await notify.chat(`📮 ลูกค้าขอเอกสารตัวจริง ${id}\n${row.company} · QT ${row.qtNo}${row.peakIvNo ? ' · ' + row.peakIvNo : ''}\nส่งถึง: ${recipient ? recipient + ' · ' : ''}${address}\nแจ้งโดย ${user.name || user.email}`);
    }
    return res.status(200).json({ ok: true, originalStatus: ORIGINAL[want] });
  }

  if (b.action === 'original_sent') {
    if (user.role !== 'op') throw bad('เฉพาะฝ่ายบัญชี / Admin', 403);
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

  // Accounting: INV issued from the QT in PEAK (fallback when the sync hasn't picked it up), or rejected.
  if (b.action === 'issued' || b.action === 'reject' || b.action === 'reopen') {
    if (user.role !== 'op') throw bad('เฉพาะฝ่ายบัญชี / Admin', 403);
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
      // Issue date as it is on the INV in PEAK (defaults to the date sales asked for).
      const issueDate = dmy(text(b.issueDate, 10)) || row.wantedIssueDate;
      if (!ar.parseDate(issueDate)) throw bad('ใส่วันที่ออก INV ตามเอกสารใน PEAK');
      const [invs, requests, lines, users, groups] = await Promise.all([
        hub.readTable('Invoices'), row.requestId ? hub.readTable('Requests') : [], row.requestId ? hub.readTable('RequestLines') : [],
        hub.readTable('Users'), ar.readProductGroups(),
      ]);
      const dup = invs.find((x) => String(x.ivNo).toUpperCase() === ivNo);
      if (dup && dup.ivRequestId && dup.ivRequestId !== row.ivRequestId) throw bad(`เลข ${ivNo} ถูกใช้กับคำขอ ${dup.ivRequestId} แล้ว ตรวจเลข INV อีกครั้ง`, 409);
      await hub.writeChecked('InvoiceRequests', 'ivRequestId', row, { status: 'iv_issued', peakIvNo: ivNo, peakDocLink: link, accountNote: note || row.accountNote, updatedAt: at });
      // Goes straight into AR (Invoices), so nobody re-types it for debt follow-up.
      if (!dup) {
        const request = requests.find((x) => x.requestId === row.requestId);
        const ls = lines.filter((x) => x.requestId === row.requestId);
        await hub.appendRows('Invoices', [ar.rowFromRequest(row, { request, lines: ls, users, issueDate, ivNo, peakDocLink: link, productGroups: groups })]);
      }
    }
    await hub.log('catalog', `iv_${b.action}`, id, `${user.email}${note ? ' · ' + note : ''}`);
    return res.status(200).json({ ok: true });
  }

  throw bad('คำสั่งไม่ถูกต้อง');
}

// ---------------------------------------------------------------- AR (debt follow-up)
const isOp = (u) => u.role === 'op';
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
  if (!isOp(user)) throw bad('เฉพาะฝ่ายบัญชี / Admin', 403);
  const [rows, fus] = await Promise.all([hub.readTable('Invoices'), hub.readTable('FollowUps')]);
  const today = ar.todayMs();
  const all = rows.filter((r) => r.ivNo).map((r) => ({ ...ar.enrich(r, today), preVatN: ar.num(r.preVat) }));
  const byIv = new Map();
  for (const f of fus) { if (!byIv.has(f.ivNo)) byIv.set(f.ivNo, []); byIv.get(f.ivNo).push(f); }
  const keep = all.filter((r) => r.state === 'Outstanding' || r.state === 'Overdue' || (r.paidMs !== null && r.paidMs >= today - 120 * 86400e3) || (r.issueMs !== null && r.issueMs >= today - 120 * 86400e3));
  const out = keep.map(({ _row, issueMs, dueMs, paidMs, preVatN, ...r }) => ({ ...r, followUps: (byIv.get(r.ivNo) || []).slice(-20).map(({ _row: x, ...f }) => f) }));
  res.status(200).json({ ok: true, summary: summarise(all, today), invoices: out, total: all.length,
    lists: { docStatus: ar.DOC_STATUS, payMethods: ar.PAY_METHODS, channels: ar.CHANNELS, follow: ar.FOLLOW, delay: ar.DELAY } });
}

async function arUpdate(req, res, user) {
  checkOrigin(req);
  if (!isOp(user)) throw bad('เฉพาะฝ่ายบัญชี / Admin', 403);
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
    if ('rtNo' in b) f.rtNo = text(b.rtNo, 40).toUpperCase();
    if ('delayReason' in b) f.delayReason = text(b.delayReason, 200);
    if ('docStatus' in b) { const d = text(b.docStatus, 20); if (!ar.DOC_STATUS.includes(d)) throw bad('สถานะเอกสารไม่ถูกต้อง'); f.docStatus = d; }
    if ('note' in b) f.note = text(b.note, 500);
    if (f.paidDate && !(f.paidAmount || ar.num(row.paidAmount))) throw bad('ใส่ยอดเงินที่ได้รับ');
    if (f.paidDate && !(f.paymentMethod || row.paymentMethod)) throw bad('เลือกวิธีชำระเงิน');
    if (!Object.keys(f).length) throw bad('ไม่มีข้อมูลที่จะบันทึก');
    await hub.updateRow('Invoices', row._row, f);
    await hub.log('catalog', 'ar_update', ivNo, `${user.email} · ${Object.keys(f).join(',')}`);
    return res.status(200).json({ ok: true });
  }
  throw bad('คำสั่งไม่ถูกต้อง');
}

// One-off moves from the legacy sheets (file prepared by Claude, uploaded by an admin on /ar).
// invoices → Invoices (+ followUps → FollowUps); quotations → Requests (QTs issued in PEAK before the app).
async function importLegacy(req, res, user) {
  checkOrigin(req);
  if (!user.admin) throw bad('เฉพาะผู้ดูแลสิทธิ์ (finance@ / chayut.j@)', 403);
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
  const [rows, invs] = await Promise.all([hub.readTable('InvoiceRequests'), hub.readTable('Invoices').catch(() => [])]);
  // Payment status from AR, so sales see whether their customer has paid.
  const byReq = new Map(), byNo = new Map();
  for (const x of invs) { if (x.ivRequestId) byReq.set(x.ivRequestId, x); if (x.ivNo) byNo.set(String(x.ivNo).toUpperCase(), x); }
  const today = ar.todayMs();
  const out = rows
    .filter((r) => user.role === 'op' || r.requestedBy === user.email)
    .reverse()
    .slice(0, 100)
    .map(({ _row, ...r }) => {
      const a = byReq.get(r.ivRequestId) || (r.peakIvNo && byNo.get(String(r.peakIvNo).toUpperCase()));
      if (!a) return r;
      const e = ar.enrich(a, today);
      return { ...r, ar: { state: e.state, dueDate: e.dueDate, paidDate: a.paidDate, daysOverdue: e.daysOverdue, commitDate: a.commitDate, followStatus: a.followStatus } };
    });
  res.status(200).json({ ok: true, uploads: drive.enabled(), requests: out });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const user = await requireUser(req);
    if (req.method === 'POST') return await ((req.body || {}).action === 'legacy_import' ? importLegacy : create)(req, res, user);
    if (req.method === 'PATCH') return await (String((req.body || {}).action || '').startsWith('ar_') ? arUpdate : update)(req, res, user);
    if (req.method === 'GET') return await list(req, res, user);
    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    sendError(res, e);
  }
};

module.exports._test = { validate, alreadyInvoiced };
