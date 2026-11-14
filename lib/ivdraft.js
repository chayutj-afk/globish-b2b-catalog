// INV Draft in PEAK from the request's QT (POST /Invoices/createbyquotation), the moment accounting
// approves an INV request in the app. Accounting then checks and approves it in PEAK; the webhook
// (or the "อนุมัติใน PEAK แล้ว" button) marks the request issued and puts it in AR.
//
//   whole QT in one INV         → PEAK gets the QT's own lines
//   instalment / part of the QT → one line: the QT's main service, "งวด …", the amount Sales asked for
//   billed to another entity     → that entity's PEAK contact (must exist: tax ID + branch, one match)
//   VAT basis, WHT, tags and G012/G013/G014 follow the QT
// Returns { fields } for the InvoiceRequests row.

const peak = require('./peak');
const qtdraft = require('./qtdraft');

const num = (x) => Number(String(x ?? '').replace(/,/g, '')) || 0;
const r2 = (n) => Math.round(n * 100) / 100;
const ymdOf = (dmy) => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(dmy || '')); return m ? `${m[3]}${m[2].padStart(2, '0')}${m[1].padStart(2, '0')}` : ''; };
const bad = (m, status = 409) => Object.assign(new Error(m), { status });

// Part of a QT: the same lines with the INV's student count when that gives the amount asked exactly
// (price per student), otherwise one line of the QT's main service for the amount asked.
function partialLines(q, iv, qtRow, asked, incl, wht, pre, notes) {
  const prods = q.products || [];
  const n = num(iv.students);
  const priced = prods.filter((p) => num(p.price) > 0);
  if (n > 0 && priced.length && priced.every((p) => num(p.quantity) === num(priced[0].quantity))) {
    const lines = prods.map((p) => {
      const price = num(p.price), disc = num(p.discount);
      const base = n * (price - disc) / (incl ? 1.07 : 1);
      return { productCode: p.productCode || undefined, description: p.description, quantity: n, price, discount: disc ? disc.toFixed(2) : undefined, vatType: p.vatType || 3, withHoldingTaxAmount: price > 0 ? wht(base) : '0' };
    });
    const sum = r2(lines.reduce((s, l) => s + l.quantity * (l.price - num(l.discount)), 0));
    if (Math.abs(sum - asked) <= 0.01) { notes.push(`INV บางส่วนของ QT: ${n} คน`); return lines; }
  }
  const main = prods.slice().sort((a, b) => num(b.quantity) * num(b.price) - num(a.quantity) * num(a.price))[0];
  if (!main) throw bad(`QT ${qtRow.peakQtNo} ไม่มีรายการใน PEAK`);
  const label = qtRow.docLang === 'EN' ? `Installment ${iv.installment || ''}`.trim() : `งวด ${iv.installment || ''}`.trim();
  notes.push('INV บางส่วนของ QT: รวมเป็นบรรทัดเดียว ตรวจคำอธิบายใน Draft');
  return [{ productCode: main.productCode || undefined, description: `${main.description || ''}\n${label}`.trim().slice(0, 1000), quantity: 1, price: asked, vatType: main.vatType || 3, withHoldingTaxAmount: wht(pre) }];
}

