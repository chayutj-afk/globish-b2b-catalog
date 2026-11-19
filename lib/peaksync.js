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
// Is this row the PEAK document d? By PEAK id when the row has one (PEAK reuses the number of a voided
// document, so two documents can share a code); by number only for rows that never got an id (imported).
const same = (rowId, rowCode, d) => (rowId && d.id ? rowId === d.id : !!d.code && up(rowCode) === up(d.code));
// A company name without its legal form and spacing: "บริษัท วันไทย จำกัด" and "วันไทย" are the same company.
const coreName = (n) => String(n || '').toLowerCase()
  .replace(/บริษัท|ห้างหุ้นส่วนจำกัด|ห้างหุ้นส่วนสามัญ|ห้างหุ้นส่วน|\(มหาชน\)|มหาชน|จำกัด|สำนักงานใหญ่|หจก\.?|บจก\.?|บมจ\.?/g, '')
  .replace(/\b(co|company|ltd|limited|plc|public|inc|corp|corporation|head office)\b\.?/g, '')
  .replace(/[\s.,()\-]/g, '');
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
  const a = invs.find((x) => iv.id && x.peakIvId === iv.id) || invs.find((x) => same(x.peakIvId, x.ivNo, iv));
  const r = ivreqs.find((x) => iv.id && x.peakIvId === iv.id) || ivreqs.find((x) => same(x.peakIvId, x.peakIvNo, iv) && x.status !== 'rejected');
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
    // The customer's branch as PEAK has it now: read when the INV moved to another contact, and on an explicit refresh.
    // The name is taken only when the INV moved to another contact. A PEAK document keeps the name it was issued
    // under, and the API gives only the contact's name today: a contact renamed later (same tax ID, new company
    // name) must not rename the INVs issued under the old name.
    if (iv.contactCode && a.taxId && (f.clientCode || classes)) {
      try {
        const c = (await require('./peak').findContacts(a.taxId)).find((x) => up(x.code) === up(iv.contactCode));
        if (c) {
          // PEAK keeps a company's name without "บริษัท … จำกัด" (the legal form is a separate field there), so the
          // same company must not be "renamed" to its bare name: only a real change of name is taken.
          if (f.clientCode && c.name && c.name !== a.company && coreName(c.name) !== coreName(a.company)) { f.company = c.name; changes.push(`ชื่อลูกค้า "${a.company || '-'}" → "${c.name}"`); }
          const b = c.branchCode || '00000';
          if (b !== String(a.branch || '')) { f.branch = b; changes.push(`สาขา ${a.branch || '-'} → ${b}`); }
          if (r && (f.company || f.branch)) await hub.updateRow('InvoiceRequests', r._row, { ...(f.company ? { company: f.company } : {}), ...(f.branch ? { branch: f.branch } : {}) });
        }
      } catch (e) { changes.push('อ่านชื่อลูกค้าจาก PEAK ไม่ได้ (ลองใหม่ภายหลัง)'); }
    }
    // Same PEAK document, new number (PEAK gives an INV another number when accounting changes it):
    // follow the number, unless another AR row already carries it.
    const newNo = up(iv.code);
    if (iv.id && a.peakIvId === iv.id && newNo && newNo !== up(a.ivNo) && !invs.some((x) => x !== a && up(x.ivNo) === newNo)) {
      const old = a.ivNo;
      f.ivNo = newNo; changes.push(`เลข INV ${old} → ${newNo}`);
      if (r && up(r.peakIvNo) !== newNo) await hub.updateRow('InvoiceRequests', r._row, { peakIvNo: newNo, updatedAt: at });
      const fus = await hub.readTable('FollowUps').catch(() => []);
      for (const x of fus.filter((y) => up(y.ivNo) === up(old))) await hub.updateRow('FollowUps', x._row, { ivNo: newNo });
      f.note = noteAdd(a.note, `เลขเดิม ${old} (PEAK เปลี่ยนเลข ${at})`);
    }
    if (iv.id && a.peakIvId !== iv.id) f.peakIvId = iv.id;
    if (iv.documentLink && iv.documentLink !== a.peakDocLink) { f.peakDocLink = iv.documentLink; if (a.peakDocLink) changes.push('ลิงก์เอกสารชี้ไปใบที่ใช้อยู่ใน PEAK'); }
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
  const q = rts.find((x) => rt.id && x.peakRtId === rt.id) || rts.find((x) => same(x.peakRtId, x.peakRtNo, rt) && x.status !== 'rejected');
  // Our receipt with this number is a different PEAK document (PEAK reused the number of a voided one): not ours.
  if (!q && rt.id && rts.some((x) => x.peakRtId && x.peakRtId !== rt.id && rt.code && up(x.peakRtNo) === up(rt.code) && x.status !== 'rejected')) return null;
  // An INV paid in rounds lists several receipt numbers ("A, B").
  const has = (x) => String(x.rtNo || '').split(/\s*,\s*/).map(up).includes(up(rt.code));
  const ars = rt.code ? invs.filter(has) : [];
  if (!q && !ars.length) return null;
  const at = hub.sheetDateTime();
  const changes = [];
  if (isVoid(rt)) {
    if (q && q.status !== 'rt_void') {
      await hub.updateRow('ReceiptRequests', q._row, { status: 'rt_void', accountNote: noteAdd(q.accountNote, `ใบเสร็จ ${up(rt.code)} ถูก void ใน PEAK`), updatedAt: at });
      changes.push('คำขอใบเสร็จ: ถูก void');
    }
    for (const a of ars) {
      await hub.updateRow('Invoices', a._row, { rtNo: String(a.rtNo || '').split(/\s*,\s*/).filter((x) => x && up(x) !== up(rt.code)).join(', '), note: noteAdd(a.note, `ใบเสร็จ ${up(rt.code)} ถูก void ใน PEAK รอออกใบเสร็จใหม่ (${at})`) });
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
    const seg = segOf(c, row.segment);
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
  // No customer type on the document: the business unit says it (B2C Premium → B2C, B2C Mao Mao → MaoMao).
  if (!c.G012 && c.G013 === 'G013-00002' && !['B2C', 'B2E', 'MaoMao'].includes(current)) return 'B2C';
  if (!c.G012 && c.G013 === 'G013-00005' && current !== 'MaoMao') return 'MaoMao';
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
    for (const row of all.slice(offset, offset + limit)) await (async () => {
      out.done++;
      let c; try { c = await peak.getClassifications(null, 101, row.peakQtNo); } catch (e) { out.errors++; out.log.push(`${row.peakQtNo}: ${String(e.message).slice(0, 80)}`); return; }
      if (!c || !Object.keys(c).length) { out.notFound++; return; }
      const f = {};
      if (json(c) !== (row.classPicks || '')) f.classPicks = json(c);
      const seg = segOf(c, row.segment); if (seg && seg !== row.segment) f.segment = seg;
      const who = await sellerOf(c, pre);
      if (who && who.email !== String(row.requestedBy || '').toLowerCase()) { f.requestedBy = who.email; f.salesName = who.name; }
      if (Object.keys(f).length) { await hub.updateRow('Requests', row._row, f); out.changed++; out.log.push(`${row.peakQtNo}: ${Object.keys(f).join(',')}`); }
    })();
    return out;
  }
  const [invs, ivreqs] = await Promise.all([hub.readTable('Invoices'), hub.readTable('InvoiceRequests')]);
  const all = invs.filter((a) => String(a.ivRequestId).startsWith('LEGACY-') && /2026$/.test(String(a.issueDate || '').trim()));
  out.total = all.length;
  for (const a of all.slice(offset, offset + limit)) await (async () => {
    out.done++;
    let c; try { c = await peak.getClassifications(null, 102, a.ivNo); } catch (e) { out.errors++; out.log.push(`${a.ivNo}: ${String(e.message).slice(0, 80)}`); return; }
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
  })();
  return out;
}

