const { call, ok, db, peak, setPeak, hook, done } = require('./lib.cjs');
const BEE = 'bee@globish.co.th', KOOK = 'kook@globish.co.th', BENZ = 'benz@globish.co.th', LEAD = 'lead@globish.co.th', ACCT = 'acct@globish.co.th', COL = 'col@globish.co.th', OPER = 'oper@globish.co.th', ADMIN = 'admin@globish.co.th';
const file = { name: 'e.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 test').toString('base64') };
const qtBody = (o = {}) => ({ customerType: 'G012-00001', dealType: 'New Logo', company: 'บริษัท ทดสอบ จำกัด', taxId: '0105555555554', branch: '00000', docLang: 'TH', wantedQtDate: '2026-11-16', creditTermDays: 30, opportunityId: 'CRM-OPP-2026-00123', whtRate: '3', customerEmail: 'buyer@example.com', clientCode: 'C14888',
  items: [{ kind: 'service', code: '5136', qty: 2, unitPrice: 15900, discount: 0 }], ...o });
const ivBody = (q, o = {}) => ({ requestId: q.requestId, qtNo: q.peakQtNo, whtRate: '3', company: q.company, taxId: q.taxId, branch: '00000', evidenceType: 'PO จากลูกค้า', poNeeded: 'no', financeContact: 'Fin', financeEmail: 'fin@x.co', financePhone: '0812345678', file,
  invoices: [{ amount: 31800, students: 2, wantedIssueDate: '2026-11-20', creditTermDays: 30, originalDoc: 'no' }], ...o });
const req = (id) => db().Requests.find((r) => r.requestId === id);
const ivr = (id) => db().InvoiceRequests.find((r) => r.ivRequestId === id);
const arRow = (no) => db().Invoices.find((r) => r.ivNo === no);
const seen = (r) => `${r.status}|${r.updatedAt || ''}`;

