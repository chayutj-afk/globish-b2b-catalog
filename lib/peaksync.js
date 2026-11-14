// Bring the app in line with a document as it now is in PEAK (accounting edited or voided it there).
// Used by the PEAK webhook (lib/peakhook.js) and by the "↻ อัปเดตจาก PEAK" buttons, so both give the
// same result. Nothing here writes to PEAK.
//
//   INV approved, then edited  → AR row (pre-VAT, issue date, credit term, WHT, customer code, link) + INV request amounts
//   INV voided                 → AR row Cancelled (out of the debt totals), INV request iv_void (QT balance freed)
//   RT voided                  → RT request rt_void, RT No. cleared on the AR row (back to "waiting for receipt")
//   classification (G012/G013/G014) → read back from PEAK and kept as JSON on the row (classes: true)

const hub = require('./hub');
const peak = require('./peak');

const num = (x) => Number(String(x ?? '').replace(/,/g, '')) || 0;
const r2 = (n) => Math.round(n * 100) / 100;
const up = (s) => String(s || '').trim().toUpperCase();
const isVoid = (d) => !!(d && (Number(d.isVoid) === 1 || /void/i.test(d.status || '')));
const isApproved = (d) => !!(d && !isVoid(d) && /approve/i.test(d.status || ''));
const dmyOf = (ymd) => { const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(String(ymd || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
const dayMs = (dmy) => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(dmy || '')); return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) : null; };
const json = (o) => (o && Object.keys(o).length ? JSON.stringify(o) : '');
const noteAdd = (old, t) => [old, t].filter(Boolean).join(' · ').slice(0, 500);

// Who PEAK says sold it (G014 Sales Performance item → Users.salesPerf / ClassRules seller rule).
async function sellerOf(c, pre) {
  const code = c && c.G014;
  if (!code) return null;
  const users = pre ? pre.users : await hub.readTable('Users').catch(() => []);
  let u = users.find((x) => String(x.salesPerf || '').trim() === code);
  if (!u) {
    const rule = (pre ? pre.rules : await hub.readTable('ClassRules').catch(() => [])).find((x) => x.group === 'G014' && x.scope === 'user' && x.item === code);
    if (rule) u = users.find((x) => String(x.email).toLowerCase() === String(rule.key).toLowerCase()) || { email: rule.key, name: '' };
  }
  return u ? { email: String(u.email).toLowerCase(), name: u.name || u.email } : null;
}

async function classesOf(id, type) {
  if (!id) return null;
  try { return await peak.getClassifications(id, type); } catch { return null; }
}

