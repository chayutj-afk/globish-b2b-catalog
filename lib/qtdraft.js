// QT Draft in PEAK straight from the app, the moment accounting approves a request.
//
// Same rules as the scheduled PEAK sync (step 1), so either path gives the same document:
//   contact by 13-digit tax ID + branch (exactly one match, and the same code the request named);
//   none + new-customer details on the request → the contact is created in PEAK first
//   every line has a PEAK service code; PEAK takes the account code from the service
//   taxStatus 1 for VAT-inclusive requests (Requests AG = incl), WHT on the pre-VAT part
//   tags = [Opportunity ID, Request ID]; classification G012 / G013 / G014 like the sync
//   verify amounts and that every line's account code = its service's sellAccount
//
// Requests whose lines carry a sales note or a freebie stay "approved": the scheduled sync writes
// those descriptions (humanizer) and creates the QT on its next run.
//
// Returns { fields } to write on the Requests row, or { defer: reason } to leave it for the sync.

const peak = require('./peak');
const newcontact = require('./newcontact');

const num = (x) => Number(String(x ?? '').replace(/,/g, '')) || 0;
const r2 = (n) => Math.round(n * 100) / 100;
const isoOf = (dmy) => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(dmy || '')); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : ''; };

const G012 = { B2B: 'G012-00002', B2C: 'G012-00001', B2E: 'G012-00001', MaoMao: 'G012-00001', B2S: 'G012-00003' };
const G013 = { B2B: 'G013-00001', B2C: 'G013-00002', B2E: 'G013-00002', MaoMao: 'G013-00005' };

// PEAK problems that a later retry may fix (network, rate limit, PEAK 5xx) vs. ones a person must fix.
const transient = (e) => e && (e.rateLimited || /PEAK 5\d\d|fetch failed|ECONN|ETIMEDOUT|network|aborted/i.test(String(e.message)) || e.status === 503);

async function sellAccounts(products) {
  const out = new Map();
  for (const p of products) {
    if (!p.productId || out.has(p.productId)) continue;
    const s = await peak.getService(p.productId);
    out.set(p.productId, s ? String(s.sellAccount || '') : '');
  }
  return out;
}

// Lines whose account code differs from the service's sellAccount, as Thai text ('' when all match).
async function accountProblems(q) {
  const products = (q && q.products) || [];
  const acc = await sellAccounts(products);
  return products.map((p, i) => ({ p, i, want: acc.get(p.productId) }))
    .filter(({ p, want }) => p.productCode && want && String(p.accountCode) !== want)
    .map(({ p, i, want }) => `บรรทัด ${i + 1} ${p.productCode} ได้ ${p.accountCode} ควรเป็น ${want}`).join(' · ');
}

// G012 / G013 / G014 on a PEAK document (101 QT, 102 INV, 103 RT) from the request's segment and seller.
// Returns notes for accounting; a failed tag never stops the document.
async function classifyDoc(id, type, row, users) {
  const notes = [];
  const perf = (users.find((u) => String(u.email).toLowerCase() === String(row.requestedBy).toLowerCase()) || {}).salesPerf;
  const tags = [['G012', G012[row.segment]], ['G013', G013[row.segment]], ['G014', perf]].filter(([, v]) => v);
  for (const [g, v] of tags) {
    try { await peak.classify(id, type, g, v); } catch (e) { notes.push(`ติด ${g} ไม่สำเร็จ: ${String(e.message).slice(0, 80)}`); }
  }
  if (!perf) notes.push('ไม่ได้ติด Sales Performance (ยังไม่ตั้งใน /users)');
  return notes;
}

