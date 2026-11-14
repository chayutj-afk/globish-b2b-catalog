const { call, ok, done, B, ck } = require('./lib.cjs');
(async () => {
  const A = 'admin@globish.co.th', S = 'benz@globish.co.th';
  const junk = [null, undefined, '', 0, -1, 1e21, NaN, true, [], {}, [[]], { a: { b: 1 } }, 'x'.repeat(5000), '<script>alert(1)</script>', "'; DROP TABLE--", '=1+1', '../../etc/passwd', '\u0000\u0001', '🙂'.repeat(50)];
  let n = 0; const five = [];
  const hit = async (who, m, u, body) => { n++; const [s, j] = await call(who, m, u, body).catch((e) => [599, { error: e.message }]); if (s >= 500) five.push(`${s} ${m} ${u} ${JSON.stringify(body).slice(0, 90)} → ${(j.error || '').slice(0, 80)}`); return s; };
  for (const v of junk) {
    await hit(S, 'POST', '/api/requests', v);
    await hit(S, 'POST', '/api/requests', { customerType: v, dealType: v, company: v, taxId: v, branch: v, docLang: v, wantedQtDate: v, creditTermDays: v, opportunityId: v, whtRate: v, customerEmail: v, items: v, newContact: v, classPicks: v, replaces: v });
    await hit(S, 'POST', '/api/requests', { customerType: 'G012-00001', dealType: 'New Logo', company: 'c', taxId: '0105555555554', branch: '00000', docLang: 'TH', wantedQtDate: '2026-11-16', creditTermDays: 30, opportunityId: 'CRM-OPP-2026-00123', whtRate: '3', customerEmail: 'a@b.co', items: [v, { kind: v, code: v, qty: v, unitPrice: v, discount: v, keyHS: v, packageId: v, extra: v, freebie: v }] });
    await hit(S, 'POST', '/api/invoice-requests', { requestId: v, qtNo: v, whtRate: v, company: v, taxId: v, branch: v, evidenceType: v, poNeeded: v, financeContact: v, financeEmail: v, financePhone: v, file: v, docs: v, invoices: v });
    await hit(S, 'POST', '/api/invoice-requests', { qtNo: 'QO-1', whtRate: '0', company: 'c', taxId: '0105555555554', branch: '00000', evidenceType: 'PO จากลูกค้า', poNeeded: 'no', financeContact: 'f', financeEmail: 'f@x.co', financePhone: '0812345678', offReason: 'x', customerType: 'G012-00001', opportunityId: 'CRM-OPP-2026-00001', file: v, invoices: [v, { amount: v, students: v, wantedIssueDate: v, creditTermDays: v, originalDoc: v, billTo: v }] });
    for (const act of ['receipt', 'edit', 'pay_notice', 'legacy_import']) await hit(A, 'POST', '/api/invoice-requests', { action: act, ivRequestId: v, docType: v, docNo: v, detail: v, segment: v, customerType: v, docKind: v, billName: v, taxId: v, price: v, paidDate: v, amount: v, paymentMethod: v, deliveryChannel: v, file: v, invoices: v, quotations: v, followUps: v, classPicks: v });
    for (const act of ['approve', 'reject', 'reopen', 'retry', 'qt_approved', 'qt_voided', 'qt_fixed', 'qt_refreshed', v]) await hit(A, 'PATCH', '/api/requests', { requestId: v, action: act, note: v, seen: v });
    for (const act of ['original', 'original_sent', 'iv_make', 'iv_check', 'issued', 'reject', 'reopen', 'ar_owner', 'ar_refresh', 'ar_reclass', 'ar_followup', 'ar_update', 'rt_from_inv', 'rt_make', 'rt_check', 'rt_issued', 'rt_reject', 'rt_reopen', 'rt_sent', 'edit_done', 'edit_reject', 'pay_confirm', 'pay_reject', v])
      await hit(A, 'PATCH', '/api/invoice-requests', { action: act, ivRequestId: v, ivNo: v, rtRequestId: v, editId: v, noticeId: v, salesEmail: v, note: v, peakIvNo: v, peakDocLink: v, issueDate: v, paidDate: v, paidAmount: v, paymentMethod: v, docStatus: v, channel: v, result: v, kind: v, offset: v, limit: v, trackingNo: v, newDocNo: v, newLink: v, newAmount: v, file: v, paymentMethodCode: v, deliveryChannel: v });
    for (const act of ['add_user', 'type', 'classes', 'test_chat', v]) await hit(A, 'PATCH', '/api/users', { action: act, email: v, name: v, role: v, team: v, extra: v, classItems: v, code: v, vat: v, kinds: v, opp: v, svcGroups: v, group: v, mode: v, segments: v });
    for (const u of ['/api/contacts?taxId=', '/api/services?q=', '/api/requests?view=qt-live&id=', '/api/requests?view=', '/api/invoice-requests?view=', '/api/users?view=', '/api/wh-packages?q=']) await hit(A, 'GET', u + encodeURIComponent(String(v)));
    for (const t of ['quotation', 'invoice', 'receipt', 'x']) { n++; const r = await fetch(B + '/api/users?view=peak-hook&type=' + t, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': 'hookkey123' }, body: JSON.stringify({ Peak: { docs: [v, { id: v, code: v, status: v, products: v, paidPayments: v, issuedDate: v, preTaxAmount: v }] }, eventType: v }) }); if (r.status >= 500) five.push(`${r.status} hook ${t} ${JSON.stringify(v).slice(0, 60)}`); }
  }
  // raw non-JSON bodies
  for (const u of ['/api/requests', '/api/invoice-requests', '/api/users']) for (const m of ['POST', 'PATCH', 'PUT', 'DELETE']) { n++; const r = await fetch(B + u, { method: m, headers: { Cookie: ck(A), Origin: B, 'Content-Type': 'application/json' }, body: '{bad json' }); if (r.status >= 500) five.push(`${r.status} ${m} ${u} raw`); }
  ok(five.length === 0, `${n} malformed requests: no server error (5xx)` + (five.length ? '\n   ' + [...new Set(five)].slice(0, 25).join('\n   ') + `\n   (${five.length} total)` : ''));
  done();
})();