// Returns { changes: [...], ar, req } or null when the INV is not in the app.
async function syncInvoice(iv, { classes = false } = {}) {
  if (!iv || (!iv.id && !iv.code)) return null;
  const [ivreqs, invs] = await Promise.all([hub.readTable('InvoiceRequests'), hub.readTable('Invoices')]);
  const a = invs.find((x) => iv.id && x.peakIvId === iv.id) || invs.find((x) => up(x.ivNo) === up(iv.code));
  const r = ivreqs.find((x) => iv.id && x.peakIvId === iv.id) || ivreqs.find((x) => iv.code && up(x.peakIvNo) === up(iv.code) && x.status !== 'rejected');
  if (!a && !r) return null;
  const at = hub.sheetDateTime();
  const changes = [];
  let classError = false;

  if (isVoid(iv)) {
    if (a && a.docStatus !== 'Cancelled') {
      await hub.updateRow('Invoices', a._row, { docStatus: 'Cancelled', note: noteAdd(a.note, `INV ถูก void ใน PEAK (${at})`) });
      changes.push('AR: ยกเลิก');
    }
    if (r && r.status !== 'iv_void') {
      await hub.updateRow('InvoiceRequests', r._row, { status: 'iv_void', accountNote: noteAdd(r.accountNote, `INV ${up(iv.code)} ถูก void ใน PEAK ยอดนี้กลับไปเป็นยอดคงเหลือของ QT`), updatedAt: at });
      changes.push('คำขอ INV: ถูก void');
    }
    return { changes, ar: a, req: r, void: true };
  }
  if (!isApproved(iv)) return { changes, ar: a, req: r };

  const incl = Number(iv.taxStatus) === 1;
  const pre = r2(num(iv.preTaxAmount) || (incl ? num(iv.netAmount) / 1.07 : 0));
  const iss = dmyOf(iv.issuedDate), due = dmyOf(iv.dueDate);
  const term = iss && due ? Math.round((dayMs(due) - dayMs(iss)) / 86400e3) : null;

  if (a) {
    const f = {};
    if (pre && Math.abs(pre - num(a.preVat)) > 0.009) { f.preVat = pre; changes.push(`ยอดก่อน VAT ${num(a.preVat)} → ${pre}`); }
    if (iss && dayMs(iss) !== dayMs(a.issueDate)) { f.issueDate = iss; changes.push(`วันที่ออก ${a.issueDate || '-'} → ${iss}`); }
    if (term !== null && term >= 0 && term !== num(a.creditTermDays)) { f.creditTermDays = term; changes.push(`เครดิต ${a.creditTermDays || 0} → ${term} วัน`); }
    if (pre && iv.whtAmount !== null && iv.whtAmount !== undefined) {
      const w = Math.round((num(iv.whtAmount) / pre) * 100) / 100;
      const wr = String(a.whtRate || ''), cur = wr.includes('%') || num(wr) >= 1 ? num(wr) / 100 : num(wr);
      if ([0, 0.01, 0.02, 0.03, 0.05].includes(w) && Math.abs(w - cur) > 0.001) { f.whtRate = String(w); changes.push(`หัก ณ ที่จ่าย ${Math.round(cur * 100)}% → ${Math.round(w * 100)}%`); }
    }
    if (iv.contactCode && up(iv.contactCode) !== up(a.clientCode)) { f.clientCode = iv.contactCode; changes.push(`ลูกค้า ${a.clientCode || '-'} → ${iv.contactCode}`); }
    if (iv.id && a.peakIvId !== iv.id) f.peakIvId = iv.id;
    if (iv.documentLink && iv.documentLink !== a.peakDocLink) f.peakDocLink = iv.documentLink;
    if (classes) {
      const c = await classesOf(iv.id, 102);
      if (!c) classError = true;
      else {
        if (json(c) !== (a.classPicks || '')) { f.classPicks = json(c); changes.push('กลุ่มจัดประเภท'); }
        // Imported INVs had their seller guessed from the old sheets; PEAK's Sales Performance is the record.
        const who = String(a.ivRequestId || '').startsWith('LEGACY-') ? await sellerOf(c) : null;
        if (who && who.email !== String(a.salesEmail || '').toLowerCase()) {
          f.salesEmail = who.email; f.salesName = who.name; changes.push(`เซล ${a.salesName || '-'} → ${who.name} (ตาม Sales Performance ใน PEAK)`);
          if (r && String(r.ivRequestId).startsWith('LEGACY-')) await hub.updateRow('InvoiceRequests', r._row, { requestedBy: who.email, salesName: who.name });
        }
      }
    }
    if (Object.keys(f).length) await hub.updateRow('Invoices', a._row, f);
  }
  if (r) {
    const f = {};
    if (pre && Math.abs(pre - num(r.amountPreVat)) > 0.009) f.amountPreVat = pre;
    const net = num(iv.netAmount);
    if (net && num(r.amountInclVat) && Math.abs(net - num(r.amountInclVat)) > 0.009) f.amountInclVat = net;
    if (iv.id && r.peakIvId !== iv.id) f.peakIvId = iv.id;
    if (iv.documentLink && iv.documentLink !== r.peakDocLink) f.peakDocLink = iv.documentLink;
    if (Object.keys(f).length) { f.updatedAt = at; await hub.updateRow('InvoiceRequests', r._row, f); if (!a && f.amountPreVat) changes.push(`ยอดคำขอ INV → ${pre}`); }
  }
  return { changes, ar: a, req: r, classError };
}

// Returns { changes: [...] } or null when the receipt is not in the app.
async function syncReceipt(rt, { classes = false } = {}) {
  if (!rt || (!rt.id && !rt.code)) return null;
  const [rts, invs] = await Promise.all([hub.readTable('ReceiptRequests'), hub.readTable('Invoices')]);
  const q = rts.find((x) => rt.id && x.peakRtId === rt.id) || rts.find((x) => rt.code && up(x.peakRtNo) === up(rt.code) && x.status !== 'rejected');
  const ars = rt.code ? invs.filter((x) => up(x.rtNo) === up(rt.code)) : [];
  if (!q && !ars.length) return null;
  const at = hub.sheetDateTime();
  const changes = [];
  if (isVoid(rt)) {
    if (q && q.status !== 'rt_void') {
      await hub.updateRow('ReceiptRequests', q._row, { status: 'rt_void', accountNote: noteAdd(q.accountNote, `ใบเสร็จ ${up(rt.code)} ถูก void ใน PEAK`), updatedAt: at });
      changes.push('คำขอใบเสร็จ: ถูก void');
    }
    for (const a of ars) {
      await hub.updateRow('Invoices', a._row, { rtNo: '', note: noteAdd(a.note, `ใบเสร็จ ${up(rt.code)} ถูก void ใน PEAK รอออกใบเสร็จใหม่ (${at})`) });
      changes.push(`ลบเลขใบเสร็จออกจาก ${a.ivNo}`);
    }
    return { changes, void: true };
  }
  if (q) {
    const f = {};
    if (rt.documentLink && rt.documentLink !== q.peakDocLink) f.peakDocLink = rt.documentLink;
    if (classes) {
      const c = await classesOf(rt.id || q.peakRtId, 103);
      if (c && json(c) !== (q.classPicks || '')) { f.classPicks = json(c); changes.push('กลุ่มจัดประเภท'); }
    }
    if (Object.keys(f).length) { f.updatedAt = at; await hub.updateRow('ReceiptRequests', q._row, f); }
  }
  return { changes };
}