async function createForRequest(row, allLines, users) {
  const lines = allLines.filter((l) => l.requestId === row.requestId).sort((a, b) => num(a.line) - num(b.line));
  if (!lines.length) return { defer: 'ไม่พบรายการในคำขอ' };
  const incl = row.vatMode ? row.vatMode === 'incl' : ['B2C', 'B2E', 'MaoMao', 'Others'].includes(row.segment);
  const notes = [];

  // 1. Contact: exactly one PEAK contact with this tax ID + branch. None, and Sales gave the new customer's
  //    details (AL) → create it in PEAK now (accounting has just approved the request).
  let contacts = await peak.findContacts(row.taxId, row.branch || '00000');
  let created = null;
  if (!contacts.length) {
    const nc = newcontact.parse(row.newContact);
    if (!nc) return { fields: { status: 'needs_contact', peakNote: `ไม่พบลูกค้าเลขภาษี ${row.taxId} สาขา ${row.branch || '00000'} ใน PEAK และคำขอไม่มีข้อมูลลูกค้าใหม่ ให้ฝ่ายบัญชีสร้างลูกค้าก่อน แล้วกดสร้างใหม่` } };
    created = await peak.createContact(newcontact.toPeak(nc, row));
    contacts = [{ code: created.code, name: created.name, branchCode: row.branch || '00000' }];
    notes.push(`สร้างลูกค้าใหม่ใน PEAK ${created.code}`);
  }
  if (contacts.length !== 1) {
    return { fields: { status: 'needs_contact', peakNote: `PEAK มีลูกค้าเลขภาษีนี้ ${contacts.length} รหัส (${contacts.map((c) => c.code).join(', ')}) ให้ฝ่ายบัญชีปิดรหัสที่ซ้ำ แล้วกดสร้างใหม่` } };
  }
  const contact = contacts[0];
  if (row.clientCode && row.clientCode !== contact.code) {
    return { fields: { status: 'needs_contact', peakNote: `รหัสลูกค้าในคำขอ (${row.clientCode}) ไม่ตรงกับ PEAK (${contact.code}) สำหรับเลขภาษีนี้` } };
  }
  const who = created || !row.clientCode ? { clientCode: contact.code } : {};
  // A sales note / freebie not yet woven into the description (needs the sync's humanizer step).
  if (lines.some((l) => (l.salesNote || l.freebie) && !l.qtDescription)) {
    return { defer: 'notes', fields: who, notes };
  }

  // 2. Every line needs a PEAK service code.
  const noCode = lines.filter((l) => !l.peakServiceCode);
  if (noCode.length) {
    return { fields: { status: 'needs_service_code', peakNote: `ยังไม่มีรหัสบริการ PEAK: ${noCode.map((l) => `บรรทัด ${l.line} ${l.packageId || l.keyHS || l.description}`.slice(0, 80)).join(' · ')}` } };
  }

  // 3. Build and create the Draft.
  const wht = String(row.whtRate ?? '').trim();
  if (wht === '') notes.push('ไม่ได้ระบุหัก ณ ที่จ่าย ตรวจใน PEAK');
  const qLines = lines.map((l) => ({ ...l, qty: num(l.qty), unitPrice: num(l.unitPrice), discount: num(l.discount), description: l.qtDescription || l.description }));
  const { body } = peak.buildQuotation({
    ...row, clientCode: contact.code, vatMode: incl ? 'incl' : 'excl', whtRate: wht === '' ? 0 : wht,
    wantedQtDate: isoOf(row.wantedQtDate),
  }, qLines, (l) => l.peakServiceCode);
  const qtc = await peak.createQuotationDraft(body);
  const base = { ...who, peakQtNo: qtc.code || '', peakQtId: qtc.id || '' };

  // 4. Verify what PEAK made.
  const q = await peak.getQuotation(qtc.id);
  if (q && q.documentLink) base.peakDocLink = q.documentLink;
  if (q) base.qtSig = peak.quotationSig(q);
  const linesTotal = r2(qLines.reduce((s, l) => s + l.qty * l.unitPrice - l.discount, 0));
  const pre = num(q && q.preTaxAmount), net = num(q && q.netAmount);
  const wantPre = incl ? r2(linesTotal / 1.07) : num(row.totalPreVat);
  const amountOk = incl ? Math.abs(net - (num(row.totalInclVat) || linesTotal)) < 0.01 && Math.abs(pre - wantPre) <= 0.05 : Math.abs(pre - wantPre) < 0.01;
  if (!amountOk) {
    return { fields: { ...base, status: 'qt_error', peakNote: `ยอดใน PEAK ไม่ตรงกับคำขอ: PEAK ก่อน VAT ${pre} / รวม ${net} · คำขอ ก่อน VAT ${wantPre}${incl ? ` / รวม ${num(row.totalInclVat) || linesTotal}` : ''} ตรวจ Draft ${qtc.code}` } };
  }
  const acc = await accountProblems(q);
  if (acc) {
    return { fields: { ...base, status: 'qt_error', peakNote: `รหัสบัญชีไม่ตรงกับบริการ: ${acc} แก้ใน Draft ${qtc.code} แล้วกด "แก้ใน PEAK แล้ว"` } };
  }

  // 5. Classification (a failure here keeps the Draft; it is noted for accounting).
  notes.push(...await classifyDoc(qtc.id, 101, row, users));

  return { fields: { ...base, status: 'qt_draft', peakNote: [`Draft ${qtc.code} รอฝ่ายบัญชีอนุมัติใน PEAK${incl ? ' · ราคารวม VAT' : ''}`, ...notes].join(' · ') } };
}

module.exports = { createForRequest, accountProblems, classifyDoc, transient };
