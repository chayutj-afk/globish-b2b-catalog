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
  [s, j] = await call(BENZ, 'POST', '/api/invoice-requests', ivBody(r, { opportunityId: 'CRM-LEAD-2026-14563' })); ok(s === 400 && /convert/.test(j.error || ''), 'INV with a Lead ID is refused: the lead must be converted first ' + s + ' ' + (j.error || '').slice(0, 60));
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
  // PEAK: INV voided and issued again under the same number. PEAK shows the voided one as "Draft" with no void flag.
  //  a) imported row (no PEAK id, link of the old document)
  setPeak((p) => { p.invoices.push({ id: 'old800', code: 'IV-20260800009', status: 'Draft', contactCode: 'CB01561', issuedDate: '20260809', dueDate: '20260908', preTaxAmount: 14859.81, netAmount: 15900, taxStatus: 0, documentLink: 'https://doc.peakaccount.com/invoice?emi=old800' },
    { id: 'new800', code: 'IV-20260800009', status: 'Approve', contactCode: 'CB01561-1', issuedDate: '20260809', dueDate: '20260908', preTaxAmount: 14859.81, netAmount: 15900, taxStatus: 0, documentLink: 'https://doc.peakaccount.com/invoice?emi=new800' }); });
  [s, j] = await call(COL, 'PATCH', '/api/invoice-requests', { action: 'ar_refresh', ivNo: 'IV-20260800009' });
  ok(s === 200 && arRow('IV-20260800009').peakIvId === 'new800' && /new800/.test(arRow('IV-20260800009').peakDocLink) && arRow('IV-20260800009').clientCode === 'CB01561-1', 're-issued under the same number (imported row): row follows the approved document: ' + JSON.stringify(j.changes));
  //  b) row that holds the id of the document that was then voided
  setPeak((p) => { const o = p.invoices.find((x) => x.id === 'iL1'); o.status = 'Draft'; p.invoices.push({ ...o, id: 'iL1b', status: 'Approve', documentLink: 'https://doc.peakaccount.com/invoice?emi=iL1b' }); });
  [s, j] = await call(COL, 'PATCH', '/api/invoice-requests', { action: 'ar_refresh', ivNo: 'IV-20261100001' });
  ok(s === 200 && arRow('IV-20261100001').peakIvId === 'iL1b' && /iL1b/.test(arRow('IV-20261100001').peakDocLink) && arRow('IV-20261100001').docStatus === 'Active' && j.changes.some((c) => /ออกใหม่/.test(c)), 're-issued under the same number (row had the old id): moved to the approved document: ' + JSON.stringify(j.changes));
  ok(ivr('LEGACY-IV-20261100001').peakIvId === 'iL1b', 'the INV request follows too');
  // re-issued for another contact (same tax ID, branch 00001, corrected name): name and branch follow PEAK
  { const tax = arRow('IV-20261100001').taxId;
    setPeak((p) => { p.contacts.push({ id: 'cBr', code: 'CBR01', name: 'บริษัท ลูกค้าใหม่ จำกัด สาขา 00001', taxNumber: tax, branchCode: '00001', type: 1 }); p.invoices.find((x) => x.id === 'iL1b').contactCode = 'CBR01'; });
    [s, j] = await call(COL, 'PATCH', '/api/invoice-requests', { action: 'ar_refresh', ivNo: 'IV-20261100001' });
    const w = arRow('IV-20261100001');
    ok(s === 200 && w.clientCode === 'CBR01' && w.company === 'บริษัท ลูกค้าใหม่ จำกัด สาขา 00001' && String(w.branch).replace(/^'/, '') === '00001', 'customer name and branch follow the contact of the re-issued INV: ' + JSON.stringify([w.clientCode, w.company, w.branch, j.changes])); }
  setPeak((p) => { p.invoices = p.invoices.filter((x) => x.id !== 'iL1'); const n = p.invoices.find((x) => x.id === 'iL1b'); n.id = 'iL1'; });
  await call(COL, 'PATCH', '/api/invoice-requests', { action: 'ar_refresh', ivNo: 'IV-20261100001' });
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
  ok(arRow(lpi.code).commitDate === '14/11/2026' && arRow(lpi.code).commitAtPaid, 'payment moves the commit date to the paid date, promise kept: ' + arRow(lpi.code).commitAtPaid);
  // legacy INV paid directly on /ar, then receipt
  [s, j] = await call(COL, 'PATCH', '/api/invoice-requests', { action: 'ar_update', ivNo: 'IV-20261000030', paidDate: '2026-11-14', paidAmount: 21400, paymentMethod: 'Bank Transfer' }); ok(s === 400 && /สลิป/.test(j.error), 'recording a payment needs a slip');
  [s, j] = await call(COL, 'PATCH', '/api/invoice-requests', { action: 'ar_update', ivNo: 'IV-20261000030', paidDate: '2026-11-14', paidAmount: 21400, paymentMethod: 'Bank Transfer', file, deliveryChannel: 'email', email: 'fin@x.co' }); ok(s === 200, 'collector records payment on an imported INV ' + (j.error || ''));
  [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'rt_make', ivNo: 'IV-20261000030', paymentMethodCode: 'BNK001', deliveryChannel: 'email', email: 'fin@x.co' });
  ok(s === 200, 'receipt Draft for an imported INV (no stored PEAK id): ' + (j.error || j.peakRtNo));
  ok(arRow('IV-20261000030').commitDate === '14/11/2026', 'payment on /ar moves the commit date too');

  // old imported INVs waiting for a check: read from PEAK, then save on confirm
  setPeak((p) => { p.invoices.push({ id: 'old25', code: 'IV-20250500001', status: 'Approve', contactCode: 'C1', issuedDate: '20250501', dueDate: '20250531', preTaxAmount: 15000, netAmount: 16050, remainAmount: 0, taxStatus: 0,
    documentLink: 'https://doc.peakaccount.com/invoice?emi=old25', paidPayments: [{ paymentDate: '20250520', paymentTotal: 16050, payments: [{ paymentMethodCode: 'BNK001', amount: 15600 }] }] }); });
  [s, j] = await call(BEE, 'PATCH', '/api/invoice-requests', { action: 'ar_peakcheck', ivNos: ['IV-20250500001'] }); ok(s === 403, 'sales cannot run the PEAK check');
  [s, j] = await call(COL, 'PATCH', '/api/invoice-requests', { action: 'ar_peakcheck', ivNos: ['IV-20250500001', 'IV-20260800009'] });
  ok(s === 200 && j.results[0].result === 'paid' && j.results[0].paidDate === '20/05/2025' && j.results[0].amount === 15600 && j.results[1].result === 'settled' && !arRow('IV-20250500001').paidDate, 'PEAK check reads only: ' + JSON.stringify(j.results.map((r) => r.result)));
  [s, j] = await call(COL, 'PATCH', '/api/invoice-requests', { action: 'ar_peakcheck', ivNos: ['IV-20250500001'], apply: true });
  let oc = arRow('IV-20250500001');
  ok(s === 200 && oc.paidDate === '20/05/2025' && Number(oc.paidAmount) === 15600 && oc.commitDate === '20/05/2025' && !oc.followStatus && oc.peakIvId === 'old25', 'PEAK check saved: paid on the PEAK date, off the waiting list');
  // any open INV can be checked: still open → nothing written; remain 0 with no payment on the INV → reported, not written
  { const before = JSON.stringify(arRow('IV-20260800009'));
    [s, j] = await call(COL, 'PATCH', '/api/invoice-requests', { action: 'ar_peakcheck', ivNos: ['IV-20260800009'], apply: true });
    ok(s === 200 && j.results[0].result === 'settled' && JSON.stringify(arRow('IV-20260800009')) === before, 'remain 0 without a payment is reported, not written ' + JSON.stringify(j.results[0].result));
    setPeak((p) => { const iv = p.invoices.find((x) => x.code === 'IV-20260800009' && x.status === 'Approve'); iv.remainAmount = iv.netAmount || 1000; iv.netAmount = iv.remainAmount; });
    [s, j] = await call(COL, 'PATCH', '/api/invoice-requests', { action: 'ar_peakcheck', ivNos: ['IV-20260800009'], apply: true });
    ok(s === 200 && j.results[0].result === 'open' && JSON.stringify(arRow('IV-20260800009')) === before, 'open INV checked with PEAK: still open, row untouched ' + JSON.stringify(j.results[0].result)); }
  // paid INV with no receipt number: the receipt PEAK already issued from it is found by reference
  setPeak((p) => { p.receipts.push({ id: 'rOld', code: '202505A00009', status: 'Approve', isVoid: 0, reference: 'IV-20250500001', documentLink: 'https://doc.peakaccount.com/receipt?emi=rOld' }); });
  [s, j] = await call(BEE, 'PATCH', '/api/invoice-requests', { action: 'rt_find', ivNos: ['IV-20250500001'] }); ok(s === 403, 'sales cannot run the receipt lookup');
  [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'rt_find', ivNos: ['IV-20250500001', 'IV-20260800009'] });
  ok(s === 200 && j.results[0].result === 'found' && arRow('IV-20250500001').rtNo === '202505A00009' && j.results[1].result === 'skip', 'receipt already in PEAK → number recorded, unpaid INV skipped: ' + JSON.stringify(j.results.map((r) => r.result)));
  { const rr = db().ReceiptRequests.filter((x) => x.refDoc === 'IV-20250500001');
    ok(rr.length === 1 && rr[0].status === 'issued' && rr[0].peakRtNo === '202505A00009' && /receipt\?emi=rOld/.test(rr[0].peakDocLink), 'the receipt found in PEAK is listed under the receipt requests ' + JSON.stringify(rr.map((x) => [x.status, x.peakRtNo])));
    [s, j] = await call(ACCT, 'GET', '/api/invoice-requests?view=receipts'); const mine = (j.requests || []).find((x) => x.refDoc === 'IV-20250500001');
    ok(!!mine, 'and the receipts list returns it'); }
  // the old book (issued before 2026) is reported apart from the current receivables
  setPeak((p) => { p.invoices.push({ id: 'old24', code: 'IV-20240900099', status: 'Approve', issuedDate: '20240901', dueDate: '20241001', preTaxAmount: 1000, netAmount: 1070, remainAmount: 1070, taxStatus: 0, paidPayments: [] }); });
  {
    const hubm = require('../../lib/hub'); process.env.HUB_MODE = 'mock'; process.env.HUB_MOCK_FILE = '/tmp/sales-desk-e2e/db.json';
    await hubm.appendRows('Invoices', [{ ivNo: 'IV-20240900099', issueDate: '01/09/2024', segment: 'B2B', company: 'ค้างเก่า 2024', taxId: '0105540000099', preVat: '1000', creditTermDays: '30', whtRate: '0', docStatus: 'Active', source: 'legacy' }]);
  }
  [s, j] = await call(COL, 'GET', '/api/invoice-requests?view=ar&brief=1'); const sOld = j.summary;
  ok(s === 200 && sOld.oldCount === 1 && sOld.old === 1070, 'old book counted on its own: ' + sOld.oldCount + ' / ' + sOld.old);
  [s, j] = await call(COL, 'GET', '/api/invoice-requests?view=ar&drill=open'); ok(!j.rows.some((r) => r.ivNo === 'IV-20240900099') && Math.abs(j.total - sOld.open) < 0.01, 'current receivables leave the old book out');
  [s, j] = await call(COL, 'GET', '/api/invoice-requests?view=ar&drill=old'); ok(j.rows.length === 1 && j.total === 1070, 'the old book has its own list');
  console.log('── 8. AR actions, edit requests, B2C receipt');
  [s, j] = await call(COL, 'PATCH', '/api/invoice-requests', { action: 'ar_followup', ivNo: 'IV-20260800009', channel: 'x', result: 'y' }); ok(s === 400, 'follow-up needs a valid channel');
  [s, j] = await call(COL, 'GET', '/api/invoice-requests?view=ar'); ok(s === 200 && j.invoices.length >= 5 && j.summary, 'collector opens AR: ' + j.invoices.length + ' rows');
  const ch = j.lists.channels[0], fo = j.lists.follow[1], rem = j.lists.remind;
  ok(j.lists.follow[0] === rem && !!rem, 'the reminder is a follow-up result');
  [s, j] = await call(COL, 'PATCH', '/api/invoice-requests', { action: 'ar_followup', ivNo: 'IV-20260800009', channel: ch, result: fo, nextActionDate: '2026-11-20', note: 'โทรแล้ว' }); ok(s === 400 && (db().FollowUps || []).length === 0, 'follow-up on an open INV needs a commit date that has not passed');
  [s, j] = await call(COL, 'PATCH', '/api/invoice-requests', { action: 'ar_followup', ivNo: 'IV-20260800009', channel: ch, result: fo, commitDate: '2020-01-01', note: 'x' }); ok(s === 400, 'a commit date in the past is refused');
  [s, j] = await call(COL, 'PATCH', '/api/invoice-requests', { action: 'ar_followup', ivNo: 'IV-20260800009', channel: ch, result: fo, commitDate: '2030-12-27', nextActionDate: '2026-11-20', note: 'โทรแล้ว' }); ok(s === 200 && db().FollowUps.length === 1, 'follow-up saved');
  ok(db().FollowUps[0].commitDate === '27/12/2030', 'the follow-up keeps the pay date given at that contact: ' + db().FollowUps[0].commitDate);
  // PEAK receipt dated ahead: the INV stays open, waiting for the money; accounting confirms with the real date
  { const was = { ...arRow('IV-20260800009') };
    setPeak((p) => { const iv = p.invoices.find((x) => x.code === 'IV-20260800009' && x.status === 'Approve'); iv.remainAmount = 0; iv.paidPayments = [{ paymentDate: '20270115', paymentTotal: iv.netAmount, payments: [{ paymentMethodCode: 'BNK001', amount: iv.netAmount }] }]; });
    [s, j] = await call(COL, 'PATCH', '/api/invoice-requests', { action: 'ar_peakcheck', ivNos: ['IV-20260800009'], apply: true });
    let w = arRow('IV-20260800009');
    ok(s === 200 && j.results[0].result === 'await' && !w.paidDate && w.rtDate === '15/01/2027' && w.commitDate === '15/01/2027', 'receipt dated ahead in PEAK: kept open, waiting for the money ' + JSON.stringify([j.results[0].result, w.paidDate, w.rtDate, w.commitDate]));
    [s, j] = await call(COL, 'GET', '/api/invoice-requests?view=ar');
    const wr = j.invoices.find((x) => x.ivNo === 'IV-20260800009');
    ok(wr && wr.awaitCash && wr.state !== 'Paid' && j.summary.checks.awaitCashCount >= 1, 'waiting row is an open receivable with its flag');
    [s, j] = await call(COL, 'PATCH', '/api/invoice-requests', { action: 'ar_update', ivNo: 'IV-20260800009', paidDate: '2027-01-15', paidAmount: 1000, paymentMethod: 'Bank Transfer', file: { name: 's.png', type: 'image/png', data: 'aGk=' } });
    ok(s === 400, 'money-in date cannot be ahead of today ' + s);
    [s, j] = await call(COL, 'PATCH', '/api/invoice-requests', { action: 'ar_update', ivNo: 'IV-20260800009', rtDate: '2026-11-10', commitDate: '2027-01-20' });
    w = arRow('IV-20260800009');
    ok(s === 200 && w.rtDate === '10/11/2026' && w.commitDate === '20/01/2027' && !w.paidDate, 'receipt / cheque date recorded without a paid date');
    // back to how it was, for the checks below
    setPeak((p) => { const iv = p.invoices.find((x) => x.code === 'IV-20260800009' && x.status === 'Approve'); iv.remainAmount = iv.netAmount; iv.paidPayments = []; });
    await call(COL, 'PATCH', '/api/invoice-requests', { action: 'ar_update', ivNo: 'IV-20260800009', rtDate: '', commitDate: was.commitDate, note: was.note || '' }); }
  [s, j] = await call(COL, 'GET', '/api/invoice-requests?view=ar&brief=1'); ok(s === 200 && j.summary.checks && j.summary.forecast.weeks.length === 10 && j.summary.cash[0].current && !j.invoices, 'brief AR summary: checks, 10 forecast weeks, cash incl. this week');
  [s, j] = await call(COL, 'PATCH', '/api/invoice-requests', { action: 'ar_update', ivNo: 'IV-20260800009', commitDate: '' }); ok(s === 400, 'the commit date cannot be cleared');
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
  console.log('── 9b. PEAK Client-Token replaced elsewhere (another server instance) while requests run');
  for (let round = 0; round < 3; round++) {
    setPeak((p) => { p.tok = (p.tok || 0) + 1; }); // someone else got a newer token: ours is now invalid
    const rs = await Promise.all([call(ACCT, 'GET', '/api/invoice-requests?view=pay-methods'), call(ACCT, 'GET', '/api/invoice-requests?view=pay-methods'), call(BENZ, 'GET', '/api/contacts?taxId=0105555555554'), call(BENZ, 'GET', '/api/requests?view=classes'), call(ACCT, 'GET', '/api/requests?view=qt-live&id=LEGACY-QO-20261100020')]);
    ok(rs.every((x) => x[0] === 200), `round ${round + 1}: 5 requests at once after the token was replaced → ${rs.map((x) => x[0]).join(',')}` + (rs.find((x) => x[0] !== 200) ? ' ' + (rs.find((x) => x[0] !== 200)[1].error || '') : ''));
  }
  console.log('── 9c. Google Chat: rooms and tags');
  { const msgs = peak().chat || []; const main = msgs.filter((m) => m.room === 'MAIN').map((m) => m.text), fin = msgs.filter((m) => m.room === 'FIN').map((m) => m.text);
    const has = (list, re) => list.some((t) => re.test(t.replace(/\*/g, '').replace(/\n/g, ' · ')));
    ok(has(main, /↩️ ตีกลับคำขอ QT .*<users\/108000000000000000001>/s), 'QT sent back → main room, salesperson tagged');
    ok(has(main, /✅ QT QO-\d+ อนุมัติแล้ว .*<users\/108000000000000000001>/), 'QT approved → main room, salesperson tagged');
    ok(has(main, /✅ INV IV-\d+ ออกแล้ว .*<users\/108000000000000000001>/), 'INV issued → main room, salesperson tagged');
    ok(has(main, /✅ ยืนยันเงินเข้า .*<users\/108000000000000000001>/), 'payment confirmed → tagged');
    ok(has(main, /🧾 ใบเสร็จ RT-\d+ ออกแล้ว .*<users\/108000000000000000001>/), 'receipt issued → tagged');
    ok(has(main, /INV IV-\d+ ออกแล้ว · ซิสเม็กซ์ · (kook|Kawinthida \(Kookkai\)) · /) && !has(main, /<users\/>|<users\/undefined>|\u0001/), 'someone who has not signed in yet: plain name, no broken tag');
    await call(BENZ, 'POST', '/api/requests', qtBody({ company: '<users/all> จำกัด', items: [{ kind: 'service', code: '5136', qty: 9, unitPrice: 100 }] }));
    ok((peak().chat || []).some((m) => /users\/all  จำกัด/.test(m.text)) && !(peak().chat || []).some((m) => /<users\/all>/.test(m.text)), 'a tag typed into a company name is not turned into a real mention');
    ok((peak().chat || []).every((m) => (m.text.split('\n').length <= 9 && m.text.length < 330 && !/ · /.test(m.text) && /^\*[^\n]+\*\n/.test(m.text)) || /สุขภาพข้อมูล/.test(m.text)), 'every message: bold head, one short part per line, no bullets');
    ok(!has(main, /👤 ผู้ใช้ใหม่|หยุดบันทึกแท็บ|อัปเดตไม่สำเร็จ|แนบไฟล์ .* ไม่สำเร็จ/), 'new-user and system alerts never go to the main room');
    ok(has(main, /📝 ขอ QT ใหม่ · .* · Chattraya \(Benz\)/), 'new QT request → main room');
    ok(!has(main, /Draft/) && !has(fin, /สร้าง Draft/), 'nothing is posted when a Draft is made in PEAK (only when it is approved)');
    ok(has(fin, /QT QO-\d+ ถูกแก้ใน PEAK/) && has(fin, /INV IV-\d+ .*ถูกแก้ใน PEAK/) && has(fin, /INV IV-\d+ .*ถูก void ใน PEAK/) && has(fin, /ใบเสร็จ RT-\d+ ถูก void/) && has(fin, /PEAK บันทึกรับเงิน IV-/), 'edits / voids / payments made in PEAK → finance room');
    ok(!has(main, /ถูกแก้ใน PEAK|ถูก void ใน PEAK|PEAK บันทึกรับเงิน/), '…and not the main room');
    console.log(`   main room ${main.length} messages · finance room ${fin.length}`); }
  { // a new person signs in → finance room
    process.env.HUB_MODE = 'mock'; process.env.HUB_MOCK_FILE = '/tmp/sales-desk-e2e/db.json';
    const r = await fetch('http://localhost:3950/api/users?view=health-cron', { headers: { Authorization: 'Bearer cron123' } }); ok(r.status === 200, 'daily health digest runs');
    const fin = (peak().chat || []).filter((m) => m.room === 'FIN').map((m) => m.text); ok(fin.some((t) => /สุขภาพข้อมูล/.test(t)), 'health digest → finance room'); }
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
  console.log('── 11. QT made outside the app is brought in from PEAK');
  setPeak((p) => { p.quotations.push({ id: 'qOld1', code: 'QO-20240700117', status: 'Approve', isVoid: 0, contactCode: 'CB01142', contactName: 'วันไทย', issuedDate: '20240715', taxStatus: 0, preTaxAmount: 1068000, netAmount: 1142760, documentLink: 'https://doc.peakaccount.com/quotation?emi=qOld1', products: [{ id: 'L1', productCode: 'B2B-PVT', description: 'License', quantity: 120, price: 8900, discount: 0, vatType: 3 }] }); });
  const ext = { requestId: '', qtNo: 'QO-20240700117', offReason: 'QT quota ปี 2024', segment: 'B2B', customerType: 'B2B', opportunityId: 'CRM-OPP-2026-00077', company: 'วันไทย', taxId: '0105540000099' };
  [s, j] = await call(BENZ, 'POST', '/api/invoice-requests', ivBody({}, { ...ext, invoices: [{ amount: 89000, students: 10, wantedIssueDate: '2026-11-20', creditTermDays: 30, originalDoc: 'no' }, { amount: 89000, students: 10, wantedIssueDate: '2026-11-20', creditTermDays: 30, originalDoc: 'no' }] }));
  ok(s === 200, 'INV request from a QT outside the app ' + (j.error || '')); const exIds = db().InvoiceRequests.filter((x) => x.qtNo === 'QO-20240700117').map((x) => x.ivRequestId);
  ok(exIds.length === 2 && !ivr(exIds[0]).requestId, 'two requests, not linked to a QT yet');
  [s, j] = await call(BENZ, 'PATCH', '/api/invoice-requests', { action: 'qt_adopt', ivRequestId: exIds[0], preview: true }); ok(s === 403, 'sales cannot bring a QT in');
  [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'qt_adopt', ivRequestId: exIds[0], preview: true });
  ok(s === 200 && j.preview.total === 1068000 && j.preview.waiting === 178000 && j.preview.waitingCount === 2 && !j.preview.exists, 'preview reads the QT from PEAK: ' + JSON.stringify(j.preview || j));
  ok(!db().Requests.some((x) => x.peakQtNo === 'QO-20240700117'), 'preview writes nothing');
  [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'qt_adopt', ivRequestId: exIds[0], openingInvoiced: 2000000 }); ok(s === 400, 'opening amount above the QT refused');
  [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'qt_adopt', ivRequestId: exIds[0], openingInvoiced: 801000 });
  const ad = db().Requests.find((x) => x.peakQtNo === 'QO-20240700117');
  ok(s === 200 && j.linked === 2 && j.left === 89000 && ad && ad.status === 'qt_approved' && ad.peakQtId === 'qOld1' && String(ad.openingInvoiced) === '801000', 'QT added with its opening amount: ' + JSON.stringify(j));
  ok(exIds.every((x) => ivr(x).requestId === ad.requestId), 'both INV requests linked to the QT');
  ok(ad.requestedBy === ivr(exIds[0]).requestedBy && ad.createdAt.startsWith('15/07/2024'), 'owner and QT date kept');
  [s, j] = await call(BENZ, 'GET', '/api/requests'); const adSeen = (j.requests || []).find((x) => x.requestId === ad.requestId);
  ok(adSeen && adSeen.invoicedPreVat === 979000, "sales sees the QT with what was invoiced: " + (adSeen && adSeen.invoicedPreVat));
  [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'qt_adopt', ivRequestId: exIds[1] }); ok(s === 409, 'a linked request cannot be brought in twice');
  [s, j] = await call(BENZ, 'POST', '/api/invoice-requests', ivBody(ad, { opportunityId: 'CRM-OPP-2026-00077', invoices: [{ amount: 100000, students: 10, wantedIssueDate: '2026-11-20', creditTermDays: 30, originalDoc: 'no' }] }));
  ok(s === 400 && /เกินยอด QT/.test(j.error || ''), 'balance check counts the opening amount: ' + (j.error || s));
  [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { ivRequestId: exIds[0], action: 'iv_make' });
  ok(s === 200 && j.peakIvNo, 'INV Draft made from the adopted QT: ' + (j.error || j.peakIvNo));
  console.log('── 12. INV made by hand in PEAK: the number alone is enough');
  setPeak((p) => { p.invoices.push({ id: 'ivH1', code: 'IV-20261100901', status: 'Approve', isVoid: 0, preTaxAmount: 89000, netAmount: 95230, issuedDate: '20261118', dueDate: '20261218', documentLink: 'https://doc.peakaccount.com/invoice?emi=ivH1', products: [] },
    { id: 'ivH2', code: 'IV-20261100902', status: 'Approve', isVoid: 0, preTaxAmount: 50000, netAmount: 53500, issuedDate: '20261118', documentLink: 'https://doc.peakaccount.com/invoice?emi=ivH2', products: [] },
    { id: 'ivH3', code: 'IV-20261100903', status: 'Draft', isVoid: 0, preTaxAmount: 89000, netAmount: 95230, issuedDate: '20261118', documentLink: 'https://doc.peakaccount.com/invoice?emi=ivH3', products: [] }); });
  const hand = (no) => call(ACCT, 'PATCH', '/api/invoice-requests', { ivRequestId: exIds[1], action: 'issued', peakIvNo: no });
  [s, j] = await hand('IV-20261100999'); ok(s === 404, 'number not in PEAK refused: ' + (j.error || s));
  [s, j] = await hand('IV-20261100903'); ok(s === 409 && /ยังไม่อนุมัติ/.test(j.error || ''), 'Draft INV refused');
  [s, j] = await hand('IV-20261100902'); ok(s === 409 && /ไม่ตรงกับคำขอ/.test(j.error || ''), 'INV with another amount refused (wrong card)');
  ok(ivr(exIds[1]).status === 'new', 'request untouched after the refusals');
  [s, j] = await hand('IV-20261100901'); const hr = ivr(exIds[1]), ha = arRow('IV-20261100901');
  ok(s === 200 && hr.status === 'iv_issued' && hr.peakIvNo === 'IV-20261100901' && /emi=ivH1/.test(hr.peakDocLink || ''), 'issued from the number: link read from PEAK ' + (j.error || ''));
  ok(ha && ha.issueDate === '18/11/2026' && ha.peakIvId === 'ivH1', 'AR row with the PEAK issue date and id: ' + (ha && ha.issueDate + ' ' + ha.peakIvId));
  console.log('── 13. two requests of the same amount from one QT: a Draft never lands on the sibling');
  setPeak((p) => { p.quotations.push({ id: 'qOld2', code: 'QO-20240700200', status: 'Approve', isVoid: 0, contactCode: 'CB01142', issuedDate: '20240715', taxStatus: 0, preTaxAmount: 890000, netAmount: 952300, documentLink: 'https://doc.peakaccount.com/quotation?emi=qOld2', products: [{ id: 'L1', productCode: 'B2B-PVT', description: 'License', quantity: 100, price: 8900, discount: 0, vatType: 3 }] }); });
  const one = { amount: 17800, students: 2, wantedIssueDate: '2026-11-20', creditTermDays: 30, originalDoc: 'no' };
  [s, j] = await call(BENZ, 'POST', '/api/invoice-requests', ivBody({}, { ...ext, qtNo: 'QO-20240700200', note: 'Students: A / B', invoices: [one, one, one], confirmDuplicate: true }));
  ok(s === 200, 'three requests of the same amount ' + (j.error || '')); const tw = db().InvoiceRequests.filter((x) => x.qtNo === 'QO-20240700200').map((x) => x.ivRequestId);
  await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'qt_adopt', ivRequestId: tw[0], openingInvoiced: 0 });
  // the app is in the middle of creating the Draft for the first request when PEAK's event arrives
  setPeak((p) => { p.invoices.push({ id: 'ivRace', code: 'IV-20261100950', status: 'Draft', isVoid: 0, referenceCode: 'QO-20240700200', referenceId: 'qOld2', preTaxAmount: 17800, netAmount: 19046, issuedDate: '20261120', documentLink: 'https://doc.peakaccount.com/invoice?emi=ivRace', products: [] }); });
  { const hubm = require('../../lib/hub'); process.env.HUB_MODE = 'mock'; process.env.HUB_MOCK_FILE = '/tmp/sales-desk-e2e/db.json';
    await hubm.scope({ method: 'POST' }, async () => { const r = (await hubm.readTable('InvoiceRequests')).find((x) => x.ivRequestId === tw[0]); await hubm.updateRow('InvoiceRequests', r._row, { status: 'iv_creating' }); }); }
  [s, j] = await hook('invoice', { PeakInvoices: { invoices: [peak().invoices.find((x) => x.id === 'ivRace')] }, eventType: 'Create' });
  ok(/draft: not matched/.test(j.results[0]) && ivr(tw[1]).status === 'new' && !ivr(tw[1]).peakIvId && ivr(tw[2]).status === 'new', 'Draft event does not attach to a sibling: ' + j.results[0]);
  // approved by hand while several requests fit → nobody is guessed
  setPeak((p) => { p.invoices.find((x) => x.id === 'ivRace').status = 'Approve'; });
  [s, j] = await hook('invoice', { PeakInvoices: { invoices: [peak().invoices.find((x) => x.id === 'ivRace')] }, eventType: 'Edit' });
  ok(j.results[0] === 'ambiguous' && tw.every((x) => !ivr(x).peakIvNo), 'approved INV that fits three requests is left for accounting: ' + j.results[0]);
  // stuck request without a Draft id → accounting can put it back (after 2 minutes)
  [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { ivRequestId: tw[0], action: 'iv_reset' }); ok(s === 409 && /รอ 2 นาที/.test(j.error || ''), 'reset refused while the Draft may still be in the making');
  { const hubm = require('../../lib/hub'); await hubm.scope({ method: 'POST' }, async () => { const r = (await hubm.readTable('InvoiceRequests')).find((x) => x.ivRequestId === tw[0]); await hubm.updateRow('InvoiceRequests', r._row, { updatedAt: '17/11/2026 08:00' }); }); }
  [s, j] = await call(BENZ, 'PATCH', '/api/invoice-requests', { ivRequestId: tw[0], action: 'iv_reset' }); ok(s === 403 || s === 404, 'sales cannot reset');
  [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { ivRequestId: tw[0], action: 'iv_reset' }); ok(s === 200 && ivr(tw[0]).status === 'new', 'stuck request back in the queue ' + (j.error || ''));
  // Draft made by the app is tied to its own request by id; its event changes nobody else
  [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { ivRequestId: tw[0], action: 'iv_make' }); const mine = ivr(tw[0]);
  ok(s === 200 && mine.status === 'iv_draft' && mine.peakIvId, 'Draft made for the first request ' + (j.error || ''));
  [s, j] = await hook('invoice', { PeakInvoices: { invoices: [{ id: mine.peakIvId }] }, eventType: 'Edit' });
  ok(ivr(tw[1]).status === 'new' && ivr(tw[2]).status === 'new' && ivr(tw[0]).peakIvId === mine.peakIvId, 'its own event leaves the siblings alone: ' + j.results[0]);
  [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { ivRequestId: tw[0], action: 'iv_make' }); ok(s === 409, 'pressing create again is refused (no second INV)');
  console.log('── 14. PEAK gives an approved INV another number (same document)');
  setPeak((p) => { const x = p.invoices.find((y) => y.id === mine.peakIvId); x.status = 'Approve'; });
  [s, j] = await hook('invoice', { PeakInvoices: { invoices: [{ id: mine.peakIvId }] }, eventType: 'Edit' }); const no1 = ivr(tw[0]).peakIvNo;
  ok(j.results[0] === 'issued' && arRow(no1), 'issued under its first number ' + no1);
  setPeak((p) => { const x = p.invoices.find((y) => y.id === mine.peakIvId); x.code = 'IV-20261100977'; });
  [s, j] = await hook('invoice', { PeakInvoices: { invoices: [{ id: mine.peakIvId }] }, eventType: 'Edit' });
  ok(arRow('IV-20261100977') && !arRow(no1) && ivr(tw[0]).peakIvNo === 'IV-20261100977' && db().Invoices.filter((x) => x.peakIvId === mine.peakIvId).length === 1, 'AR row and request follow the new number, no second row: ' + j.results[0]);
  console.log('── 15. approval event that arrives before PEAK shows the INV as approved');
  [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { ivRequestId: tw[1], action: 'iv_make' }); const lag = ivr(tw[1]);
  ok(s === 200 && lag.status === 'iv_draft', 'second request: Draft made ' + (j.error || ''));
  const stale = { ...peak().invoices.find((y) => y.id === lag.peakIvId) }; // the payload still says Draft…
  setPeak((p) => { const x = p.invoices.find((y) => y.id === lag.peakIvId); x.status = 'Approve'; }); // …while PEAK is approved a moment later
  [s, j] = await hook('invoice', { PeakInvoices: { invoices: [stale] }, eventType: 'Edit' });
  ok(/issued/.test(j.results[0]) && ivr(tw[1]).status === 'iv_issued' && arRow(ivr(tw[1]).peakIvNo), 'looked again and issued it, no "check status" needed: ' + j.results[0]);
  console.log('── 16. the PEAK link of a Draft is for accounting only (QT, INV, receipt)');
  [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { ivRequestId: tw[2], action: 'iv_make' }); ok(s === 200 && ivr(tw[2]).peakDocLink, 'third request: Draft with a link in the sheet ' + (j.error || ''));
  const seeIv = async (who) => ((await call(who, 'GET', '/api/invoice-requests'))[1].requests || []);
  let mineIv = await seeIv(BENZ);
  ok(mineIv.find((x) => x.ivRequestId === tw[2]).peakDocLink === '' && mineIv.find((x) => x.ivRequestId === tw[2]).peakIvNo, 'sales: INV Draft shows its number, no link');
  ok(mineIv.find((x) => x.ivRequestId === tw[1]).peakDocLink, 'sales: issued INV has its link');
  ok((await seeIv(ACCT)).find((x) => x.ivRequestId === tw[2]).peakDocLink, 'accounting: Draft link kept');
  const allQ = db().Requests, dq = allQ.find((x) => x.status === 'qt_draft' && x.peakDocLink && x.requestedBy === 'benz@globish.co.th'), aq = allQ.find((x) => x.status === 'qt_approved' && x.peakDocLink && x.requestedBy === 'benz@globish.co.th');
  [s, j] = await call(BENZ, 'GET', '/api/requests'); const qs = j.requests || [];
  ok(!dq || qs.find((x) => x.requestId === dq.requestId).peakDocLink === '', 'sales: QT Draft has no link' + (dq ? '' : ' (no QT Draft in the data: skipped)'));
  ok(!aq || !!qs.find((x) => x.requestId === aq.requestId).peakDocLink, 'sales: approved QT has its link' + (aq ? '' : ' (skipped)'));
  const rtRows = db().ReceiptRequests; [s, j] = await call(BENZ, 'GET', '/api/invoice-requests?view=receipts');
  ok((j.requests || []).every((x) => x.status === 'issued' || !x.peakDocLink), 'sales: receipts that are not issued carry no link (' + rtRows.filter((x) => x.status !== 'issued' && x.peakDocLink).length + ' Draft receipts with a link in the sheet)');
  console.log('── 17. QT approval event that arrives before PEAK shows the QT as approved');
  [s, j] = await call(BENZ, 'POST', '/api/requests', qtBody({ confirmDuplicate: true, items: [{ kind: 'service', code: '5136', qty: 3, unitPrice: 15900 }] })); const q17 = j.requestId; if (!q17) console.log('   QT request refused:', s, j.error);
  await call(ACCT, 'PATCH', '/api/requests', { requestId: q17, action: 'approve' }); const r17 = req(q17);
  ok(r17.status === 'qt_draft' && r17.peakQtId, 'QT Draft made: ' + r17.status);
  const staleQ = { ...peak().quotations.find((x) => x.id === r17.peakQtId) }; // payload still Draft
  setPeak((p) => { p.quotations.find((x) => x.id === r17.peakQtId).status = 'Approve'; });
  [s, j] = await hook('quotation', { PeakQuotations: { quotations: [staleQ] }, eventType: 'Edit' });
  ok(j.results[0] === 'approved' && req(q17).status === 'qt_approved', 'looked again and approved the QT: ' + j.results[0]);
  console.log('── 18. a Void event is believed even when the payload still shows the old status');
  { const v = db().InvoiceRequests.find((x) => x.status === 'iv_issued' && x.peakIvId && x.ivRequestId === tw[1]);
    const doc = { ...peak().invoices.find((y) => y.id === v.peakIvId) }; // status still "Approve", isVoid 0
    [s, j] = await hook('invoice', { PeakInvoices: { invoices: [doc] }, eventType: 'Void' });
    ok(arRow(v.peakIvNo).docStatus === 'Cancelled' && ivr(tw[1]).status === 'iv_void', 'INV taken out of AR on the Void event: ' + j.results[0]); }
  console.log('── 19. paid through Whitehouse: WH order / receipt number instead of a slip');
  { const base = { action: 'pay_notice', ivRequestId: tw[0], paidDate: '2026-11-13', amount: 19046, paymentMethod: 'Bank Transfer', deliveryChannel: 'sales' };
    [s, j] = await call(BENZ, 'POST', '/api/invoice-requests', base); ok(s === 400 && /Whitehouse|WH/.test(j.error || ''), 'no slip and no WH reference refused: ' + (j.error || s));
    [s, j] = await call(BENZ, 'POST', '/api/invoice-requests', { ...base, viaWh: true, whOrderId: 'ORD-778899' }); ok(s === 400 && /ทั้ง Order ID และเลขใบเสร็จ/.test(j.error || ''), 'paid through WH with only the order refused: ' + (j.error || s));
    [s, j] = await call(BENZ, 'POST', '/api/invoice-requests', { ...base, whReceiptNo: 'WH-RT-0042' }); ok(s === 400, 'only the WH receipt number refused');
    [s, j] = await call(BENZ, 'POST', '/api/invoice-requests', { ...base, whOrderId: 'ORD-778899', whReceiptNo: 'WH-RT-0042', note: 'ลูกค้าจ่ายเอง' });
    const pn = db().PaymentNotices.find((x) => x.noticeId === j.noticeId);
    ok(s === 200 && pn && pn.note === 'จ่ายผ่าน WH · Order ORD-778899 · ใบเสร็จ WH WH-RT-0042 · ลูกค้าจ่ายเอง' && !pn.slipLink, 'notice kept with the WH order and receipt, no slip needed: ' + (j.error || (pn && pn.note)));
    { const t = (peak().chat || []).map((x) => x.text).join('\n'); ok(/จ่ายผ่าน WH: Order ORD-778899, ใบเสร็จ WH WH-RT-0042/.test(t), 'chat message says it was paid through WH'); } }
  console.log('── 20. a QT typed as "outside the app" that the app already knows is linked on its own');
  { const adq = db().Requests.find((x) => x.peakQtNo === 'QO-20240700200');
    [s, j] = await call(BENZ, 'POST', '/api/invoice-requests', ivBody({}, { ...ext, qtNo: 'qo-20240700200 ', invoices: [{ amount: 8900, students: 1, wantedIssueDate: '2026-12-01', creditTermDays: 30, originalDoc: 'no' }] }));
    const nr = db().InvoiceRequests.filter((x) => x.qtNo && /QO-20240700200/i.test(x.qtNo)).pop();
    ok(s === 200 && nr.requestId === adq.requestId && !/QT นอกระบบ/.test(nr.overReason || ''), 'request linked to the QT in the app, not marked as outside: ' + (j.error || nr.requestId + ' ' + nr.overReason));
    [s, j] = await call(BENZ, 'POST', '/api/invoice-requests', ivBody({}, { ...ext, qtNo: 'QO-20240700200', invoices: [{ amount: 9000000, students: 1, wantedIssueDate: '2026-12-01', creditTermDays: 30, originalDoc: 'no' }] }));
    ok(s === 400 && /เกินยอด QT/.test(j.error || ''), 'and the balance of that QT is checked: ' + (j.error || s)); }
  console.log('── 21. approval history: accounting sees who did what; Sales cannot open it');
  { [s, j] = await call(ADMIN, 'GET', '/api/invoice-requests?view=history');
    const main = (j.entries || []).filter((e) => e.main);
    ok(s === 200 && main.length > 5 && main.every((e, i) => !i || main[i - 1].ts >= e.ts), 'history lists the actions newest first: ' + (j.error || main.length));
    const ap = main.find((e) => e.ev === 'qt_approve' && e.thread), rj = main.find((e) => /_reject$/.test(e.ev));
    ok(ap && ap.by && ap.role && j.threads[ap.thread] && j.threads[ap.thread].company, 'an approval carries who did it and the customer of the request');
    ok(rj && rj.reason, 'a rejection carries its reason: ' + (rj && rj.reason));
    ok(!(j.entries || []).some((e) => /@/.test(e.by)), 'people are shown by name, not email');
    [s, j] = await call(BENZ, 'GET', '/api/invoice-requests?view=history');
    ok(s === 403, 'Sales gets 403: ' + s); }
  console.log('── 22. debt page work log: follow-ups and money in, by person');
  { const iv = db().Invoices.find((x) => !x.paidDate && x.ivNo);
    [s, j] = await call(COL, 'PATCH', '/api/invoice-requests', { action: 'ar_followup', ivNo: iv.ivNo, channel: 'Call', result: 'Committed', commitDate: '2027-01-15', note: 'โทรคุยกับการเงินแล้ว' });
    ok(s === 200, 'collector logs a follow-up: ' + (j.error || s));
    [s, j] = await call(COL, 'GET', '/api/invoice-requests?view=arlog');
    const f = (j.entries || []).find((e) => e.type === 'follow' && e.ivNo === iv.ivNo && e.note === 'โทรคุยกับการเงินแล้ว');
    ok(s === 200 && f && f.by && !/@/.test(f.by) && f.channel === 'Call' && f.commitDate === '15/01/2027', 'the follow-up is in the log with who, channel, note and the commit date: ' + (j.error || JSON.stringify(f)));
    ok((j.entries || []).some((e) => e.type === 'paid' && e.amount > 0), 'money recorded earlier in the run is listed with its amount');
    ok((j.entries || []).every((e, i, a) => !i || a[i - 1].ts >= e.ts), 'newest first');
    [s, j] = await call(BENZ, 'GET', '/api/invoice-requests?view=arlog');
    ok(s === 403, 'Sales gets 403: ' + s); }
  console.log('── 23. customer withheld tax at a rate the INV does not carry');
  { const old = db().PaymentNotices.find((x) => x.ivRequestId === tw[0] && x.status === 'new');
    [s, j] = await call(ADMIN, 'PATCH', '/api/invoice-requests', { action: 'pay_reject', noticeId: old.noticeId, note: 'ทดสอบ' }); ok(s === 200, 'open notice sent back first: ' + (j.error || s));
    const a0 = db().Invoices.find((x) => x.ivRequestId === tw[0]); const cur = Math.round(Number(a0.whtRate) * (Number(a0.whtRate) < 1 ? 100 : 1)), W = cur === 3 ? 5 : 3; const pre = Number(a0.preVat), net3 = Math.round((pre * 1.07 - pre * W / 100) * 100) / 100;
    const base = { action: 'pay_notice', ivRequestId: tw[0], paidDate: '2026-11-13', amount: net3, paymentMethod: 'Bank Transfer', deliveryChannel: 'sales', whOrderId: 'ORD-1', whReceiptNo: 'WH-2' };
    [s, j] = await call(BENZ, 'POST', '/api/invoice-requests', { ...base, whtRate: '4' }); ok(s === 400 && /หัก ณ ที่จ่าย/.test(j.error || ''), 'a rate that does not exist is refused: ' + (j.error || s));
    [s, j] = await call(BENZ, 'POST', '/api/invoice-requests', { ...base, whtRate: String(W) });
    const pn = db().PaymentNotices.find((x) => x.noticeId === j.noticeId);
    ok(s === 200 && pn.note.includes(`หัก ณ ที่จ่าย ${W}%`) && db().Invoices.find((x) => x.ivRequestId === tw[0]).whtRate === a0.whtRate, 'Sales says another rate was withheld: kept on the notice, the INV is not changed yet: ' + (j.error || pn.note));
    ok(!/ยอดไม่ตรง/.test((peak().chat || []).map((x) => x.text).pop() || ''), 'no "amount differs" warning when the amount fits the rate Sales gave');
    [s, j] = await call(ADMIN, 'PATCH', '/api/invoice-requests', { action: 'pay_confirm', noticeId: pn.noticeId, whtRate: String(W) });
    const a1 = db().Invoices.find((x) => x.ivRequestId === tw[0]);
    ok(s === 200 && Number(a1.whtRate) === W / 100 && Number(a1.paidAmount) === net3 && a1.paidDate, 'accounting confirms: INV now carries the new rate and is paid at the net amount: ' + (j.error || a1.whtRate + ' ' + a1.paidAmount));
    [s, j] = await call(ADMIN, 'GET', '/api/invoice-requests?view=ar');
    const r = (j.invoices || []).find((x) => x.ivNo === a1.ivNo);
    ok(r && Math.abs(r.expected - net3) < 0.01, 'expected amount of that INV follows the new rate: ' + (r && r.expected)); }
  console.log('── 27. paid through Whitehouse: no new receipt from the app, the WH receipt is replaced under its own number');
  { const busy = new Set(db().PaymentNotices.map((x) => x.ivRequestId));
    const liveRt = new Set(db().ReceiptRequests.filter((x) => !['rejected', 'rt_void'].includes(x.status)).map((x) => x.refDoc));
    const v = db().InvoiceRequests.find((x) => x.status === 'iv_issued' && x.peakIvId && !busy.has(x.ivRequestId) && !liveRt.has(x.peakIvNo) && (() => { const a = arRow(x.peakIvNo); return a && !a.paidDate && !a.rtNo && a.docStatus === 'Active' && !Number(a.paidAmount); })());
    ok(!!v, 'an open INV exists for the WH case');
    if (v) {
      const a0 = arRow(v.peakIvNo), pre = Number(a0.preVat), rate = Number(a0.whtRate) < 1 ? Number(a0.whtRate) : Number(a0.whtRate) / 100, full = Math.round((pre * 1.07 - pre * rate) * 100) / 100;
      [s, j] = await call(v.requestedBy, 'POST', '/api/invoice-requests', { action: 'pay_notice', ivRequestId: v.ivRequestId, paidDate: '2026-11-10', amount: full, paymentMethod: 'Bank Transfer', deliveryChannel: 'sales', whOrderId: '75801', whReceiptNo: '202609A00117' }); const n1 = j.noticeId;
      [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'pay_confirm', noticeId: n1 }); ok(s === 200 && !j.partial, 'WH payment confirmed: ' + (j.error || ''));
      const before = (peak().receipts || []).length;
      [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'rt_make', ivNo: v.peakIvNo, paymentMethodCode: 'BNK001', deliveryChannel: 'sales' });
      ok(s === 409 && /Whitehouse/.test(j.error || '') && /202609A00117/.test(j.error || '') && (peak().receipts || []).length === before, 'the app refuses to create a receipt in PEAK and names the WH receipt: ' + (j.error || s));
      [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'rt_make', ivNo: v.peakIvNo, noticeId: n1, paymentMethodCode: 'BNK001', deliveryChannel: 'sales' }); ok(s === 409 && (peak().receipts || []).length === before, 'also for the round on its own: ' + s);
      [s, j] = await call(ACCT, 'GET', '/api/invoice-requests?view=ar'); const r = (j.invoices || []).find((x) => x.ivNo === v.peakIvNo);
      ok(r && r.wh && r.wh[0].receipt === '202609A00117' && r.wh[0].order === '75801' && !r.wh[0].rt, 'debt page knows the WH receipt to replace: ' + JSON.stringify(r && r.wh));
      [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'rt_from_inv', ivNo: v.peakIvNo, noticeId: n1, peakRtNo: '202609A00117', peakDocLink: 'https://doc.peakaccount.com/receipt?emi=wh117', deliveryChannel: 'sales' });
      const rt = db().ReceiptRequests.filter((x) => x.refDoc === v.peakIvNo).pop();
      ok(s === 200 && rt && rt.peakRtNo === '202609A00117' && rt.status === 'issued' && rt.note.includes('รอบ ' + n1) && arRow(v.peakIvNo).rtNo === '202609A00117' && (peak().receipts || []).length === before, 'accounting record the re-made receipt under the WH number; nothing is created in PEAK: ' + (j.error || ''));
      [s, j] = await call(ACCT, 'GET', '/api/invoice-requests?view=ar'); const r2 = (j.invoices || []).find((x) => x.ivNo === v.peakIvNo);
      ok(r2 && r2.wh[0].rt === '202609A00117', 'and the round shows its receipt: ' + JSON.stringify(r2 && r2.wh)); } }
  console.log('── 24. one INV paid in several rounds');
  { const busy = new Set(db().PaymentNotices.filter((x) => x.status === 'new').map((x) => x.ivRequestId));
    const liveRt = new Set(db().ReceiptRequests.filter((x) => !['rejected', 'rt_void'].includes(x.status)).map((x) => x.refDoc));
    const v = db().InvoiceRequests.find((x) => x.status === 'iv_issued' && x.peakIvId && x.requestedBy === BENZ && !busy.has(x.ivRequestId) && !liveRt.has(x.peakIvNo)
      && (() => { const a = arRow(x.peakIvNo); return a && !a.paidDate && !a.rtNo && a.docStatus === 'Active' && !Number(a.paidAmount); })());
    ok(!!v, 'an open INV to pay in rounds exists');
    if (v) {
      const a0 = arRow(v.peakIvNo), pre = Number(a0.preVat), rate = Number(a0.whtRate) < 1 ? Number(a0.whtRate) : Number(a0.whtRate) / 100;
      const full = Math.round((pre * 1.07 - pre * rate) * 100) / 100, r1 = Math.round(full * 0.4 * 100) / 100, r2 = Math.round((full - r1) * 100) / 100;
      const base = { action: 'pay_notice', ivRequestId: v.ivRequestId, paymentMethod: 'Bank Transfer', deliveryChannel: 'sales', file };
      [s, j] = await call(BENZ, 'POST', '/api/invoice-requests', { ...base, paidDate: '2026-11-10', amount: r1 }); const n1 = j.noticeId;
      ok(s === 200 && /จ่ายบางส่วน/.test((peak().chat || []).map((x) => x.text).pop() || ''), 'round 1 reported, chat says it is a part payment: ' + (j.error || ''));
      [s, j] = await call(BENZ, 'POST', '/api/invoice-requests', { ...base, paidDate: '2026-11-10', amount: r1 }); ok(s === 409, 'the same round twice is refused: ' + s);
      [s, j] = await call(BENZ, 'POST', '/api/invoice-requests', { ...base, paidDate: '2026-11-12', amount: r2 }); const n2 = j.noticeId;
      ok(s === 200 && !/จ่ายบางส่วน|ยอดเกิน/.test((peak().chat || []).map((x) => x.text).pop() || ''), 'round 2 reported while round 1 still waits, and it completes the INV: ' + (j.error || ''));
      [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'pay_confirm', noticeId: n1 });
      let a = arRow(v.peakIvNo);
      ok(s === 200 && j.partial && Math.abs(j.remaining - r2) < 0.01 && !a.paidDate && Number(a.paidAmount) === r1, 'round 1 confirmed: INV stays open with the rest owed: ' + (j.error || JSON.stringify(j)));
      [s, j] = await call(ACCT, 'GET', '/api/invoice-requests?view=ar'); let r = (j.invoices || []).find((x) => x.ivNo === v.peakIvNo);
      ok(r && r.partial && Math.abs(r.expected - r2) < 0.01 && Math.abs(r.expectedFull - full) < 0.01 && r.rounds.length === 1 && !r.rounds[0].rt && r.state !== 'Paid', 'debt page: still open, owes the rest, one round listed: ' + (r && [r.expected, r.expectedFull, r.state].join(' ')));
      // Cash-in counts the round on its own date while the INV is still open (week of 10/11 ends Thu 12/11).
      { const [, sm] = await call(ACCT, 'GET', '/api/invoice-requests?view=ar&drill=' + encodeURIComponent('paid|12/11/2026'));
        const line = (sm.rows || []).find((x) => x.ivNo === v.peakIvNo);
        ok(line && line.round && Math.abs(line.amount - r1) < 0.01 && line.paidDate === '10/11/2026', 'the round is in that week\'s cash-in with its own amount and date: ' + JSON.stringify(line || (sm.error || (sm.rows || []).length)));
        const [, nov] = await call(ACCT, 'GET', '/api/invoice-requests?view=ar&drill=' + encodeURIComponent('month-cash|11/2026'));
        ok((nov.rows || []).filter((x) => x.ivNo === v.peakIvNo).length === 1, 'and once in the month\'s cash-in'); }
      [s, j] = await call(BENZ, 'GET', '/api/invoice-requests'); const mine = (j.requests || []).find((x) => x.ivRequestId === v.ivRequestId);
      ok(mine && mine.ar.received === r1 && mine.payRounds.length === 2 && mine.payRounds.filter((x) => x.status === 'new').length === 1, 'Sales see what was confirmed and what still waits');
      const rt = { action: 'rt_make', ivNo: v.peakIvNo, paymentMethodCode: 'BNK001', deliveryChannel: 'sales' };
      [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', rt); ok(s === 409 && /ยังรับเงินไม่ครบ/.test(j.error || ''), 'no combined receipt while the INV is not fully paid: ' + (j.error || s));
      [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { ...rt, noticeId: n1 });
      const p1 = peak().lastRtBody.receipts.paidPayments;
      ok(s === 200 && Number(p1.payments[0].amount) === r1 && !p1.withHoldingTaxAmount && p1.paymentDate === '20261110', 'receipt for round 1 only: its amount and date, no withholding: ' + (j.error || JSON.stringify(p1)));
      [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { ...rt, noticeId: n1 }); ok(s === 409, 'a second receipt for the same round is refused: ' + s);
      [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'pay_confirm', noticeId: n2 });
      a = arRow(v.peakIvNo);
      ok(s === 200 && !j.partial && a.paidDate === '12/11/2026' && Math.abs(Number(a.paidAmount) - full) < 0.01, 'round 2 confirmed: INV closed on the last date with the total: ' + (j.error || a.paidDate + ' ' + a.paidAmount));
      [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', rt);
      const p2 = peak().lastRtBody.receipts.paidPayments;
      ok(s === 200 && Math.abs(Number(p2.payments[0].amount) - r2) < 0.01, 'the receipt after closing covers only what has no receipt yet: ' + (j.error || JSON.stringify(p2)));
      [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', rt); ok(s === 409, 'nothing left to receipt: ' + s);
      [s, j] = await call(ACCT, 'GET', '/api/invoice-requests?view=ar'); r = (j.invoices || []).find((x) => x.ivNo === v.peakIvNo);
      ok(r && r.state === 'Paid' && !r.partial && r.rounds.length === 2 && r.rounds.every((x) => x.rt), 'debt page: paid, two rounds, each with a receipt: ' + (r && JSON.stringify(r.rounds.map((x) => x.rt))));
      { const [, sm] = await call(ACCT, 'GET', '/api/invoice-requests?view=ar&drill=' + encodeURIComponent('month-cash|11/2026'));
        const ls = (sm.rows || []).filter((x) => x.ivNo === v.peakIvNo);
        ok(ls.length === 2 && Math.abs(ls.reduce((t, x) => t + x.amount, 0) - full) < 0.01 && ls.some((x) => x.paidDate === '10/11/2026') && ls.some((x) => x.paidDate === '12/11/2026'), 'after closing: two cash lines on the two dates, adding up to the INV: ' + JSON.stringify(ls.map((x) => [x.paidDate, x.amount]))); }
    }
    // Accounting records a round itself.
    const b2 = db().Invoices.find((x) => !x.paidDate && !x.rtNo && !x.rtDate && x.docStatus === 'Active' && !Number(x.paidAmount) && Number(x.preVat) > 1000);
    if (b2) { const part = 500;
      [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'ar_update', ivNo: b2.ivNo, partial: true, paidDate: '2026-11-11', paidAmount: part, paymentMethod: 'Bank Transfer', file });
      const a = arRow(b2.ivNo), pn = db().PaymentNotices.find((x) => x.noticeId === j.noticeId);
      ok(s === 200 && j.partial && !a.paidDate && Number(a.paidAmount) === part && pn && pn.status === 'confirmed' && pn.source === 'accounting', 'accounting records a part payment: INV open, round kept: ' + (j.error || ''));
      [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'ar_update', ivNo: b2.ivNo, paidDate: '2026-11-13', paidAmount: 100, paymentMethod: 'Bank Transfer', deliveryChannel: 'sales', file });
      ok(s === 200 && Number(arRow(b2.ivNo).paidAmount) === part + 100 && arRow(b2.ivNo).paidDate === '13/11/2026', 'closing later adds the last amount to what was received: ' + (j.error || arRow(b2.ivNo).paidAmount)); } }
  console.log('── 25. receipt request for money that already has a receipt');
  { const a = db().Invoices.find((x) => x.rtNo && x.paidDate && /^\d{13}$/.test(String(x.taxId)) && Number(x.preVat) > 0 && x.docStatus === 'Active');
    ok(!!a, 'a paid INV with a receipt exists');
    if (a) {
      const iso = a.paidDate.split('/').reverse().join('-');
      const body = { action: 'receipt', customerType: 'G012-00001', docKind: 'company', billName: a.company, taxId: a.taxId, branch: '00000', address: 'กทม', whStudent: 'S9', packages: '5136', price: Number(a.preVat), discount: 0, whtRate: '3', paidDate: iso, deliveryChannel: 'sales', docLang: 'TH', file };
      [s, j] = await call(BENZ, 'POST', '/api/invoice-requests', body);
      ok(s === 409 && j.duplicate && (j.issued || []).some((x) => a.rtNo.includes(x.rtNo) && x.ivNo === a.ivNo), 'Sales are told which receipt and INV it is: ' + (j.error || s) + ' ' + JSON.stringify(j.issued || ''));
      [s, j] = await call(BENZ, 'POST', '/api/invoice-requests', { ...body, paidDate: '2026-01-02' });
      ok(!(j.issued || []).length, 'another payment date is not called a duplicate of that receipt: ' + s);
      [s, j] = await call(BENZ, 'POST', '/api/invoice-requests', { ...body, confirmDuplicate: true }); const id = j.rtRequestId;
      ok(s === 200 && id, 'Sales can still send it on purpose: ' + (j.error || ''));
      [s, j] = await call(ACCT, 'GET', '/api/invoice-requests?view=receipts'); const c = (j.requests || []).find((x) => x.rtRequestId === id);
      ok(c && (c.twins || []).some((x) => x.ivNo === a.ivNo), 'accounting see the warning on the waiting card: ' + JSON.stringify(c && c.twins));
      [s, j] = await call(BENZ, 'GET', '/api/invoice-requests?view=receipts');
      ok(!((j.requests || []).find((x) => x.rtRequestId === id) || {}).twins, 'the flag is for accounting only'); } }
  console.log('── 26. receipt already issued, customer now wants the original');
  { const r = db().ReceiptRequests.find((x) => x.status === 'issued' && x.sentStatus === 'sent' && x.requestedBy === BENZ);
    ok(!!r, 'an issued receipt of Benz that counts as sent exists');
    if (r) {
      [s, j] = await call(BEE, 'PATCH', '/api/invoice-requests', { action: 'rt_original', rtRequestId: r.rtRequestId, recipient: 'A', address: 'B' }); ok(s === 404, 'another salesperson cannot ask: ' + s);
      [s, j] = await call(BENZ, 'PATCH', '/api/invoice-requests', { action: 'rt_original', rtRequestId: r.rtRequestId, recipient: 'คุณเอ' }); ok(s === 400, 'recipient and address are both needed: ' + s);
      [s, j] = await call(BENZ, 'PATCH', '/api/invoice-requests', { action: 'rt_original', rtRequestId: r.rtRequestId, recipient: 'คุณเอ ฝ่ายการเงิน', address: '99 ถ.สีลม กทม. 10500' });
      const x = db().ReceiptRequests.find((y) => y.rtRequestId === r.rtRequestId);
      ok(s === 200 && x.sentStatus === 'waiting' && /ตัวจริง/.test(x.deliveryChannel) && /คุณเอ ฝ่ายการเงิน · 99 ถ.สีลม/.test(x.deliveryAddress) && x.status === 'issued', 'it joins the "send the original" queue with the address: ' + (j.error || x.sentStatus + ' ' + x.deliveryChannel));
      ok(/ขอใบเสร็จตัวจริง/.test((peak().chat || []).map((c) => c.text).pop() || ''), 'accounting are told in chat');
      [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'rt_sent', rtRequestId: r.rtRequestId, trackingNo: 'TH123' });
      ok(s === 200 && db().ReceiptRequests.find((y) => y.rtRequestId === r.rtRequestId).sentStatus === 'sent', 'accounting mark it sent as usual: ' + (j.error || '')); }
    const d0 = db().ReceiptRequests.find((x) => x.status === 'new');
    if (d0) { [s, j] = await call(ADMIN, 'PATCH', '/api/invoice-requests', { action: 'rt_original', rtRequestId: d0.rtRequestId, recipient: 'A', address: 'B' }); ok(s === 409, 'not before the receipt is issued: ' + s); } }
  console.log('── 31. monthly issued / cash in per seller');
  { [s, j] = await call(ACCT, 'GET', '/api/invoice-requests?view=ar'); const ms = j.summary.months;
    const m0 = ms.find((m) => Object.keys(m.bySales || {}).length);
    ok(!!m0, 'months carry a per-seller split');
    if (m0) {
      const r2 = (n) => Math.round(n * 100) / 100, vals = Object.values(m0.bySales);
      ok(Math.abs(r2(vals.reduce((t, o) => t + o.invoiced, 0)) - m0.invoiced) < 0.02 && Math.abs(r2(vals.reduce((t, o) => t + o.cash, 0)) - m0.cash) < 0.02, `sellers add up to the month: ${m0.month} issued ${m0.invoiced} cash ${m0.cash}`);
      ok(vals.reduce((t, o) => t + o.count, 0) === m0.count, 'INV counts add up');
      const [name, o] = Object.entries(m0.bySales).sort((a, b) => b[1].invoiced - a[1].invoiced)[0];
      [s, j] = await call(ACCT, 'GET', '/api/invoice-requests?view=ar&drill=' + encodeURIComponent(`month-inv|${m0.month}||${name}`)); ok(s === 200 && Math.abs(j.total - o.invoiced) < 0.02 && j.rows.every((x) => (x.salesName || '(ไม่ระบุ)') === name), `drill lists only that seller's INVs: ${name} ${j.total}`);
      const mc = ms.find((m) => Object.values(m.bySales || {}).some((x) => x.cash > 0));
      if (mc) { const [n2, o2] = Object.entries(mc.bySales).find(([, x]) => x.cash > 0);
        [s, j] = await call(ACCT, 'GET', '/api/invoice-requests?view=ar&drill=' + encodeURIComponent(`month-cash|${mc.month}||${n2}`)); ok(s === 200 && Math.abs(j.total - o2.cash) < 0.02, `cash drill matches: ${n2} ${j.total} vs ${o2.cash}`); }
    } }
  console.log('── 29. reminder sent before the due date');
  { [s, j] = await call(COL, 'GET', '/api/invoice-requests?view=ar'); const rem = j.lists.remind;
    const r0 = j.invoices.find((x) => ['Outstanding', 'Overdue'].includes(x.state));
    ok(!!r0, 'an open INV exists');
    if (r0) {
      const before = arRow(r0.ivNo), n0 = db().FollowUps.filter((f) => f.ivNo === r0.ivNo).length;
      [s, j] = await call(BEE, 'PATCH', '/api/invoice-requests', { action: 'ar_followup', ivNo: r0.ivNo, channel: 'Email', result: rem }); ok(s === 403, 'sales cannot log a reminder');
      [s, j] = await call(COL, 'PATCH', '/api/invoice-requests', { action: 'ar_followup', ivNo: r0.ivNo, channel: 'Email', result: rem }); ok(s === 200, 'reminder logged without a commit date, even when the old one has passed: ' + (j.error || ''));
      const after = arRow(r0.ivNo), fs2 = db().FollowUps.filter((f) => f.ivNo === r0.ivNo);
      ok(fs2.length === n0 + 1 && fs2[fs2.length - 1].result === rem && fs2[fs2.length - 1].channel === 'Email', 'kept in the follow-up history');
      ok(after.followStatus === before.followStatus && after.commitDate === before.commitDate && after.nextActionDate === before.nextActionDate, 'follow status, commit date and next action stay as they were');
      [s, j] = await call(COL, 'GET', '/api/invoice-requests?view=ar'); const r1 = j.invoices.find((x) => x.ivNo === r0.ivNo);
      ok((r1.followUps || []).some((f) => f.result === rem), 'the list carries the reminder for the row badge');
      [s, j] = await call(COL, 'GET', '/api/invoice-requests?view=arlog'); ok(s === 200 && j.entries.some((x) => x.ivNo === r0.ivNo && JSON.stringify(x).includes(rem)), 'shown in the work log');
    } }
  console.log('── 28. edit request closed as "INV cancelled, another INV is used instead"');
  { const A = () => db().Invoices; const num = (v) => Number(String(v || '').replace(/,/g, '')) || 0;
    const old = A().find((x) => x.docStatus === 'Active' && !x.paidDate && !x.rtNo && !num(x.paidAmount));
    const other = A().find((x) => x.ivNo !== (old || {}).ivNo && x.docStatus === 'Active');
    ok(old && other, 'an open INV and another live INV exist');
    if (old && other) {
      [s, j] = await call(ADMIN, 'POST', '/api/invoice-requests', { action: 'edit', docType: 'INV', docNo: old.ivNo, refId: old.ivRequestId, company: old.company, detail: 'ลูกค้าเปลี่ยนออกในนามบริษัทอื่น' }); ok(s === 200, 'edit request made ' + (j.error || '')); const ed = j.editId;
      [s, j] = await call(BEE, 'PATCH', '/api/invoice-requests', { action: 'edit_done', editId: ed, replacedBy: other.ivNo }); ok(s === 403, 'sales cannot cancel');
      [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'edit_done', editId: ed, replacedBy: old.ivNo }); ok(s === 400, 'cannot replace an INV with itself');
      [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'edit_done', editId: ed, replacedBy: 'IV-29990100001' }); ok(s === 404, 'unknown replacement refused');
      setPeak((p) => { p.invoices = p.invoices.filter((x) => x.code !== old.ivNo); p.invoices.push({ id: 'rp1', code: old.ivNo, status: 'Approve', contactCode: 'C1', issuedDate: '20261001', dueDate: '20261031', preTaxAmount: 100, netAmount: 107 }); });
      [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'edit_done', editId: ed, replacedBy: other.ivNo }); ok(s === 409 && /void/.test(j.error), 'still approved in PEAK → void it first: ' + j.error);
      setPeak((p) => { p.invoices.find((x) => x.id === 'rp1').status = 'Draft'; });
      const chats = peak().chat ? peak().chat.length : 0;
      [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'edit_done', editId: ed, replacedBy: other.ivNo.toLowerCase() }); ok(s === 200, 'voided in PEAK → closed: ' + (j.error || ''));
      const a2 = arRow(old.ivNo), e2 = db().EditRequests.find((x) => x.editId === ed);
      ok(a2.docStatus === 'Replaced' && a2.note.includes(other.ivNo), 'INV leaves the debt list as Replaced');
      if (old.ivRequestId) ok(ivr(old.ivRequestId).status === 'iv_void', 'its request is void');
      ok(e2.status === 'done' && e2.newDocNo === other.ivNo, 'edit request done, points at the INV in use');
      [s, j] = await call(ACCT, 'GET', '/api/invoice-requests?view=ar'); const row = (j.invoices || []).find((x) => x.ivNo === old.ivNo); ok(!row || !['Outstanding', 'Overdue'].includes(row.state), 'no longer counted as open');
    } }
  console.log('── 30. one document for several CRM opportunities');
  { [s, j] = await call(BENZ, 'POST', '/api/requests', qtBody({ company: 'บริษัท หลายดีล จำกัด', opportunityId: 'crm-opp-2026-00201, CRM-OPP-2026-00202 , CRM-OPP-2026-00201', confirmDuplicate: true })); ok(s === 200, 'QT with two Opportunity IDs: ' + (j.error || ''));
    const qm = j.requestId; let rm = req(qm);
    ok(rm.opportunityId === 'CRM-OPP-2026-00201, CRM-OPP-2026-00202', 'stored as a clean list, duplicates dropped: ' + rm.opportunityId);
    [s, j] = await call(ACCT, 'PATCH', '/api/requests', { requestId: qm, action: 'approve', seen: seen(rm) }); ok(s === 200, 'approved ' + (j.error || '')); rm = req(qm); console.log('   ', rm.status, (rm.peakNote || '').slice(0, 120));
    const pm = peak().quotations.find((x) => x.reference === qm);
    ok(pm && pm.tags.includes('CRM-OPP-2026-00201') && pm.tags.includes('CRM-OPP-2026-00202') && pm.tags.includes(qm), 'PEAK QT carries one tag per Opportunity: ' + (pm ? pm.tags.join(' | ') : 'no QT'));
    [s, j] = await call(BENZ, 'POST', '/api/requests', qtBody({ company: 'บริษัท หลายดีล สอง จำกัด', opportunityId: 'CRM-OPP-2026-00201, CRM-OPP-2026-0020', confirmDuplicate: true })); ok(s === 400 && /รูปแบบ/.test(j.error), 'a half-typed extra ID is refused, not dropped');
  }
  console.log('── 32. a customer PEAK does not have needs the new-customer details');
  { [s, j] = await call(BENZ, 'POST', '/api/requests', qtBody({ company: 'บริษัท ไม่เคยมี จำกัด', taxId: '0105540099991', clientCode: '', confirmDuplicate: true })); ok(s === 400 && /ยังไม่มีลูกค้า/.test(j.error), 'no PEAK code and no details → refused at submit: ' + j.error);
    [s, j] = await call(BENZ, 'POST', '/api/requests', qtBody({ company: 'บริษัท ไม่เคยมี จำกัด', taxId: '0105540099991', clientCode: '', confirmDuplicate: true, newContact: { type: '2', address: '1 ถนนทดสอบ', province: 'กรุงเทพมหานคร', postCode: '10110', contactName: 'คุณเอ' } })); ok(s === 200, 'with the details → accepted: ' + (j.error || ''));
    const nid = j.requestId; [s, j] = await call(BENZ, 'GET', '/api/requests'); const mine2 = j.requests.find((x) => x.requestId === nid);
    ok(mine2 && mine2.newContactData && mine2.newContactData.type === '2' && mine2.newContactData.address === '1 ถนนทดสอบ' && mine2.newContactData.contactName === 'คุณเอ', 'the list gives the details back in form shape, for rebuilding a sent-back request');
    [s, j] = await call(BENZ, 'POST', '/api/requests', qtBody({ confirmDuplicate: true, clientCode: '' })); ok(s === 200, 'a customer PEAK has passes without a code typed: ' + (j.error || ''));
  }
  console.log('── 33. PEAK already holds a receipt for the INV (an earlier press was cut off)');
  { const fsx = require('fs'), F = '/tmp/sales-desk-e2e/db.json';
    // Two paid INVs with no receipt in the app, each with its approved INV in PEAK.
    const T = require('./lib.cjs').T; const raw = JSON.parse(fsx.readFileSync(F, 'utf8'));
    const mkInv = (n) => ({ ivNo: 'IV-2999010000' + n, issueDate: '01/11/2026', segment: 'B2B', salesEmail: BEE, salesName: 'Bee', clientCode: 'C1', company: 'บริษัท ค้างใบเสร็จ ' + n, taxId: '0105540000001', preVat: 1000, creditTermDays: 30, whtRate: '0', docStatus: 'Active', paidDate: '20/11/2026', paidAmount: 1070, paymentMethod: 'Bank Transfer', peakIvId: 'ix' + n });
    for (const n of [8, 9]) raw.Invoices.push(T.Invoices.map((h) => mkInv(n)[h] ?? ''));
    fsx.writeFileSync(F, JSON.stringify(raw));
    setPeak((p) => { for (const n of [8, 9]) p.invoices.push({ id: 'ix' + n, code: 'IV-2999010000' + n, status: 'Approve', isVoid: 0, contactCode: 'C1', issuedDate: '20261101', dueDate: '20261201', preTaxAmount: 1000, vatAmount: 70, netAmount: 1070, remainAmount: 1070 }); });
    const cands = db().Invoices.filter((x) => /^IV-2999010000[89]$/.test(x.ivNo));
    ok(cands.length === 2, 'two paid INVs with no receipt in the app');
    const mk = { paymentMethodCode: 'BNK001', deliveryChannel: 'sales' };
    if (cands[0]) { const a = cands[0], pid = peak().invoices.find((i) => i.code === a.ivNo && i.status === 'Approve').id;
      setPeak((p) => { p.rtRefuse = [pid]; });
      [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'rt_make', ivNo: a.ivNo, ...mk }); ok(s === 409 && /รอรับชำระ/.test(j.error) && !/Waiting Payment/.test(j.error), 'refused and no receipt found → a plain Thai message: ' + String(j.error).slice(0, 70));
      setPeak((p) => { p.receipts.push({ id: 'rx1', code: 'RT-29991100001', status: 'Draft', isVoid: 0, reference: a.ivNo, documentLink: 'https://doc.peakaccount.com/receipt?emi=rx1' }); });
      const before = peak().receipts.length;
      [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'rt_make', ivNo: a.ivNo, ...mk }); ok(s === 200 && j.adopted && j.peakRtNo === 'RT-29991100001', 'the Draft PEAK holds is taken into the app: ' + (j.error || j.message));
      const row = db().ReceiptRequests.find((r) => String(r.refDoc).toUpperCase() === a.ivNo && r.peakRtNo === 'RT-29991100001');
      ok(row && row.status === 'rt_draft' && row.peakRtId === 'rx1' && peak().receipts.length === before, 'app row waits for approval; nothing new in PEAK');
      setPeak((p) => { p.receipts.find((r) => r.id === 'rx1').status = 'Approve'; });
      await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'rt_check', rtRequestId: row.rtRequestId });
      ok(arRow(a.ivNo).rtNo === 'RT-29991100001', 'approved in PEAK → the INV gets the receipt number: ' + arRow(a.ivNo).rtNo);
    }
    if (cands[1]) { const a = cands[1], pid = peak().invoices.find((i) => i.code === a.ivNo && i.status === 'Approve').id;
      setPeak((p) => { p.rtRefuse = [pid]; p.receipts.push({ id: 'rx2', code: 'RT-29991100002', status: 'Approve', isVoid: 0, reference: a.ivNo, documentLink: 'https://doc.peakaccount.com/receipt?emi=rx2' }); });
      [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'rt_make', ivNo: a.ivNo, ...mk }); ok(s === 200 && j.adopted && arRow(a.ivNo).rtNo === 'RT-29991100002', 'an approved receipt in PEAK is recorded at once: ' + (j.error || j.message));
      ok(db().ReceiptRequests.some((r) => String(r.refDoc).toUpperCase() === a.ivNo && r.status === 'issued' && r.peakRtNo === 'RT-29991100002'), 'and Sales finds it under their receipts');
    }
    setPeak((p) => { p.rtRefuse = []; });
  }

  console.log('── 34. Bank charge taken out of the transfer (the company absorbs it)');
  { const fsx = require('fs'), F = '/tmp/sales-desk-e2e/db.json';
    const T = require('./lib.cjs').T; const raw = JSON.parse(fsx.readFileSync(F, 'utf8'));
    const no = (n) => 'IV-299902000' + n;
    const mkInv = (n, wht) => ({ ivNo: no(n), issueDate: '01/11/2026', segment: 'B2B', salesEmail: BEE, salesName: 'Bee', clientCode: 'C1', company: 'บริษัท ค่าธรรมเนียม ' + n, taxId: '0105540000001', preVat: 1000, creditTermDays: 30, whtRate: wht, docStatus: 'Active', commitDate: '01/12/2026', peakIvId: 'fx' + n });
    raw.Invoices.push(T.Invoices.map((h) => mkInv(11, '0.03')[h] ?? ''), T.Invoices.map((h) => mkInv(12, '0')[h] ?? ''), T.Invoices.map((h) => mkInv(13, '0')[h] ?? ''));
    const pn = { noticeId: 'PAY-FEE-1', createdAt: '20/11/2026 10:00', requestedBy: BEE, salesName: 'Bee', ivNo: no(13), company: 'บริษัท ค่าธรรมเนียม 13', paidDate: '20/11/2026', amount: 1045, paymentMethod: 'Bank Transfer', deliveryChannel: 'sales', status: 'new', source: 'sales' };
    raw.PaymentNotices.push(T.PaymentNotices.map((h) => pn[h] ?? ''));
    fsx.writeFileSync(F, JSON.stringify(raw));
    setPeak((p) => { for (const n of [11, 12, 13]) p.invoices.push({ id: 'fx' + n, code: no(n), status: 'Approve', isVoid: 0, contactCode: 'C1', issuedDate: '20261101', dueDate: '20261201', preTaxAmount: 1000, vatAmount: 70, netAmount: 1070, remainAmount: 1070 }); });
    const slip = { name: 's.png', type: 'image/png', data: 'aGk=' }, mk = { paymentMethodCode: 'BNK001', deliveryChannel: 'sales' };
    const upd = (b) => call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'ar_update', paymentMethod: 'Bank Transfer', file: slip, ...b });
    // A: 3% withheld (1,040 due), 30 taken by the bank → 1,010 in the bank closes the INV.
    [s, j] = await upd({ ivNo: no(11), paidDate: '2026-11-20', paidAmount: 1010, bankFee: -5, deliveryChannel: 'sales' }); ok(s === 400, 'a negative charge is refused');
    [s, j] = await upd({ ivNo: no(11), paidDate: '2026-11-20', paidAmount: 1010, bankFee: 30, deliveryChannel: 'sales' }); ok(s === 200, 'payment with a bank charge is recorded ' + (j.error || ''));
    let a = arRow(no(11)); ok(a.paidDate === '20/11/2026' && Number(a.paidAmount) === 1010 && Number(a.bankFee) === 30, `INV closed: cash 1,010 + charge 30 (${a.paidAmount} / ${a.bankFee})`);
    ok(db().PaymentNotices.some((n) => n.ivNo === no(11) && Number(n.amount) === 1010 && Number(n.bankFee) === 30), 'the round keeps its charge');
    [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'rt_make', ivNo: no(11), ...mk }); ok(s === 200 && /ค่าธรรมเนียมธนาคาร 30\.00/.test(j.message), 'receipt Draft made, with the reminder to book the charge: ' + (j.error || j.message).slice(0, 90));
    let pp = peak().lastRtBody.receipts.paidPayments; ok(pp.payments[0].amount === 1040 && pp.withHoldingTaxAmount === '30.00', `receipt books the whole 1,040 and WHT 30, the charge is not WHT (${pp.payments[0].amount} / ${pp.withHoldingTaxAmount})`);
    // The correction form sets the INV's total charge.
    [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'ar_update', ivNo: no(11), bankFee: 25 }); ok(s === 200 && Number(arRow(no(11)).bankFee) === 25, 'correcting a paid INV replaces the charge');
    // B: paid in rounds, each with a charge.
    [s, j] = await upd({ ivNo: no(12), partial: true, paidDate: '2026-11-18', paidAmount: 500, bankFee: 20 }); ok(s === 200 && j.remaining === 550, 'round 1: 500 + charge 20 leaves 550: ' + (j.error || j.remaining));
    [s, j] = await call(ACCT, 'GET', '/api/invoice-requests?view=ar'); const lr = ((j.rows || j.invoices || []).find((x) => x.ivNo === no(12))) || {};
    ok(lr.expected === 550 && lr.fee === 20, `the list shows 550 still owed (${lr.expected}, charge ${lr.fee})`);
    [s, j] = await upd({ ivNo: no(12), partial: true, paidDate: '2026-11-20', paidAmount: 540, bankFee: 10 }); ok(s === 400 && /ครบ/.test(j.error), 'a round that settles the INV with its charge is not partial');
    [s, j] = await upd({ ivNo: no(12), paidDate: '2026-11-20', paidAmount: 540, bankFee: 10, deliveryChannel: 'sales' }); ok(s === 200, 'last round closes the INV ' + (j.error || ''));
    a = arRow(no(12)); ok(Number(a.paidAmount) === 1040 && Number(a.bankFee) === 30 && a.paidDate, `totals: cash 1,040, charges 30 (${a.paidAmount} / ${a.bankFee})`);
    [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'rt_make', ivNo: no(12), ...mk }); pp = peak().lastRtBody.receipts.paidPayments;
    ok(s === 200 && pp.payments[0].amount === 1070 && !pp.withHoldingTaxAmount, `one receipt for the whole INV: 1,070, no WHT (${pp.payments[0].amount})`);
    // C: Sales reported 1,045; accounting confirms and adds the 25 the bank took.
    [s, j] = await call(BEE, 'PATCH', '/api/invoice-requests', { action: 'pay_confirm', noticeId: 'PAY-FEE-1', bankFee: 25 }); ok(s === 403, 'sales cannot confirm (or add a charge) ' + s);
    [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'pay_confirm', noticeId: 'PAY-FEE-1', bankFee: 25 }); ok(s === 200 && !j.partial, 'confirming with the charge closes the INV ' + (j.error || ''));
    a = arRow(no(13)); ok(a.paidDate && Number(a.paidAmount) === 1045 && Number(a.bankFee) === 25, `cash 1,045 + charge 25 (${a.paidAmount} / ${a.bankFee})`);
  }

  console.log('── 35. Sales pipeline: approved QT → invoiced → collected (pre-VAT)');
  { const fsx = require('fs'), F = '/tmp/sales-desk-e2e/db.json';
    const T = require('./lib.cjs').T; const raw = JSON.parse(fsx.readFileSync(F, 'utf8'));
    const d = new Date(), mm = String(d.getUTCMonth() + 1).padStart(2, '0'), yy = d.getUTCFullYear(), day = `01/${mm}/${yy}`;
    const rq = (n, o) => ({ requestId: 'REQ-PL-' + n, createdAt: day + ' 09:00', requestedBy: BEE, salesName: 'Bee', segment: 'B2B', company: 'บริษัท ไปป์ไลน์ ' + n, status: 'qt_approved', peakQtNo: 'QO-PL-' + n, totalPreVat: 100000, qtApprovedAt: day + ' 10:00', ...o });
    const iv = (n, o) => ({ ivNo: 'IV-PL-' + n, issueDate: day, segment: 'B2B', salesEmail: BEE, salesName: 'Bee', company: 'บริษัท ไปป์ไลน์', preVat: 40000, creditTermDays: 30, whtRate: '0', docStatus: 'Active', commitDate: '28/12/2099', dueDate: '28/12/2099', ...o });
    raw.Requests.push(...[rq(1), rq(2), rq(3, { totalPreVat: '50,000.00', openingInvoiced: 20000 }), rq(4, { status: 'rejected' }), rq(5, { status: 'qt_draft' }), rq(6, { qtApprovedAt: '01/01/2020 10:00', createdAt: '01/01/2020 09:00' })].map((r) => T.Requests.map((h) => r[h] ?? '')));
    raw.Invoices.push(...[
      iv(1, { requestId: 'REQ-PL-1', paidDate: day, paidAmount: 42800 }),            // paid in full
      iv(2, { requestId: 'REQ-PL-1', paidAmount: 21400 }),                           // half paid
      iv(3, { requestId: 'REQ-PL-1', docStatus: 'Cancelled' }),                      // not counted
      iv(4, { qtNo: 'qo-pl-2', preVat: 120000 }),                                    // linked by QT no., capped at the QT
    ].map((r) => T.Invoices.map((h) => r[h] ?? '')));
    fsx.writeFileSync(F, JSON.stringify(raw));
    [s, j] = await call(ACCT, 'GET', '/api/invoice-requests?view=pipeline'); const pl = Object.fromEntries((j.pipeline || []).filter((q) => /^QO-PL-/.test(q.qtNo)).map((q) => [q.qtNo.slice(6), q]));
    ok(s === 200 && Object.keys(pl).sort().join() === '1,2,3,6', 'approved QTs are listed, rejected and draft ones are not: ' + Object.keys(pl).sort().join());
    ok(pl[1] && pl[1].total === 100000 && pl[1].inv === 80000 && pl[1].paid === 60000, `QT 1: invoiced 80,000 (cancelled INV left out), collected 40,000 + half of 40,000 (${pl[1] && [pl[1].inv, pl[1].paid]})`);
    ok(pl[2] && pl[2].inv === 100000 && pl[2].paid === 0, `QT 2: INV matched by QT number, invoiced capped at the QT total (${pl[2] && [pl[2].inv, pl[2].paid]})`);
    ok(pl[3] && pl[3].total === 50000 && pl[3].inv === 20000 && pl[3].paid === 0, `QT 3: amount invoiced before the app counts as invoiced (${pl[3] && [pl[3].total, pl[3].inv]})`);
    [s, j] = await call(ACCT, 'GET', '/api/invoice-requests?view=ar'); ok(s === 200 && j.pipeline === undefined, 'the AR page no longer carries the pipeline');
    const mKey = mm + '/' + yy, sumIm = (d) => (d.invMonths || []).filter((x) => x.m === mKey && x.sales === 'Bee' && x.seg === 'B2B').reduce((o, x) => ({ n: o.n + x.n, inv: o.inv + x.inv, paid: o.paid + x.paid }), { n: 0, inv: 0, paid: 0 });
    [s, j] = await call(ACCT, 'GET', '/api/invoice-requests?view=pipeline'); const base = sumIm(j);
    { const cur = JSON.parse(fsx.readFileSync(F, 'utf8')); cur.Invoices.push(...[iv(5, { preVat: 10000, paidDate: day, paidAmount: 10700 }), iv(6, { preVat: 30000 }), iv(7, { preVat: 5000, docStatus: 'Replaced' }), iv(8, { preVat: 9000, issueDate: '01/01/2015' })].map((r) => T.Invoices.map((h) => r[h] ?? ''))); fsx.writeFileSync(F, JSON.stringify(cur)); }
    [s, j] = await call(ACCT, 'GET', '/api/invoice-requests?view=pipeline'); const im2 = sumIm(j);
    ok(im2.n - base.n === 2 && im2.inv - base.inv === 40000 && im2.paid - base.paid === 10000, `INVs by issue month: +2 INVs, +40,000 issued, +10,000 collected; replaced and 2015 INVs left out (${im2.n - base.n}, ${im2.inv - base.inv}, ${im2.paid - base.paid})`);
  }

  console.log('── 36. edit request closed as "INV cancelled, Sales asks for new INVs" (e.g. split into several)');
  { const fsx = require('fs'), F = '/tmp/sales-desk-e2e/db.json';
    const T = require('./lib.cjs').T; const raw = JSON.parse(fsx.readFileSync(F, 'utf8'));
    const rq = { requestId: 'REQ-RI-1', createdAt: '01/11/2026 09:00', requestedBy: BEE, salesName: 'Bee', segment: 'B2B', company: 'บริษัท แยกใบ จำกัด', status: 'iv_requested', peakQtNo: 'QO-RI-1', totalPreVat: 100000, qtApprovedAt: '01/11/2026 10:00' };
    const vr = { ivRequestId: 'IVR-RI-1', createdAt: '02/11/2026 09:00', requestedBy: BEE, salesName: 'Bee', requestId: 'REQ-RI-1', qtNo: 'QO-RI-1', company: rq.company, amountPreVat: 100000, status: 'iv_issued', peakIvNo: 'IV-RI-1', peakIvId: 'ri1' };
    const iv = { ivNo: 'IV-RI-1', issueDate: '02/11/2026', segment: 'B2B', salesEmail: BEE, salesName: 'Bee', company: rq.company, qtNo: 'QO-RI-1', requestId: 'REQ-RI-1', preVat: 100000, creditTermDays: 30, whtRate: '0', docStatus: 'Active', commitDate: '28/12/2099', dueDate: '28/12/2099', ivRequestId: 'IVR-RI-1', peakIvId: 'ri1' };
    raw.Requests.push(T.Requests.map((h) => rq[h] ?? '')); raw.InvoiceRequests.push(T.InvoiceRequests.map((h) => vr[h] ?? '')); raw.Invoices.push(T.Invoices.map((h) => iv[h] ?? ''));
    fsx.writeFileSync(F, JSON.stringify(raw));
    setPeak((p) => { p.invoices.push({ id: 'ri1', code: 'IV-RI-1', status: 'Approve', isVoid: 0, contactCode: 'C1', issuedDate: '20261102', dueDate: '20261202', preTaxAmount: 100000, vatAmount: 7000, netAmount: 107000, remainAmount: 107000 }); });
    const left = async () => { const [, d] = await call(BEE, 'GET', '/api/requests'); const q = (d.requests || []).find((x) => x.requestId === 'REQ-RI-1'); return q ? q.invoicedPreVat : null; };
    ok(await left() === 100000, 'the QT is fully invoiced before');
    [s, j] = await call(BEE, 'POST', '/api/invoice-requests', { action: 'edit', docType: 'INV', docNo: 'IV-RI-1', refId: 'IVR-RI-1', company: rq.company, detail: 'ขอแยก INV 4 ใบ ตามชื่อผู้เรียน' }); ok(s === 200, 'edit request made ' + (j.error || '')); const ed = j.editId;
    [s, j] = await call(BEE, 'PATCH', '/api/invoice-requests', { action: 'edit_done', editId: ed, voidReissue: true }); ok(s === 403, 'sales cannot cancel');
    [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'edit_done', editId: ed, voidReissue: true }); ok(s === 409 && /void/.test(j.error), 'still approved in PEAK → void it first: ' + j.error);
    setPeak((p) => { p.invoices.find((x) => x.id === 'ri1').status = 'Draft'; });
    [s, j] = await call(ACCT, 'PATCH', '/api/invoice-requests', { action: 'edit_done', editId: ed, voidReissue: true, note: 'ขอใหม่ 4 ใบ ใบละชื่อ' }); ok(s === 200 && j.reissue, 'voided in PEAK → cancelled: ' + (j.error || ''));
    const a2 = arRow('IV-RI-1'), e2 = db().EditRequests.find((x) => x.editId === ed), v2 = ivr('IVR-RI-1');
    ok(a2.docStatus === 'Cancelled', 'INV leaves the debt list as Cancelled');
    ok(v2.status === 'iv_void' && /^รอขอ INV ใหม่/.test(v2.accountNote), 'its request is void and flagged for the QT card: ' + v2.accountNote);
    ok(e2.status === 'done' && !e2.newDocNo && /ขอ INV ใหม่/.test(e2.accountNote) && /ใบละชื่อ/.test(e2.accountNote), 'edit request done, tells Sales to ask again');
    ok(await left() === 0, 'the amount is back on the QT');
    [s, j] = await call(BEE, 'GET', '/api/invoice-requests'); const mineIv = (j.requests || j.invoiceRequests || []).find((x) => x.ivRequestId === 'IVR-RI-1');
    ok(mineIv && /^รอขอ INV ใหม่/.test(mineIv.accountNote || ''), 'the flag reaches the Sales page');
  }

  console.log('── 37. PEAK quotation / invoice reports uploaded for the sales page');
  { const Q = (no, status, pre, o) => ({ no, issue: '05/03/2026', until: '20/03/2026', ref: '', status, company: 'บริษัท รายงาน จำกัด', taxId: '0105540009999', branch: '00000', product: 'Package01 English Training Course', novat: '0', vat0: '0', vat7: String(pre), total: String(pre * 1.07), ...o });
    const I = (no, qt, status, pre, o) => ({ no, issue: '10/03/2026', until: '09/04/2026', ref: qt, sysRef: qt, status, company: 'บริษัท รายงาน จำกัด', taxId: '0105540009999', branch: '00000', product: 'Package01', novat: '0', vat0: '0', vat7: String(pre), total: String(pre * 1.07), ...o });
    const post = (who, b) => call(who, 'POST', '/api/invoice-requests', { action: 'peak_report', ...b });
    const qts = [Q('QO-20260300001', 'ออกครบแล้ว', 1000), Q('QO-20260300002', 'ออกบางส่วน', 2000), Q('QO-20260300003', 'พ้นกำหนด', 4000), Q('QO-20260300004', 'รอตอบรับ', 8000), Q('QO-20260300005', 'ร่าง', 999999),
      Q('QO-20260300006', 'ออกครบแล้ว', 500, { company: 'สมชาย ใจดี', product: '5280 - (Xtra Plus) General English' }), Q('QO-20250300007', 'ออกครบแล้ว', 700, { issue: '05/03/2025' })];
    [s, j] = await post(BEE, { kind: 'qt', rows: qts }); ok(s === 403, 'sales cannot upload ' + s);
    [s, j] = await post(ACCT, { kind: 'qt', rows: [{ no: 'hello', issue: '05/03/2026' }] }); ok(s === 400, 'a row that is not a document is refused: ' + j.error);
    [s, j] = await post(ACCT, { kind: 'qt', rows: qts }); ok(s === 200 && j.added === 7 && j.drafts === 1, `quotation report stored (${j.added} new, ${j.drafts} draft) ` + (j.error || ''));
    [s, j] = await post(ACCT, { kind: 'qt', rows: [Q('QO-20260300004', 'ยอมรับแล้ว', 8000)] }); ok(s === 200 && j.added === 0 && j.updated === 1 && j.total === 7, 'a second upload replaces the same document and keeps the others');
    [s, j] = await post(ACCT, { kind: 'inv', rows: [I('IV-20260300001', 'QO-20260300001', 'รับชำระแล้ว', 1000), I('IV-20260300002', ' qo-20260300002', 'รอชำระ', 500), I('IV-20260300003', 'QO-20260300002', 'รับชำระแล้ว', 300), I('IV-20260300004', '', 'รอชำระ', 100)] });
    ok(s === 200 && j.added === 4 && j.linked === 3, `invoice report stored, 3 of 4 carry a QT number (${j.linked}) ` + (j.error || ''));
    [s, j] = await call(ACCT, 'GET', '/api/invoice-requests?view=pipeline'); const P = Object.fromEntries((j.pipeline || []).filter((q) => /^QO-202[56]0300/.test(q.qtNo)).map((q) => [q.qtNo.slice(-1), q]));
    ok(Object.keys(P).sort().join() === '1,2,3,4,6,7', 'drafts are left out of the pipeline: ' + Object.keys(P).sort().join());
    ok(P[1].st === 'won' && P[1].inv === 1000 && P[1].paid === 1000, `fully invoiced and paid in PEAK (${[P[1].st, P[1].inv, P[1].paid]})`);
    ok(P[2].st === 'part' && P[2].inv === 800 && P[2].paid === 300, `partly invoiced: 800 of 2,000, 300 collected (${[P[2].st, P[2].inv, P[2].paid]})`);
    ok(P[3].st === 'lost' && P[3].inv === 0 && P[4].st === 'lost' && P[4].stale === true && P[4].inv === 0, 'expired = lost; accepted in March and never invoiced = not closed either');
    ok(P[6].st === 'won' && P[6].inv === 500 && P[6].unk === 500 && P[6].paid === 0 && P[6].seg === 'B2C', `fully invoiced without a known INV: counted as invoiced, payment unknown; a person buying a WH package reads as B2C (${[P[6].unk, P[6].seg]})`);
    ok(P[1].seg === 'B2B' && P[7].date === '05/03/2025', 'a company reads as B2B; last year is kept');
    ok(j.reports && j.reports.qt && j.reports.qt.count === 7 && j.reports.inv.count === 4 && j.canUpload === true, 'the page is told what was uploaded');
    // An INV in the AR book for the same number adds what PEAK's report does not say: a part payment and the seller.
    { const fsx = require('fs'), F = '/tmp/sales-desk-e2e/db.json', T = require('./lib.cjs').T, cur = JSON.parse(fsx.readFileSync(F, 'utf8'));
      const v = { ivNo: 'IV-20260300002', issueDate: '10/03/2026', segment: 'B2G', salesEmail: BEE, salesName: 'Bee', company: 'บริษัท รายงาน จำกัด', preVat: 500, creditTermDays: 30, whtRate: '0', docStatus: 'Active', commitDate: '28/12/2099', dueDate: '28/12/2099', paidAmount: 267.5 };
      cur.Invoices.push(T.Invoices.map((h) => v[h] ?? '')); fsx.writeFileSync(F, JSON.stringify(cur)); }
    [s, j] = await call(ACCT, 'GET', '/api/invoice-requests?view=pipeline'); const p2 = (j.pipeline || []).find((q) => q.qtNo === 'QO-20260300002');
    ok(p2 && p2.paid === 550 && p2.sales === 'Bee' && p2.seg === 'B2G', `the AR book adds the part payment (300 + half of 500), the seller and the customer group (${p2 && [p2.paid, p2.sales, p2.seg]})`);
    // Criteria for old data: re-quotes count once, a QT accepted long ago without an INV is not closed.
    const far = '05/01/2020', D2 = (o) => Q('x', 'พ้นกำหนด', 3333, { taxId: '0105540008888', company: 'บริษัท ส่งซ้ำ จำกัด', ...o });
    [s, j] = await post(ACCT, { kind: 'qt', rows: [D2({ no: 'QO-20260400001', issue: '01/04/2026' }), D2({ no: 'QO-20260400002', issue: '10/04/2026' }), D2({ no: 'QO-20260400003', issue: '20/04/2026', status: 'ออกครบแล้ว' }), D2({ no: 'QO-20260400004', issue: '25/04/2026', status: 'รอตอบรับ' }),
      D2({ no: 'QO-20260700001', issue: '20/07/2026' }), D2({ no: 'QO-20260700002', issue: '25/07/2026' }),
      Q('QO-20200100001', 'ยอมรับแล้ว', 5555, { issue: far, until: '20/01/2020', taxId: '0105540007777' }), Q('QO-20991200001', 'ยอมรับแล้ว', 6666, { issue: '01/12/2099', until: '31/12/2099', taxId: '0105540007777' })] });
    ok(s === 200, 'more quotations stored ' + (j.error || ''));
    [s, j] = await call(ACCT, 'GET', '/api/invoice-requests?view=pipeline'); const X = Object.fromEntries((j.pipeline || []).map((q) => [q.qtNo, q]));
    ok(X['QO-20260400001'].dup === 'QO-20260400003' && X['QO-20260400002'].dup === 'QO-20260400003' && !X['QO-20260400003'].dup, 'expired re-quotes of a QT that was sold are counted with it');
    ok(!X['QO-20260400004'].dup, 'a re-quote still waiting for the customer stays (it may be a new order)');
    ok(X['QO-20260700001'].dup === 'QO-20260700002' && !X['QO-20260700002'].dup, 'months later, never sold: only the latest quote counts');
    ok(X['QO-20200100001'].st === 'lost' && X['QO-20200100001'].stale === true && X['QO-20991200001'].st === 'open', 'accepted long ago without an INV = not closed; a recent one stays open');
    ok(j.rules && j.rules.staleDays === 90 && j.rules.dupDays === 30, 'the page is told the rules');
    const ck = j.checks || {}, nos = (k) => (ck[k] || []).map((r) => r.ivNo).join();
    ok(/IV-20260300001/.test(nos('peakOnly')) && /IV-20260300003/.test(nos('peakOnly')) && !/IV-20260300002/.test(nos('peakOnly')), 'checks: INVs in PEAK that the AR book does not have: ' + nos('peakOnly'));
    [s, j] = await call(LEAD, 'GET', '/api/invoice-requests?view=pipeline'); ok(s === 200 && j.checks === undefined && j.canUpload === false, 'the checks are for accounting and admins only');
  }
  done();
})().catch((e) => { console.error('CRASH', e); ok(false, 'CRASH: the run stopped early: ' + e.message); done(); process.exitCode = 1; });