// A seller got their Sales Performance code after the imported INVs were matched: the INVs PEAK files under that
// code (classification already stored, no PEAK read) move to that seller.
async function remapSeller(email, code) {
  email = String(email || '').toLowerCase(); code = String(code || '').trim();
  if (!email || !code) return [];
  const [invs, ivreqs, users] = await Promise.all([hub.readTable('Invoices'), hub.readTable('InvoiceRequests'), hub.readTable('Users')]);
  const u = users.find((x) => String(x.email).toLowerCase() === email);
  const name = (u && u.name) || email;
  const moved = [];
  for (const a of invs) {
    if (!String(a.ivRequestId || '').startsWith('LEGACY-') || String(a.salesEmail || '').toLowerCase() === email) continue;
    let c; try { c = JSON.parse(a.classPicks || '{}'); } catch { continue; }
    if (c.G014 !== code) continue;
    await hub.updateRow('Invoices', a._row, { salesEmail: email, salesName: name });
    const r = ivreqs.find((x) => x.ivRequestId === a.ivRequestId);
    if (r) await hub.updateRow('InvoiceRequests', r._row, { requestedBy: email, salesName: name });
    moved.push(a.ivNo);
  }
  if (moved.length) await hub.log('users', 'seller_remap', code, `${email} · ${moved.length} INV: ${moved.join(', ')}`.slice(0, 480)).catch(() => {});
  return moved;
}

module.exports = { remapSeller, reclassLegacy, syncInvoice, syncReceipt, syncQuotationClasses, same, isApproved, isVoid, _test: { dmyOf, dayMs, coreName, segOf } };