async function createForIvRequest(iv, qtRow, users) {
  if (!qtRow || !qtRow.peakQtId) throw bad('คำขอนี้ไม่มี QT ในระบบที่ผูกกับ PEAK ให้ออก INV ใน PEAK เอง แล้วใส่เลข INV');
  const q = await peak.getQuotation(qtRow.peakQtId);
  if (!q) throw bad(`ไม่พบ QT ${qtRow.peakQtNo} ใน PEAK`);
  if (Number(q.isVoid) === 1 || /void/i.test(q.status || '')) throw bad(`QT ${qtRow.peakQtNo} ถูกยกเลิกใน PEAK แล้ว`);
  if (/draft/i.test(q.status || '')) throw bad(`QT ${qtRow.peakQtNo} ยังเป็น Draft ใน PEAK อนุมัติ QT ก่อน`);
  const incl = Number(q.taxStatus) === 1;
  const notes = [];
  // QT edited in PEAK since the app last looked: take its current totals / lines first.
  if (await require('./qtlines').refreshRequest(qtRow, q).catch(() => false)) notes.push(`QT ${q.code} ถูกแก้ใน PEAK: อัปเดตยอด QT ในระบบเป็น ${num(incl ? q.netAmount : q.preTaxAmount)}`);

  // Who the INV is for: the QT's customer, or another entity (tax ID / branch on the INV request).
  const sameCustomer = String(iv.taxId || '').replace(/\D/g, '') === String(qtRow.taxId || '').replace(/\D/g, '') && (iv.branch || '00000') === (qtRow.branch || '00000');
  let contactCode;
  if (!sameCustomer) {
    const cs = await peak.findContacts(iv.taxId, iv.branch || '00000');
    if (cs.length !== 1) throw bad(cs.length ? `PEAK มีลูกค้าเลขภาษี ${iv.taxId} ${cs.length} รหัส ปิดรหัสที่ซ้ำก่อน` : `ไม่พบลูกค้า ${iv.company} (${iv.taxId} สาขา ${iv.branch || '00000'}) ใน PEAK สร้างลูกค้าใน PEAK ก่อน แล้วกดอีกครั้ง`);
    contactCode = cs[0].code;
  }

  const rate = Number(String(iv.whtRate ?? qtRow.whtRate ?? '').trim()) || 0;
  const pre = num(iv.amountPreVat), gross = num(iv.amountInclVat) || r2(pre * 1.07);
  const qtTotal = incl ? num(q.netAmount) : num(q.preTaxAmount);
  const asked = incl ? gross : pre;
  const whole = Math.abs(asked - qtTotal) <= 0.01;
  const wht = (base) => (rate > 0 && base > 0 ? r2(base * rate / 100).toFixed(2) : undefined);
  let products;
  if (whole) {
    products = (q.products || []).map((p) => {
      const qty = num(p.quantity), price = num(p.price), disc = num(p.discount);
      const base = qty * (price - disc) / (incl ? 1.07 : 1);
      return { productCode: p.productCode || undefined, description: p.description, quantity: qty, price, discount: disc ? disc.toFixed(2) : undefined, vatType: p.vatType || 3, withHoldingTaxAmount: wht(base) };
    });
  } else {
    products = partialLines(q, iv, qtRow, asked, incl, wht, pre, notes);
  }

  const issuedDate = ymdOf(iv.wantedIssueDate) || peak.stamp().slice(0, 8);
  const body = { PeakInvoices: { quotationId: q.id || qtRow.peakQtId, invoices: {
    issuedDate, dueDate: peak.addDays(issuedDate, Math.max(0, num(iv.creditTermDays))),
    status: 'Draft', taxStatus: incl ? 1 : 0, reference: (q.code || qtRow.peakQtNo || '').slice(0, 32),
    remark: iv.poNo ? `PO: ${iv.poNo}` : undefined,
    tags: [iv.opportunityId || qtRow.opportunityId, qtRow.requestId, iv.ivRequestId].filter(Boolean).slice(0, 10),
    ...(contactCode ? { contactCode } : {}),
    products,
  } } };
  const made = await peak.createInvoiceFromQuotationDraft(body);
  const fields = { status: 'iv_draft', peakIvId: made.id || '', peakIvNo: made.code || '' };

  let d = await peak.getInvoice(made.id).catch(() => null);
  // PEAK's createbyquotation copies the whole QT and ignores the lines sent. For part of a QT, edit
  // the Draft just made to the lines asked for (still Draft; accounting approves it in PEAK).
  if (!whole && d) {
    const okNow = incl ? Math.abs(num(d.netAmount) - gross) <= 0.01 : Math.abs(num(d.preTaxAmount) - pre) <= 0.05;
    if (!okNow) {
      try {
        const lineId = (code) => ((d.products || []).find((p) => String(p.productCode || '') === String(code || '')) || {}).id;
        await peak.editInvoiceDraft(d.code || made.code, {
          issuedDate: body.PeakInvoices.invoices.issuedDate, dueDate: body.PeakInvoices.invoices.dueDate,
          contactCode: contactCode || d.contactCode, taxStatus: incl ? 1 : 0, reference: body.PeakInvoices.invoices.reference,
          remark: body.PeakInvoices.invoices.remark, tags: body.PeakInvoices.invoices.tags,
          products: products.map((p) => ({ ...(lineId(p.productCode) ? { id: lineId(p.productCode) } : {}), ...p })),
        });
        d = await peak.getInvoice(made.id).catch(() => d);
      } catch (e) { notes.push(`แก้ Draft ให้ตรงยอดไม่สำเร็จ (${String(e.message).slice(0, 100)}) แก้จำนวนใน Draft เอง`); }
    }
  }
  if (d && d.documentLink) fields.peakDocLink = d.documentLink;
  if (d) {
    const ok = incl ? Math.abs(num(d.netAmount) - gross) <= 0.01 : Math.abs(num(d.preTaxAmount) - pre) <= 0.05;
    if (!ok) notes.push(`⚠️ ยอดใน PEAK ${incl ? num(d.netAmount) : num(d.preTaxAmount)} ไม่ตรงกับคำขอ ${incl ? gross : pre} ตรวจใน Draft`);
  }
  notes.push(...await qtdraft.classifyDoc(made.id, 102, { ...qtRow, requestedBy: iv.requestedBy || qtRow.requestedBy }, users));
  fields.accountNote = [`INV Draft ${made.code} รอฝ่ายบัญชีอนุมัติใน PEAK`, ...notes].join(' · ').slice(0, 500);
  return { fields };
}

module.exports = { createForIvRequest };