(async () => {
  console.log('── 1. access control');
  for (const u of ['/api/requests', '/api/invoice-requests', '/api/invoice-requests?view=ar', '/api/users', '/api/users?view=health', '/api/contacts?taxId=0105555555554', '/api/services', '/api/wh-packages', '/api/auth/me']) {
    const [s] = await call(null, 'GET', u); ok(s === 401, `no session → 401 ${u} (${s})`);
  }
  { const [s] = await call(BEE, 'POST', '/api/requests', qtBody(), { Origin: 'https://evil.example' }); ok(s === 403, 'cross-site POST refused ' + s); }
  { const [s] = await call(COL, 'POST', '/api/requests', qtBody()); ok(s === 403, 'collector cannot request a QT ' + s); }
  { const [s] = await call(BEE, 'GET', '/api/users'); ok(s === 403, 'sales cannot list users ' + s); }
  { const [s] = await call(BEE, 'GET', '/api/users?view=health'); ok(s === 403, 'sales cannot read health ' + s); }
  { const [s] = await call(BEE, 'PATCH', '/api/users', { email: BEE, role: 'admin' }); ok(s === 403, 'sales cannot change roles ' + s); }
  { const [s] = await call(ACCT, 'PATCH', '/api/users', { email: BEE, role: 'admin' }); ok(s === 403, 'accounting (op) cannot change roles ' + s); }
  { const [s] = await call(BEE, 'GET', '/api/invoice-requests?view=ar'); ok(s === 403, 'sales without ar_view cannot open AR ' + s); }
  { const [s] = await call(BEE, 'GET', '/api/invoice-requests?view=payments'); ok(s === 403, 'sales cannot list payment notices ' + s); }
  { const [s] = await call(null, 'GET', '/api/users?view=health-cron'); ok(s === 401 || s === 403, 'health-cron without secret refused ' + s); }
  { const r = await fetch('http://localhost:3950/api/users?view=health-cron', { headers: { Authorization: 'Bearer cron123' } }); ok(r.status === 200, 'health-cron with secret ok ' + r.status); }
  { const [s, j] = await call(BEE, 'GET', '/api/invoice-requests'); ok(s === 200 && j.requests.every((x) => x.requestedBy === BEE), `sales sees only own INV requests (${j.requests.length})`); }
  { const [, j] = await call(LEAD, 'GET', '/api/invoice-requests'); const who = new Set(j.requests.map((x) => x.requestedBy)); ok(who.has(BEE) && !who.has(BENZ), 'lead b2b sees team rows: ' + [...who].join(',')); }
  { const [, j] = await call(BENZ, 'GET', '/api/requests'); ok(j.requests.length === 0, 'b2c sales sees no b2b QT'); }
  { const [s] = await call(BENZ, 'GET', '/api/requests?view=qt-live&id=LEGACY-QO-20261100020'); ok(s === 404, 'qt-live of someone else → 404 ' + s); }
  { const [s] = await call(BEE, 'PATCH', '/api/requests', { requestId: 'LEGACY-QO-20261100020', action: 'reject', note: 'x' }); ok(s === 403, 'sales cannot approve/reject ' + s); }
  { const [s] = await call(BEE, 'PATCH', '/api/invoice-requests', { action: 'ar_update', ivNo: 'IV-20261100001', docStatus: 'Cancelled' }); ok(s === 403, 'sales cannot edit AR ' + s); }
  { const [s] = await call(BEE, 'PATCH', '/api/invoice-requests', { action: 'ar_owner', ivNo: 'IV-20261100001', salesEmail: BENZ }); ok(s === 403, 'sales cannot change owner ' + s); }
  { const [s] = await call(BEE, 'PATCH', '/api/invoice-requests', { action: 'ar_reclass' }); ok(s === 403, 'sales cannot run reclass ' + s); }
  { const [s] = await call(ACCT, 'POST', '/api/invoice-requests', { action: 'legacy_import', invoices: [] }); ok(s === 403, 'op cannot run legacy import ' + s); }
  { const r = await fetch('http://localhost:3950/catalog', { headers: { Cookie: require('./lib.cjs').ck(BENZ) } }); const t = await r.text(); ok(!/PKGS|packages\.js/.test(t) || /ไม่มีสิทธิ์|no access/i.test(t), 'b2c sales gets no catalog content (' + t.length + ' bytes)'); }
  { const r = await fetch('http://localhost:3950/request', { redirect: 'manual' }); ok(r.status === 302 && /signin/.test(r.headers.get('location')), 'page without session → signin'); }
  { const r = await fetch('http://localhost:3950/request', { redirect: 'manual', headers: { Cookie: 'gc_session=' + require('./lib.cjs').sign({ email: 'x@gmail.com', exp: Date.now() + 1e6 }) } }); ok(r.status === 302, 'other-domain session refused'); }
  { const r = await fetch('http://localhost:3950/request', { redirect: 'manual', headers: { Cookie: 'gc_session=' + require('./lib.cjs').sign({ email: BEE, exp: Date.now() - 1000 }) } }); ok(r.status === 302, 'expired session refused'); }
  { const tok = require('./lib.cjs').sign({ email: BEE, exp: Date.now() + 1e6 }); const forged = Buffer.from(JSON.stringify({ email: ADMIN, exp: Date.now() + 1e6 })).toString('base64url') + '.' + tok.split('.')[1];
    const r = await fetch('http://localhost:3950/api/users', { headers: { Cookie: 'gc_session=' + forged } }); ok(r.status === 401, 'forged session refused ' + r.status); }

  { const iv = async (w) => (await call(w, 'GET', '/api/invoice-requests?view=ar'))[1];
    const b = await iv(LEAD), c = await iv('leadc@globish.co.th'), a = await iv('leadall@globish.co.th'), f = await iv(COL);
    const nos = (x) => x.invoices.map((r) => r.ivNo).sort().join(',');
    ok(b.invoices.every((r) => r.segment === 'B2B') && b.invoices.length === 4, 'B2B lead sees only B2B debts: ' + nos(b));
    ok(nos(c) === 'IV-20260800009', 'B2C lead sees only B2C debts: ' + nos(c));
    ok(a.invoices.length === 5 && f.invoices.length === 5, 'lead of both units and collectors see every unit');
    ok(b.summary.openCount + c.summary.openCount === f.summary.openCount && Math.abs(b.summary.open + c.summary.open - f.summary.open) < 0.01, `top cards follow the unit: ${b.summary.open} + ${c.summary.open} = ${f.summary.open}`);
    const [s1] = await call('leadc@globish.co.th', 'PATCH', '/api/invoice-requests', { action: 'ar_owner', ivNo: 'IV-20261100001', salesEmail: BENZ }); ok(s1 === 403, 'B2C lead cannot take a B2B INV ' + s1); }
  console.log('── 2. QT (B2C service, VAT incl) → Draft in PEAK → approved by webhook');
  let [s, j] = await call(BENZ, 'POST', '/api/requests', qtBody({ taxId: '123' })); ok(s === 400, 'bad tax id → 400');
  [s, j] = await call(BENZ, 'POST', '/api/requests', qtBody({ items: [{ kind: 'service', code: 'NOPE', qty: 1, unitPrice: 100 }] })); ok(s === 400 && /ไม่พบรหัส/.test(j.error), 'unknown service code refused: ' + j.error);
  [s, j] = await call(BENZ, 'POST', '/api/requests', qtBody({ items: [{ kind: 'keyhs', keyHS: 'x', qty: 1, unitPrice: 100 }] })); ok(s === 400, 'B2C cannot use catalog kinds: ' + j.error);
  [s, j] = await call(BENZ, 'POST', '/api/requests', qtBody({ opportunityId: '' })); ok(s === 400 && /Opportunity/.test(j.error), 'Opp ID required');
  [s, j] = await call(BENZ, 'POST', '/api/requests', qtBody({ company: '=HYPERLINK("http://evil","x")<img src=x onerror=window.__xss=1>' })); ok(s === 200, 'QT created ' + s + ' ' + (j.error || ''));
  const q1 = j.requestId;
  ok(j.vatMode === 'incl' && j.totalInclVat === 31800 && Math.abs(j.total - 29719.63) < 0.01, `VAT-incl totals ${j.total} / ${j.totalInclVat}`);
  { const raw = JSON.parse(require('fs').readFileSync('/tmp/sales-desk-e2e/db.json', 'utf8')).Requests.find((r) => r[0] === q1); ok(String(raw[7]).startsWith("'") || !String(raw[7]).startsWith('='), 'formula in company is neutralised in the sheet: ' + String(raw[7]).slice(0, 12)); }
  [s, j] = await call(BENZ, 'POST', '/api/requests', qtBody({ company: 'x' })); ok(s === 409 && j.duplicate, 'duplicate QT asks first');
  [s, j] = await call(BEE, 'GET', '/api/requests'); ok(!j.requests.some((r) => r.requestId === q1), 'other sales cannot see it');
  // double approve at once
  const r0 = req(q1);
  const both = await Promise.all([call(ACCT, 'PATCH', '/api/requests', { requestId: q1, action: 'approve', seen: seen(r0) }), call(ADMIN, 'PATCH', '/api/requests', { requestId: q1, action: 'approve', seen: seen(r0) })]);
  ok(both.filter((x) => x[0] === 200).length === 1, 'two approvals at once → only one wins: ' + both.map((x) => x[0]).join(','));
  ok(peak().quotations.filter((x) => x.reference === q1).length === 1, 'exactly one QT Draft in PEAK');
  let r = req(q1); const pq = peak().quotations.find((x) => x.reference === q1);
  ok(r.status === 'qt_draft' && r.peakQtNo === pq.code && r.peakQtId === pq.id, `request → qt_draft ${r.peakQtNo} (${r.peakNote.slice(0, 80)})`);
  ok(pq.status === 'Draft' && pq.taxStatus === 1 && pq.contactCode === 'C14888' && pq.netAmount === 31800, 'PEAK Draft: status Draft, VAT incl, contact, net 31,800');
  ok(pq.tags.includes('CRM-OPP-2026-00123') && pq.tags.includes(q1), 'tags = Opp ID + request ID');
  ok(Math.abs(Number(pq.products[0].withHoldingTaxAmount) - 891.59) < 0.01, 'WHT 3% on the pre-VAT part: ' + pq.products[0].withHoldingTaxAmount);
  ok(peak().classes[pq.id] && peak().classes[pq.id].G012 === 'G012-00001' && peak().classes[pq.id].G014 === 'B2C-S003', 'classification on QT: ' + JSON.stringify(peak().classes[pq.id]));
  [s, j] = await call(ACCT, 'PATCH', '/api/requests', { requestId: q1, action: 'qt_approved' }); ok(s === 409 && /Draft/.test(j.error), 'cannot mark approved while PEAK says Draft');
  [s, j] = await call(BENZ, 'POST', '/api/invoice-requests', ivBody(r)); ok(s === 409, 'INV on a Draft QT blocked ' + s + ' ' + j.error);
  [s] = await hook('quotation', {}, 'wrong'); ok(s === 401, 'webhook wrong key → 401');
  [s] = await call(null, 'GET', '/api/users?view=peak-hook&type=quotation'); ok(s === 405 || s === 401, 'webhook GET refused ' + s);
  [s, j] = await hook('quotation', 'not json at all'); ok(s === 200 && j.results.length === 0, 'webhook junk body → 200, nothing done');
  [s, j] = await hook('quotation', { PeakQuotations: { quotations: [{ id: 'zzz', code: 'QO-X', status: 'Approve' }] }, eventType: 'Edit' }); ok(j.results[0] === 'not ours', 'webhook unknown QT ignored');
  setPeak((p) => { p.quotations.find((x) => x.id === pq.id).status = 'Approve'; });
  [s, j] = await hook('quotation', { PeakQuotations: { quotations: [peak().quotations.find((x) => x.id === pq.id)] }, eventType: 'Edit' });
  ok(j.results[0] === 'approved' && req(q1).status === 'qt_approved', 'webhook: QT approved in PEAK → qt_approved');
  [s, j] = await hook('quotation', { PeakQuotations: { quotations: [peak().quotations.find((x) => x.id === pq.id)] }, eventType: 'Edit' });
  ok(!/edited/.test(j.results[0]) && !req(q1).qtEditedAt, 'webhook repeat → no false "edited": ' + j.results[0]);

  console.log('── 3. QT special cases');
  [s, j] = await call(BEE, 'POST', '/api/requests', qtBody({ customerType: 'G012-00002', taxId: '0105540000099', clientCode: '', company: 'ลูกค้าซ้ำ', items: [{ kind: 'keyhs', keyHS: 'Private Class-36-6-Asian, European and Native/36-6-HERO-0-0-0-0-0-0-0-0-0-0-0-0-0', name: 'Private 36', qty: 5, unitPrice: 14500 }] }));
  ok(s === 200, 'B2B Key H.S. QT created ' + (j.error || '')); const q2 = j.requestId;
  if (q2) { [s, j] = await call(ACCT, 'PATCH', '/api/requests', { requestId: q2, action: 'approve' }); ok(req(q2).status === 'needs_contact', 'two PEAK contacts with one tax ID → needs_contact: ' + req(q2).peakNote.slice(0, 70));
    setPeak((p) => { p.contacts = p.contacts.filter((c) => c.code !== 'CD002'); });
    [s, j] = await call(ACCT, 'PATCH', '/api/requests', { requestId: q2, action: 'reopen' }); r = req(q2);
    ok(r.status === 'qt_draft' && r.clientCode === 'CD001', 'reopen after fixing PEAK → Draft, client code filled: ' + r.status + ' ' + r.peakNote.slice(0, 90));
    const p2 = peak().quotations.find((x) => x.reference === q2); ok(p2 && p2.taxStatus === 0 && p2.preTaxAmount === 72500, 'B2B Draft before VAT 72,500');
    ok(peak().classes[p2.id].G014 === 'B2B-S001' && peak().classes[p2.id].G012 === 'G012-00002', 'B2B classification ' + JSON.stringify(peak().classes[p2.id])); }
  // new customer created in PEAK on approval
  [s, j] = await call(BEE, 'POST', '/api/requests', qtBody({ customerType: 'G012-00002', taxId: '0105561000017', clientCode: '', company: 'บริษัท ใหม่ จำกัด', newContact: { name: 'บริษัท ใหม่ จำกัด', address: '1 ถนนสุขุมวิท', subDistrict: 'คลองเตย', district: 'คลองเตย', province: 'กรุงเทพมหานคร', postCode: '10110', contactName: 'คุณเอ', email: 'a@new.co', phone: '0812345678', type: 2 },
    items: [{ kind: 'keyhs', keyHS: 'Private Class-36-6-Asian, European and Native/36-6-HERO-0-0-0-0-0-0-0-0-0-0-0-0-0', name: 'Private 36', qty: 2, unitPrice: 14500 }] }));
  const q3 = j.requestId; ok(s === 200, 'QT for a customer not in PEAK accepted ' + (j.error || ''));
  if (q3) { [s, j] = await call(ACCT, 'PATCH', '/api/requests', { requestId: q3, action: 'approve' }); r = req(q3);
    ok(r.status === 'qt_draft' && /^CN/.test(r.clientCode), 'approve → contact created in PEAK + Draft: ' + r.status + ' ' + r.clientCode + ' · ' + r.peakNote.slice(0, 100)); }
  // PEAK down while approving
  [s, j] = await call(BENZ, 'POST', '/api/requests', qtBody({ items: [{ kind: 'service', code: '5136', qty: 1, unitPrice: 17900 }] })); const q4 = j.requestId;
  setPeak((p) => { p.fail = 'POST /Quotations'; });
  [s, j] = await call(ACCT, 'PATCH', '/api/requests', { requestId: q4, action: 'approve' }); r = req(q4);
  ok(r.status === 'approved' && /ไม่สำเร็จ/.test(r.peakNote), 'PEAK 500 on create → stays approved for retry: ' + r.peakNote.slice(0, 90));
  setPeak((p) => { delete p.fail; });
  [s, j] = await call(ACCT, 'PATCH', '/api/requests', { requestId: q4, action: 'retry' }); ok(req(q4).status === 'qt_draft', 'retry → Draft ' + req(q4).status);
  ok(peak().quotations.filter((x) => x.reference === q4).length === 1, 'retry made exactly one QT');
  // sales note without Claude API → waits for the scheduled sync
  [s, j] = await call(BENZ, 'POST', '/api/requests', qtBody({ items: [{ kind: 'service', code: '5136', qty: 3, unitPrice: 15900, extra: 'เรียนเย็นวันจันทร์' }] })); const q5 = j.requestId;
  [s, j] = await call(ACCT, 'PATCH', '/api/requests', { requestId: q5, action: 'approve' }); r = req(q5);
  ok(r.status === 'approved' && /โน้ตเซล/.test(r.peakNote), 'sales note, no Claude API → left approved for the sync');
  // reject + rebuild
  [s, j] = await call(BENZ, 'POST', '/api/requests', qtBody({ items: [{ kind: 'service', code: '5136', qty: 4, unitPrice: 15900 }] })); const q6 = j.requestId;
  [s] = await call(ACCT, 'PATCH', '/api/requests', { requestId: q6, action: 'reject' }); ok(s === 400, 'reject needs a reason');
  [s] = await call(ACCT, 'PATCH', '/api/requests', { requestId: q6, action: 'reject', note: 'ราคาผิด' }); ok(req(q6).status === 'rejected', 'rejected');
  [s, j] = await call(BEE, 'POST', '/api/requests', qtBody({ replaces: q6, items: [{ kind: 'service', code: '5136', qty: 4, unitPrice: 15000 }] })); ok(s === 400, 'cannot rebuild someone else\'s rejected request');
  [s, j] = await call(BENZ, 'POST', '/api/requests', qtBody({ replaces: q6, items: [{ kind: 'service', code: '5136', qty: 4, unitPrice: 15000 }] })); ok(s === 200, 'owner rebuilds the rejected request');
  [s, j] = await call(BENZ, 'POST', '/api/requests', qtBody({ replaces: q6, items: [{ kind: 'service', code: '5136', qty: 4, unitPrice: 14000 }] })); ok(s === 409, 'rebuilt only once');
  // QT voided in PEAK
  setPeak((p) => { const x = p.quotations.find((y) => y.reference === q4); x.status = 'Void'; x.isVoid = 1; });
  [s, j] = await hook('quotation', { PeakQuotations: { quotations: [peak().quotations.find((y) => y.reference === q4)] }, eventType: 'Void' });
  ok(req(q4).status === 'qt_error', 'webhook: QT voided in PEAK → flagged: ' + j.results[0]);
  [s, j] = await call(ACCT, 'PATCH', '/api/requests', { requestId: q4, action: 'qt_voided' }); r = req(q4);
  ok(r.status === 'qt_draft' && /QO-/.test(r.voidedQts) && r.peakQtNo !== r.voidedQts.split('|')[0], 'redo after void → new Draft, old number kept aside: ' + r.peakQtNo + ' / ' + r.voidedQts);

  console.log('── 4. INV from QT');
  r = req(q1);
  [s, j] = await call(BEE, 'POST', '/api/invoice-requests', ivBody(r)); ok(s === 400 || s === 404, 'other sales cannot bill my QT ' + s);
  [s, j] = await call(BENZ, 'POST', '/api/invoice-requests', ivBody(r, { file: undefined })); ok(s === 400, 'evidence file required');
  [s, j] = await call(BENZ, 'POST', '/api/invoice-requests', ivBody(r, { invoices: [{ amount: 40000, students: 2, wantedIssueDate: '2026-11-20', creditTermDays: 30, originalDoc: 'no' }] })); ok(s === 400 && /เกินยอด/.test(j.error), 'over the QT without a reason refused');
  [s, j] = await call(BENZ, 'POST', '/api/invoice-requests', ivBody(r, { invoices: [{ amount: 15900, students: 1, wantedIssueDate: '2026-11-20', creditTermDays: 30, originalDoc: 'no', label: 'งวด 1' }, { amount: 15900, students: 1, wantedIssueDate: '2026-12-20', creditTermDays: 30, originalDoc: 'yes', originalRecipient: 'คุณเอ', originalAddress: '1 ถนน', label: 'งวด 2' }] }));
  ok(s === 200 && j.ivRequestIds.length === 2 && j.remaining === 0, '2 instalments accepted, nothing left: ' + (j.error || j.remaining));
  const [iv1, iv2] = j.ivRequestIds || [];
  ok(req(q1).status === 'iv_requested', 'QT → iv_requested');
  [s, j] = await call(BENZ, 'POST', '/api/invoice-requests', ivBody(r, { invoices: [{ amount: 100, students: 1, wantedIssueDate: '2026-11-20', creditTermDays: 30, originalDoc: 'no' }] })); ok(s === 409 && /ครบยอด/.test(j.error), 'fully billed QT takes no more INV');
  [s, j] = await call(BENZ, 'PATCH', '/api/invoice-requests', { ivRequestId: iv1, action: 'iv_make' }); ok(s === 403, 'sales cannot make the INV ' + s);
  const mk = await Promise.all([call(ACCT, 'PATCH', '/api/invoice-requests', { ivRequestId: iv1, action: 'iv_make' }), call(ADMIN, 'PATCH', '/api/invoice-requests', { ivRequestId: iv1, action: 'iv_make' })]);
  ok(mk.filter((x) => x[0] === 200).length === 1, 'two "make INV" at once → one wins: ' + mk.map((x) => x[0] + ' ' + (x[1].error || '').slice(0, 40)).join(' | '));
  ok(peak().invoices.filter((x) => (x.tags || []).includes(iv1)).length === 1, 'exactly one INV Draft in PEAK for the request');
  let a1 = ivr(iv1); const pi1 = peak().invoices.find((x) => x.id === a1.peakIvId);
  ok(a1.status === 'iv_draft' && pi1 && pi1.status === 'Draft', 'INV request → iv_draft ' + a1.peakIvNo + ' · ' + a1.accountNote.slice(0, 110));
  ok(pi1 && pi1.netAmount === 15900 && pi1.taxStatus === 1, 'instalment INV is 15,900 incl VAT in PEAK: ' + (pi1 && pi1.netAmount));
  ok(pi1 && peak().classes[pi1.id] && peak().classes[pi1.id].G014 === 'B2C-S003', 'INV classification ' + JSON.stringify(pi1 && peak().classes[pi1.id]));
  [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { ivRequestId: iv1, action: 'iv_check' }); ok(s === 409 && /Draft/.test(j.error), 'check while Draft in PEAK → 409');
  [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { ivRequestId: iv2, action: 'original_sent' }); ok(s === 409, 'original cannot be sent before the INV exists');
  setPeak((p) => { const x = p.invoices.find((y) => y.id === pi1.id); x.status = 'Approve'; x.issuedDate = '20261120'; x.dueDate = '20261220'; });
  [s, j] = await hook('invoice', { PeakInvoices: { invoices: [peak().invoices.find((y) => y.id === pi1.id)] }, eventType: 'Edit' });
  a1 = ivr(iv1); let ar1 = arRow(a1.peakIvNo);
  ok(j.results[0] === 'issued' && a1.status === 'iv_issued' && ar1, 'webhook: INV approved → issued + AR row: ' + j.results[0]);
  ok(ar1 && ar1.issueDate === '20/11/2026' && ar1.salesEmail === BENZ && ar1.peakIvId === pi1.id && Math.abs(Number(ar1.preVat) - 14859.81) < 0.01, 'AR row: date, owner, id, pre-VAT ' + (ar1 && ar1.preVat));
  [s, j] = await hook('invoice', { PeakInvoices: { invoices: [peak().invoices.find((y) => y.id === pi1.id)] }, eventType: 'Edit' });
  ok(db().Invoices.filter((x) => x.ivNo === a1.peakIvNo).length === 1, 'webhook repeat does not duplicate the AR row: ' + j.results[0]);
  // second instalment via the button
  [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { ivRequestId: iv2, action: 'iv_make' }); ok(s === 200, 'INV 2 Draft ' + (j.error || ''));
  let a2 = ivr(iv2); setPeak((p) => { const x = p.invoices.find((y) => y.id === a2.peakIvId); x.status = 'Approve'; x.issuedDate = '20261220'; x.dueDate = '20270119'; });
  [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { ivRequestId: iv2, action: 'iv_check' }); a2 = ivr(iv2);
  ok(s === 200 && a2.status === 'iv_issued' && arRow(a2.peakIvNo), 'button: approved in PEAK → issued + AR row');
  [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { ivRequestId: iv2, action: 'original_sent', trackingNo: 'TH1' }); ok(s === 200 && ivr(iv2).trackingNo === 'TH1', 'original sent with tracking');
  [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { ivRequestId: iv2, action: 'original_sent' }); ok(s === 409, 'original sent twice → 409');

  console.log('── 5. imported (legacy) QT → INV, the real PEAK id');
  const lq = req('LEGACY-QO-20261100020');
  [s, j] = await call(KOOK, 'GET', '/api/requests?view=qt-live&id=LEGACY-QO-20261100020'); ok(s === 200 && j.qt.code === 'QO-20261100020', 'owner opens the live QT of an imported row');
  ok(req('LEGACY-QO-20261100020').peakQtId === 'qL20', 'imported row now carries the real PEAK id');
  [s, j] = await call(KOOK, 'POST', '/api/invoice-requests', ivBody(lq, { invoices: [{ amount: 100000, students: 10, wantedIssueDate: '2026-11-25', creditTermDays: 45, originalDoc: 'no' }] }));
  ok(s === 200, 'INV request on an imported QT ' + (j.error || '')); const liv = (j.ivRequestIds || [])[0];
  [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { ivRequestId: liv, action: 'iv_make' });
  const lp = peak().invoices.find((x) => (x.tags || []).includes(liv));
  ok(s === 200 && lp && lp.referenceCode === 'QO-20261100020', 'INV Draft made from the imported QT: ' + (j.error || j.message || '').slice(0, 100));
  ok(lp && lp.dueDate === '20270109', 'credit term 45 days → due date ' + (lp && lp.dueDate));
  // imported QT whose number also has a voided twin in PEAK
  const lq2 = req('LEGACY-QO-20261100013');
  [s, j] = await call(ACCT, 'POST', '/api/invoice-requests', ivBody(lq2, { opportunityId: 'CRM-OPP-2026-00013', invoices: [{ amount: 50000, students: 5, wantedIssueDate: '2026-11-25', creditTermDays: 30, originalDoc: 'no' }] }));
  ok(s === 200, 'accounting bills an ownerless imported QT ' + (j.error || '')); const liv2 = (j.ivRequestIds || [])[0];
  [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { ivRequestId: liv2, action: 'iv_make' });
  const lp2 = peak().invoices.find((x) => (x.tags || []).includes(liv2));
  ok(s === 200 && lp2 && lp2.preTaxAmount === 50000, 'voided twin skipped: INV built on the live QT (' + (j.error || (lp2 && lp2.preTaxAmount)) + ')');

  console.log('── 6. edits and voids in PEAK flow back');
  // amount + credit term + WHT edited on an issued INV
  setPeak((p) => { const x = p.invoices.find((y) => y.id === pi1.id); x.preTaxAmount = 14000; x.netAmount = 14980; x.dueDate = '20270119'; x.whtAmount = 420; p.classes[pi1.id].G014 = 'B2B-S001'; });
  [s, j] = await hook('invoice', { PeakInvoices: { invoices: [peak().invoices.find((y) => y.id === pi1.id)] }, eventType: 'Edit' });
  ar1 = arRow(a1.peakIvNo);
  ok(Number(ar1.preVat) === 14000 && String(ar1.creditTermDays) === '60' && Number(ar1.whtRate) === 0.03, 'INV edit → AR amount / term / WHT: ' + j.results[0]);
  ok(Number(ivr(iv1).amountPreVat) === 14000, 'INV request amount follows PEAK');
  ok(/B2B-S001/.test(ar1.classPicks) && ar1.salesEmail === BENZ, 'classification stored; app-made INV keeps its owner');
  // legacy INV: seller follows PEAK Sales Performance
  [s, j] = await call(COL, 'PATCH', '/api/invoice-requests', { action: 'ar_refresh', ivNo: 'IV-20261100001' });
  let la = arRow('IV-20261100001');
  ok(s === 200 && la.salesEmail === KOOK && la.peakIvId === 'iL1', 'refresh from PEAK: imported INV owner → PEAK seller, id stored: ' + JSON.stringify(j.changes));
  ok(ivr('LEGACY-IV-20261100001').requestedBy === KOOK, 'the INV request moved to the new owner too');
  [s, j] = await call(KOOK, 'GET', '/api/invoice-requests'); ok(j.requests.some((x) => x.ivRequestId === 'LEGACY-IV-20261100001'), 'new owner sees it under "my requests"');
  [s, j] = await call(BEE, 'GET', '/api/invoice-requests'); ok(!j.requests.some((x) => x.ivRequestId === 'LEGACY-IV-20261100001'), 'old owner no longer sees it');
  [s, j] = await call(COL, 'PATCH', '/api/invoice-requests', { action: 'ar_refresh', ivNo: 'IV-20250500001' }); ok(s === 404, 'refresh of an INV PEAK does not have → clear 404: ' + j.error);
  // INV void
  setPeak((p) => { const x = p.invoices.find((y) => y.id === a2.peakIvId); x.status = 'Void'; x.isVoid = 1; });
  [s, j] = await hook('invoice', { PeakInvoices: { invoices: [peak().invoices.find((y) => y.id === a2.peakIvId)] }, eventType: 'Void' });
  ok(arRow(a2.peakIvNo).docStatus === 'Cancelled' && ivr(iv2).status === 'iv_void', 'webhook: INV void → AR cancelled, request iv_void: ' + j.results[0]);
  [s, j] = await call(BENZ, 'GET', '/api/requests'); const rq1 = j.requests.find((x) => x.requestId === q1);
  ok(Math.abs(rq1.invoicedInclVat - 14980) < 0.01, 'QT balance: the voided INV no longer counts as billed (invoiced incl VAT = ' + rq1.invoicedInclVat + ')');
  [s, j] = await call(BENZ, 'POST', '/api/invoice-requests', ivBody(req(q1), { invoices: [{ amount: 15900, students: 1, wantedIssueDate: '2026-12-22', creditTermDays: 30, originalDoc: 'no' }] }));
  ok(s === 200, 'after the void, the freed amount can be billed again ' + (j.error || '')); const iv3 = (j.ivRequestIds || [])[0];
  [s, j] = await call(ACCT, 'PATCH', '/api/requests', { requestId: q1, action: 'qt_voided' }); ok(s === 409, 'QT with live INVs cannot be redone');
  // QT edited in PEAK
  setPeak((p) => { const x = p.quotations.find((y) => y.id === 'qL20'); x.products[0].price = 11000; x.preTaxAmount = 110000; x.netAmount = 117700; });
  [s, j] = await hook('quotation', { PeakQuotations: { quotations: [peak().quotations.find((y) => y.id === 'qL20')] }, eventType: 'Edit' });
  r = req('LEGACY-QO-20261100020'); ok(Number(r.totalPreVat) === 110000 && r.qtEditedAt, 'webhook: QT edited in PEAK → totals updated + flagged: ' + j.results[0]);
  [s, j] = await call(ACCT, 'PATCH', '/api/requests', { requestId: 'LEGACY-QO-20261100020', action: 'qt_refreshed' }); ok(!req('LEGACY-QO-20261100020').qtEditedAt, 'accounting clears the "edited" flag');

  console.log('── 7. payment → receipt');
  [s, j] = await call(BEE, 'POST', '/api/invoice-requests', { action: 'pay_notice', ivRequestId: iv1, paidDate: '2026-11-13', amount: 14560, paymentMethod: 'Bank Transfer', deliveryChannel: 'email', email: 'fin@x.co', file }); ok(s === 404, 'cannot report payment on someone else\'s INV ' + s);
  [s, j] = await call(BENZ, 'POST', '/api/invoice-requests', { action: 'pay_notice', ivRequestId: iv1, paidDate: '2026-11-13', amount: 14560, paymentMethod: 'Bank Transfer', deliveryChannel: 'email', email: 'fin@x.co' }); ok(s === 400, 'slip required');
  [s, j] = await call(BENZ, 'POST', '/api/invoice-requests', { action: 'pay_notice', ivRequestId: iv1, paidDate: '2030-01-01', amount: 14560, paymentMethod: 'Bank Transfer', deliveryChannel: 'email', email: 'fin@x.co', file }); ok(s === 400, 'future payment date refused');
  [s, j] = await call(BENZ, 'POST', '/api/invoice-requests', { action: 'pay_notice', ivRequestId: iv1, paidDate: '2026-11-13', amount: 14560, paymentMethod: 'Bank Transfer', deliveryChannel: 'email', email: 'fin@x.co', file }); ok(s === 200, 'sales reports payment ' + (j.error || '')); const pn = j.noticeId;
  [s, j] = await call(BENZ, 'POST', '/api/invoice-requests', { action: 'pay_notice', ivRequestId: iv1, paidDate: '2026-11-13', amount: 14560, paymentMethod: 'Bank Transfer', deliveryChannel: 'email', email: 'fin@x.co', file }); ok(s === 409, 'second notice while one is open → 409');
  [s, j] = await call(BENZ, 'PATCH', '/api/invoice-requests', { action: 'pay_confirm', noticeId: pn }); ok(s === 403, 'sales cannot confirm own payment');
  [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'rt_make', ivNo: a1.peakIvNo, paymentMethodCode: 'BNK001', deliveryChannel: 'email', email: 'fin@x.co' }); ok(s === 409, 'no receipt before payment is confirmed');
  [s, j] = await call(COL, 'PATCH', '/api/invoice-requests', { action: 'pay_confirm', noticeId: pn }); ok(s === 200 && arRow(a1.peakIvNo).paidDate === '13/11/2026', 'collector confirms → AR paid');
  [s, j] = await call(COL, 'PATCH', '/api/invoice-requests', { action: 'pay_confirm', noticeId: pn }); ok(s === 409, 'confirm twice → 409');
  [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'rt_make', ivNo: a1.peakIvNo, paymentMethodCode: 'NOPE', deliveryChannel: 'email', email: 'fin@x.co' }); ok(s === 400, 'unknown PEAK account refused');
  const rtm = await Promise.all([call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'rt_make', ivNo: a1.peakIvNo, paymentMethodCode: 'BNK001', deliveryChannel: 'email', email: 'fin@x.co' }), call(ADMIN, 'PATCH', '/api/invoice-requests', { action: 'rt_make', ivNo: a1.peakIvNo, paymentMethodCode: 'BNK001', deliveryChannel: 'email', email: 'fin@x.co' })]);
  ok(rtm.filter((x) => x[0] === 200).length === 1 && peak().receipts.length === 1, `two "make receipt" at once → one receipt in PEAK (${rtm.map((x) => x[0]).join(',')}; PEAK has ${peak().receipts.length})`);
  const rb = peak().lastRtBody; ok(rb && rb.receipts.paidPayments.payments[0].amount === 14560 && rb.receipts.paidPayments.withHoldingTaxAmount === '420.00', 'receipt: paid 14,560 + WHT 420 = INV net 14,980');
  let rt = db().ReceiptRequests.find((x) => x.refDoc === a1.peakIvNo); ok(rt && rt.status === 'rt_draft' && rt.requestedBy === BENZ, 'RT request rt_draft, owned by the seller');
  [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'rt_check', rtRequestId: rt.rtRequestId }); ok(s === 409, 'receipt still Draft in PEAK → 409');
  setPeak((p) => { p.receipts[0].status = 'Approve'; });
  [s, j] = await hook('receipt', { PeakReceipts: { receipts: [peak().receipts[0]] }, eventType: 'Edit' });
  rt = db().ReceiptRequests.find((x) => x.refDoc === a1.peakIvNo); ok(rt.status === 'issued' && arRow(a1.peakIvNo).rtNo === rt.peakRtNo, 'webhook: receipt approved → issued, RT No. on AR: ' + j.results[0]);
  [s, j] = await call(BENZ, 'POST', '/api/invoice-requests', { action: 'edit', docType: 'INV', docNo: a1.peakIvNo, refId: iv1, company: 'x', detail: 'แก้ที่อยู่ลูกค้า' }); ok(s === 409, 'INV with a receipt cannot be edited');
  setPeak((p) => { p.receipts[0].status = 'Void'; p.receipts[0].isVoid = 1; });
  [s, j] = await hook('receipt', { PeakReceipts: { receipts: [peak().receipts[0]] }, eventType: 'Void' });
  rt = db().ReceiptRequests.find((x) => x.refDoc === a1.peakIvNo); ok(rt.status === 'rt_void' && !arRow(a1.peakIvNo).rtNo, 'webhook: receipt void → rt_void, AR waits for a new receipt');
  [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'rt_make', ivNo: a1.peakIvNo, paymentMethodCode: 'BNK001', deliveryChannel: 'email', email: 'fin@x.co' }); ok(s === 200, 'a new receipt can be made after the void ' + (j.error || ''));
  // payment recorded in PEAK (PaidPayment)
  const lpi = peak().invoices.find((x) => (x.tags || []).includes(liv));
  setPeak((p) => { const x = p.invoices.find((y) => y.id === lpi.id); x.status = 'Approve'; x.issuedDate = '20261125'; });
  await hook('invoice', { PeakInvoices: { invoices: [peak().invoices.find((y) => y.id === lpi.id)] }, eventType: 'Edit' });
  setPeak((p) => { const x = p.invoices.find((y) => y.id === lpi.id); x.remainAmount = 0; x.paidPayments = [{ paymentDate: '20261114', paymentTotal: 117700 }]; });
  [s, j] = await hook('invoice', { PeakInvoices: { invoices: [peak().invoices.find((y) => y.id === lpi.id)] }, eventType: 'PaidPayment' });
  ok(j.results[0] === 'paid' && arRow(lpi.code).paidDate === '14/11/2026', 'webhook: payment in PEAK → AR paid: ' + j.results[0]);
  // legacy INV paid directly on /ar, then receipt
  [s, j] = await call(COL, 'PATCH', '/api/invoice-requests', { action: 'ar_update', ivNo: 'IV-20261000030', paidDate: '2026-11-14', paidAmount: 21400, paymentMethod: 'Bank Transfer' }); ok(s === 400 && /สลิป/.test(j.error), 'recording a payment needs a slip');
  [s, j] = await call(COL, 'PATCH', '/api/invoice-requests', { action: 'ar_update', ivNo: 'IV-20261000030', paidDate: '2026-11-14', paidAmount: 21400, paymentMethod: 'Bank Transfer', file, deliveryChannel: 'email', email: 'fin@x.co' }); ok(s === 200, 'collector records payment on an imported INV ' + (j.error || ''));
  [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'rt_make', ivNo: 'IV-20261000030', paymentMethodCode: 'BNK001', deliveryChannel: 'email', email: 'fin@x.co' });
  ok(s === 200, 'receipt Draft for an imported INV (no stored PEAK id): ' + (j.error || j.peakRtNo));

  console.log('── 8. AR actions, edit requests, B2C receipt');
  [s, j] = await call(COL, 'PATCH', '/api/invoice-requests', { action: 'ar_followup', ivNo: 'IV-20260800009', channel: 'x', result: 'y' }); ok(s === 400, 'follow-up needs a valid channel');
  [s, j] = await call(COL, 'GET', '/api/invoice-requests?view=ar'); ok(s === 200 && j.invoices.length >= 5 && j.summary, 'collector opens AR: ' + j.invoices.length + ' rows');
  const ch = j.lists.channels[0], fo = j.lists.follow[0];
  [s, j] = await call(COL, 'PATCH', '/api/invoice-requests', { action: 'ar_followup', ivNo: 'IV-20260800009', channel: ch, result: fo, nextActionDate: '2026-11-20', note: 'โทรแล้ว' }); ok(s === 200 && db().FollowUps.length === 1, 'follow-up saved');
  [s, j] = await call(LEAD, 'PATCH', '/api/invoice-requests', { action: 'ar_owner', ivNo: 'IV-20260800009', salesEmail: BEE }); ok(s === 403, 'lead cannot move an INV outside the team ' + s);
  [s, j] = await call(LEAD, 'PATCH', '/api/invoice-requests', { action: 'ar_owner', ivNo: 'IV-20250500001', salesEmail: BEE }); ok(s === 200 && arRow('IV-20250500001').salesEmail === BEE, 'lead gives an ownerless INV to a team member');
  [s, j] = await call(COL, 'PATCH', '/api/invoice-requests', { action: 'ar_owner', ivNo: 'IV-20250500001', salesEmail: 'x@gmail.com' }); ok(s === 400, 'owner must be @globish.co.th');
  [s, j] = await call(LEAD, 'GET', '/api/invoice-requests?view=ar'); ok(s === 200 && j.canOwner, 'lead can open AR (view only)');
  [s, j] = await call(LEAD, 'PATCH', '/api/invoice-requests', { action: 'ar_update', ivNo: 'IV-20250500001', docStatus: 'Cancelled' }); ok(s === 403, 'lead cannot edit AR');
  [s, j] = await call(BEE, 'POST', '/api/invoice-requests', { action: 'edit', docType: 'RT', docNo: 'RT-20261100001', detail: 'แก้ชื่อ' }); ok(s === 400, 'receipts cannot be edited');
  const q3r = req(q3);
  if (q3r && q3r.peakQtNo) {
    setPeak((p) => { p.quotations.find((x) => x.id === q3r.peakQtId).status = 'Approve'; });
    await call(ACCT, 'PATCH', '/api/requests', { requestId: q3, action: 'qt_approved' });
    [s, j] = await call(BEE, 'POST', '/api/invoice-requests', { action: 'edit', docType: 'QT', docNo: q3r.peakQtNo, refId: q3, company: q3r.company, detail: 'ปรับจำนวนเป็น 3 คน' }); ok(s === 200, 'sales asks to edit a QT ' + (j.error || '')); const ed = j.editId;
    [s, j] = await call(BEE, 'POST', '/api/invoice-requests', ivBody(req(q3), { invoices: [{ amount: 29000, students: 2, wantedIssueDate: '2026-11-20', creditTermDays: 30, originalDoc: 'no' }] })); ok(s === 409 && /คำขอแก้ไข/.test(j.error), 'no INV while a QT edit is pending');
    setPeak((p) => { const x = p.quotations.find((y) => y.id === q3r.peakQtId); x.products[0].quantity = 3; x.preTaxAmount = 43500; x.netAmount = 46545; });
    [s, j] = await call(BEE, 'PATCH', '/api/invoice-requests', { action: 'edit_done', editId: ed }); ok(s === 403, 'sales cannot close an edit');
    [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'edit_done', editId: ed }); ok(s === 200 && Number(req(q3).totalPreVat) === 43500, 'edit done → totals read from PEAK: ' + req(q3).totalPreVat);
    ok(db().RequestLines.filter((l) => l.requestId === q3).some((l) => String(l.qty) === '3'), 'request lines follow the edited QT');
  }
  [s, j] = await call(BENZ, 'POST', '/api/invoice-requests', { action: 'receipt', customerType: 'G012-00001', docKind: 'person', billName: 'คุณทดสอบ', taxId: '1999999990011', address: 'กทม', whStudent: 'S1', packages: '5136', price: 17900, discount: 0, whtRate: '0', paidDate: '2026-11-14', deliveryChannel: 'sales', docLang: 'TH', file });
  ok(s === 200, 'B2C receipt request ' + (j.error || '')); const rtq = j.rtRequestId;
  [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'rt_issued', rtRequestId: rtq, peakRtNo: 'RT-20261100077', peakDocLink: 'http://evil.example/x' }); ok(s === 400, 'receipt link must be a PEAK link');
  [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'rt_issued', rtRequestId: rtq, peakRtNo: 'RT-20261100077', peakDocLink: 'https://doc.peakaccount.com/r?x=1' }); ok(s === 200, 'receipt issued ' + (j.error || ''));
  [s, j] = await call(BENZ, 'POST', '/api/invoice-requests', { action: 'receipt', customerType: 'G012-00001', docKind: 'person', billName: 'คุณสอง', taxId: '1999999990029', address: 'กทม', whStudent: 'S2', packages: '5136', price: 9900, discount: 0, whtRate: '0', paidDate: '2026-11-14', deliveryChannel: 'sales', docLang: 'TH', file }); const rtq2 = j.rtRequestId;
  [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'rt_issued', rtRequestId: rtq2, peakRtNo: 'RT-20261100077', peakDocLink: 'https://doc.peakaccount.com/r?x=2' }); ok(s === 409, 'same receipt number on two requests refused: ' + (j.error || s));

  console.log('── 9. users');
  [s, j] = await call(ADMIN, 'GET', '/api/users'); ok(s === 200 && j.users.length >= 8, 'admin lists users');
  [s, j] = await call(ADMIN, 'PATCH', '/api/users', { action: 'add_user', email: 'new.sale@gmail.com', name: 'X', role: 'sales', team: 'b2b' }); ok(s === 400, 'add user outside the company domain refused ' + s);
  [s, j] = await call(ADMIN, 'PATCH', '/api/users', { action: 'add_user', email: 'new.sale@globish.co.th', name: 'New (Sale)', role: 'sales', team: 'b2b', classItems: { G014: 'B2B-S002' } }); ok(s === 200, 'admin adds a user ' + (j.error || ''));
  [s, j] = await call(ADMIN, 'PATCH', '/api/users', { action: 'add_user', email: 'new.sale@globish.co.th', name: 'New', role: 'sales', team: 'b2b' }); ok(s === 409 || s === 400, 'adding the same user twice refused ' + s);
  [s, j] = await call('new.sale@globish.co.th', 'GET', '/api/auth/me'); ok(j.user && j.user.role === 'sales' && j.user.team === 'b2b', 'pre-added user gets role/team on first visit');
  // a brand-new person: signed in, but nothing works until an admin activates the account
  const NEWB = 'brand.new@globish.co.th';
  [s, j] = await call(NEWB, 'GET', '/api/auth/me'); ok(s === 200 && j.user.role === 'pending' && j.user.perms.length === 0, 'new person: role pending, no permissions');
  for (const [m, u, b] of [['GET', '/api/requests'], ['GET', '/api/invoice-requests'], ['GET', '/api/invoice-requests?view=ar'], ['GET', '/api/contacts?taxId=0105555555554'], ['GET', '/api/services'], ['GET', '/api/users'], ['POST', '/api/requests', qtBody()], ['POST', '/api/invoice-requests', { action: 'receipt' }], ['PATCH', '/api/requests', { requestId: 'x', action: 'approve' }]]) {
    [s, j] = await call(NEWB, m, u, b); ok(s === 403, `pending user blocked: ${m} ${u} → ${s}`); }
  { const r = await fetch('http://localhost:3950/catalog', { redirect: 'manual', headers: { Cookie: require('./lib.cjs').ck(NEWB) } }); ok(r.status === 302 && r.headers.get('location') === '/', 'pending user: catalog sends them to the waiting page'); }
  [s, j] = await call(ACCT, 'PATCH', '/api/users', { email: NEWB, role: 'sales' }); ok(s === 403, 'accounting cannot activate (admin only)');
  await require('../../lib/users'); // (row is made at sign-in; here the admin adds it)
  [s, j] = await call(ADMIN, 'PATCH', '/api/users', { action: 'add_user', email: NEWB, name: 'Brand New', role: 'sales', team: 'b2c' }); ok(s === 200, 'admin activates by adding the person ' + (j.error || ''));
  [s, j] = await call(NEWB, 'GET', '/api/requests'); ok(s === 200 && j.requests.length === 0, 'activated: can use the app, sees only own requests');
  [s, j] = await call(ADMIN, 'PATCH', '/api/users', { email: NEWB, role: 'pending' }); ok(s === 200, 'admin can switch a person off again');
  [s, j] = await call(NEWB, 'GET', '/api/requests'); ok(s === 403 && j.pending === true, 'switched off: blocked again');
  [s, j] = await call(ADMIN, 'PATCH', '/api/users', { email: NEWB, role: 'sales', team: 'b2c' }); [s, j] = await call(NEWB, 'GET', '/api/auth/me'); ok(j.user.role === 'sales' && j.user.team === 'b2c', 're-activated with role + team');
  [s, j] = await call(ADMIN, 'GET', '/api/auth/me'); ok(j.user.role === 'admin', 'fixed admin is never pending');
  [s, j] = await call(ADMIN, 'PATCH', '/api/users', { email: ADMIN, role: 'sales' }); ok(s >= 400, 'fixed admin cannot be demoted ' + s);
  [s, j] = await call(ADMIN, 'PATCH', '/api/users', { email: BEE, role: 'superuser' }); ok(s === 400, 'unknown role refused');
  [s, j] = await call(ADMIN, 'GET', '/api/users?view=health'); ok(s === 200 && Array.isArray(j.items || (j.health && j.health.items)), 'health view loads');
  console.log('── 10. webhook with only an id (partial payload) and number reuse');
  [s, j] = await call(BENZ, 'POST', '/api/requests', qtBody({ items: [{ kind: 'service', code: '5136', qty: 7, unitPrice: 15900 }] })); const q9 = j.requestId;
  await call(ACCT, 'PATCH', '/api/requests', { requestId: q9, action: 'approve' }); const r9 = req(q9);
  setPeak((p) => { p.quotations.find((x) => x.id === r9.peakQtId).status = 'Approve'; });
  [s, j] = await hook('quotation', { PeakQuotations: { quotations: [{ id: r9.peakQtId }] }, eventType: 'Edit' });
  ok(j.results[0] === 'approved' && req(q9).status === 'qt_approved', 'id-only event: QT approved (read from PEAK): ' + j.results[0]);
  [s, j] = await call(BENZ, 'GET', '/api/requests?view=qt-live&id=' + q9); ok(s === 200 && !j.changed && !req(q9).qtEditedAt, 'no false "edited in PEAK" after an id-only event');
  [s, j] = await call(BENZ, 'POST', '/api/invoice-requests', ivBody(req(q9), { invoices: [{ amount: 111300, students: 7, wantedIssueDate: '2026-11-20', creditTermDays: 30, originalDoc: 'no' }] })); const iv9 = (j.ivRequestIds || [])[0];
  await call(ACCT, 'PATCH', '/api/invoice-requests', { ivRequestId: iv9, action: 'iv_make' }); const a9 = ivr(iv9);
  setPeak((p) => { const x = p.invoices.find((y) => y.id === a9.peakIvId); x.status = 'Approve'; x.issuedDate = '20261120'; });
  [s, j] = await hook('invoice', { PeakInvoices: { invoices: [{ id: a9.peakIvId }] }, eventType: 'Edit' });
  ok(j.results[0] === 'issued' && arRow(a9.peakIvNo) && arRow(a9.peakIvNo).ivNo, 'id-only event: INV issued with its number: ' + j.results[0]);
  ok(db().Invoices.every((x) => x.ivNo), 'no AR row without an INV number');
  // another PEAK document reusing our INV number is voided: ours must stay
  [s, j] = await hook('invoice', { PeakInvoices: { invoices: [{ id: 'twin-x', code: a9.peakIvNo, status: 'Void', isVoid: 1, products: [] }] }, eventType: 'Void' });
  ok(arRow(a9.peakIvNo).docStatus === 'Active' && ivr(iv9).status === 'iv_issued', 'void of a twin with the same number ignored: ' + j.results[0]);
  setPeak((p) => { const x = p.invoices.find((y) => y.id === a9.peakIvId); x.status = 'Void'; x.isVoid = 1; });
  [s, j] = await hook('invoice', { PeakInvoices: { invoices: [{ id: a9.peakIvId }] }, eventType: 'Void' });
  ok(arRow(a9.peakIvNo).docStatus === 'Cancelled', 'id-only Void event applied: ' + j.results[0]);
  [s, j] = await call(BENZ, 'PATCH', '/api/invoice-requests', { ivRequestId: iv9, action: 'original', originalDoc: 'yes', recipient: 'a', address: 'b' }); ok(s === 409, 'no original for a voided INV');
  [s, j] = await call(ACCT, 'PATCH', '/api/requests', { requestId: q9, action: 'qt_voided' }); ok(s === 200, 'QT whose only INV was voided can be redone ' + (j.error || ''));
  done();
})().catch((e) => { console.error('CRASH', e); done(); });