// QT classification read back onto Requests.classPicks (the next INV from this QT follows it).
async function syncQuotationClasses(row, q) {
  if (!row || !q || !q.id) return false;
  const c = await classesOf(q.id, 101);
  if (!c || !Object.keys(c).length) return false;
  const j = json(c);
  const f = {};
  if (j !== (row.classPicks || '')) f.classPicks = j;
  // Imported QTs got their customer type from the contact code; the QT's own classification is better.
  if (String(row.requestId || '').startsWith('LEGACY-')) {
    const seg = c.G012 === 'G012-00002' || (!c.G012 && c.G013 === 'G013-00001') ? 'B2B' : c.G012 === 'G012-00003' ? 'B2S'
      : c.G012 === 'G012-00001' && !['B2C', 'B2E', 'MaoMao'].includes(row.segment) ? 'B2C' : '';
    if (seg && seg !== row.segment) f.segment = seg;
    const who = await sellerOf(c);
    if (who && who.email !== String(row.requestedBy || '').toLowerCase()) { f.requestedBy = who.email; f.salesName = who.name; }
  }
  if (!Object.keys(f).length) return false;
  await hub.updateRow('Requests', row._row, f);
  Object.assign(row, f);
  return true;
}

// Customer type from a document's classification (G012 customer type, else G013 business unit B2B).
function segOf(c, current) {
  if (!c) return '';
  if (c.G012 === 'G012-00002' || (!c.G012 && c.G013 === 'G013-00001')) return 'B2B';
  if (c.G012 === 'G012-00003') return 'B2S';
  if (c.G012 === 'G012-00001' && !['B2C', 'B2E', 'MaoMao'].includes(current)) return 'B2C';
  return '';
}

// One-off: read the PEAK classification of every imported document (by number, one read each) and fix
// the customer type and seller guessed from the old sheets. kind 'inv' | 'qt', a slice per call.
async function reclassLegacy(kind, offset = 0, limit = 10) {
  const [users, rules] = await Promise.all([hub.readTable('Users'), hub.readTable('ClassRules').catch(() => [])]);
  const pre = { users, rules };
  const out = { kind, offset, done: 0, changed: 0, notFound: 0, errors: 0, log: [] };
  if (kind === 'qt') {
    const all = (await hub.readTable('Requests')).filter((r) => String(r.requestId).startsWith('LEGACY-'));
    out.total = all.length;
    await Promise.all(all.slice(offset, offset + limit).map(async (row) => {
      out.done++;
      let c; try { c = await peak.getClassifications(null, 101, row.peakQtNo); } catch { out.errors++; return; }
      if (!c || !Object.keys(c).length) { out.notFound++; return; }
      const f = {};
      if (json(c) !== (row.classPicks || '')) f.classPicks = json(c);
      const seg = segOf(c, row.segment); if (seg && seg !== row.segment) f.segment = seg;
      const who = await sellerOf(c, pre);
      if (who && who.email !== String(row.requestedBy || '').toLowerCase()) { f.requestedBy = who.email; f.salesName = who.name; }
      if (Object.keys(f).length) { await hub.updateRow('Requests', row._row, f); out.changed++; out.log.push(`${row.peakQtNo}: ${Object.keys(f).join(',')}`); }
    }));
    return out;
  }
  const [invs, ivreqs] = await Promise.all([hub.readTable('Invoices'), hub.readTable('InvoiceRequests')]);
  const all = invs.filter((a) => String(a.ivRequestId).startsWith('LEGACY-') && /2026$/.test(String(a.issueDate || '').trim()));
  out.total = all.length;
  await Promise.all(all.slice(offset, offset + limit).map(async (a) => {
    out.done++;
    let c; try { c = await peak.getClassifications(null, 102, a.ivNo); } catch { out.errors++; return; }
    if (!c || !Object.keys(c).length) { out.notFound++; return; }
    const f = {};
    if (json(c) !== (a.classPicks || '')) f.classPicks = json(c);
    const seg = segOf(c, a.segment); if (seg && seg !== a.segment) f.segment = seg;
    const who = await sellerOf(c, pre);
    if (who && who.email !== String(a.salesEmail || '').toLowerCase()) {
      f.salesEmail = who.email; f.salesName = who.name;
      const r = ivreqs.find((x) => x.ivRequestId === a.ivRequestId);
      if (r) await hub.updateRow('InvoiceRequests', r._row, { requestedBy: who.email, salesName: who.name });
    }
    if (Object.keys(f).length) { await hub.updateRow('Invoices', a._row, f); out.changed++; out.log.push(`${a.ivNo}: ${Object.keys(f).join(',')}`); }
  }));
  return out;
}

module.exports = { reclassLegacy, syncInvoice, syncReceipt, syncQuotationClasses, _test: { dmyOf, dayMs } };
