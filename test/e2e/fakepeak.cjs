// Fake PEAK for local runs: patches global fetch for api.peakaccount.com. State lives in a JSON file
// (FAKE_PEAK_FILE) so a test can play "accounting in PEAK" by editing it.
const fs = require('fs');
const FILE = process.env.FAKE_PEAK_FILE;
const real = global.fetch;
const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } };
const save = (s) => fs.writeFileSync(FILE, JSON.stringify(s, null, 1));
const n = (x) => Number(String(x ?? '').replace(/,/g, '')) || 0;
const r2 = (x) => Math.round(x * 100) / 100;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

function totals(d) {
  const gross = (d.products || []).reduce((s, p) => s + n(p.quantity) * (n(p.price) - n(p.discount)), 0) - n(d.discountTotal);
  const incl = Number(d.taxStatus) === 1;
  d.preTaxAmount = r2(incl ? gross / 1.07 : gross);
  d.netAmount = r2(incl ? gross : gross * 1.07);
  d.vatAmount = r2(d.netAmount - d.preTaxAmount);
  d.withHoldingTaxAmount = r2((d.products || []).reduce((s, p) => s + n(p.withHoldingTaxAmount), 0));
  return d;
}
function seq(s, pre) { s.seq = s.seq || {}; s.seq[pre] = (s.seq[pre] || 500) + 1; return `${pre}-202611${String(s.seq[pre]).padStart(5, '0')}`; }
function pick(list, q) {
  if (q.id) return list.filter((x) => x.id === q.id);
  if (q.code) return list.filter((x) => x.code === q.code);
  return list;
}

global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (u.hostname !== 'api.peakaccount.com') return real(url, opts);
  const s = load(); s.calls = s.calls || [];
  const path = u.pathname.replace('/api/v1', ''); const q = Object.fromEntries(u.searchParams);
  const body = opts.body ? JSON.parse(opts.body) : null; const m = (opts.method || 'GET').toUpperCase();
  s.calls.push(`${m} ${path}${u.search}`);
  for (const f of ['quotations', 'invoices', 'receipts', 'contacts', 'services', 'classes']) s[f] = s[f] || (f === 'classes' ? {} : []);
  if (s.fail && new RegExp(s.fail).test(`${m} ${path}`)) { save(s); return json({ error: 'boom' }, 500); }
  let out;
  if (path === '/ClientToken') out = { PeakClientToken: { token: 'tok', resCode: '200' } };
  else if (m === 'GET' && path === '/Contacts') out = { PeakContacts: { resCode: '200', contacts: s.contacts.filter((c) => c.taxNumber === q.taxId && (!q.branchCode || (c.branchCode || '00000') === q.branchCode)) } };
  else if (m === 'POST' && path === '/Contacts') {
    const c = { ...body.PeakContacts.contacts[0] }; c.id = 'c' + (s.contacts.length + 1); c.code = 'CN' + String(s.contacts.length + 1).padStart(4, '0'); c.resCode = '200';
    s.contacts.push(c); out = { PeakContacts: { resCode: '200', contacts: [c] } };
  } else if (m === 'GET' && path === '/Quotations') out = { PeakQuotations: { resCode: '200', quotations: pick(s.quotations, q) } };
  else if (m === 'POST' && path === '/Quotations') {
    const d = totals({ ...body.PeakQuotations.quotations[0] }); d.id = 'q' + (s.quotations.length + 1); d.code = seq(s, 'QO');
    d.documentLink = 'https://doc.peakaccount.com/quotation?emi=' + d.id; d.isVoid = 0; d.resCode = '200';
    d.products = (d.products || []).map((p, i) => ({ id: 'L' + (i + 1), ...p }));
    s.quotations.push(d); out = { PeakQuotations: { resCode: '200', quotations: [d] } };
  } else if (m === 'GET' && path === '/Invoices') out = { PeakInvoices: { resCode: '200', invoices: pick(s.invoices, q) } };
  else if (m === 'POST' && path === '/Invoices/createbyquotation') {
    const b = body.PeakInvoices; const qt = s.quotations.find((x) => x.id === b.quotationId || x.code === b.quotationCode);
    if (!qt) { save(s); return json({ PeakInvoices: { resCode: '404', resDesc: 'quotation not found: ' + (b.quotationId || b.quotationCode) } }); }
    const iv = { ...b.invoices }; iv.products = (iv.products && iv.products.length ? iv.products : JSON.parse(JSON.stringify(qt.products))).map((p, i) => ({ id: 'L' + (i + 1), ...p }));
    iv.contactCode = qt.contactCode; iv.referenceCode = qt.code; totals(iv);
    iv.id = 'i' + (s.invoices.length + 1); iv.code = seq(s, 'IV'); iv.isVoid = 0; iv.resCode = '200'; iv.remainAmount = iv.netAmount;
    iv.documentLink = 'https://doc.peakaccount.com/invoice?emi=' + iv.id;
    s.invoices.push(iv); out = { PeakInvoices: { resCode: '200', invoices: [iv] } };
  } else if (m === 'POST' && path === '/Invoices/edit') {
    const b = body.PeakInvoices; const iv = s.invoices.find((x) => x.code === b.code);
    if (!iv) { save(s); return json({ PeakInvoices: { resCode: '404', resDesc: 'no invoice' } }); }
    if (iv.status !== 'Draft') { save(s); return json({ PeakInvoices: { resCode: '400', resDesc: 'not draft' } }); }
    Object.assign(iv, b.invoices); totals(iv); iv.remainAmount = iv.netAmount; out = { PeakInvoices: { resCode: '200', invoices: [iv] } };
  } else if (m === 'GET' && path === '/Receipts') out = { PeakReceipts: { resCode: '200', receipts: pick(s.receipts, q) } };
  else if (m === 'POST' && path === '/Receipts/createbyinvoice') {
    const b = body.PeakReceipts; const r = { ...[].concat(b.receipts)[0] }; s.lastRtBody = b;
    r.id = 'r' + (s.receipts.length + 1); r.code = seq(s, 'RT'); r.isVoid = 0; r.resCode = '200'; r.documentLink = 'https://doc.peakaccount.com/receipt?emi=' + r.id;
    s.receipts.push(r); out = { PeakReceipts: { resCode: '200', receipts: [r] } };
  } else if (m === 'GET' && path === '/PaymentMethods') out = { PeakPaymentMethods: { resCode: '200', totalPaymentMethod: 2, paymentMethods: [{ code: 'CSH001', name: 'เงินสด', type: 1 }, { code: 'BNK001', name: 'KBank ออมทรัพย์', type: 2 }] } };
  else if (m === 'GET' && path === '/Classification') out = { peakClassification: { resCode: '200', classificationGroup: s.groups || [] } };
  else if (m === 'GET' && path === '/Classification/transaction') {
    const key = q.transactionId || q.transactionCode; const c = s.classes[key] || {};
    out = { peakClassification: { resCode: '200', classifications: Object.entries(c).map(([g, num]) => ({ classificationGroupCode: g, classificationItemList: [{ number: num, percent: 100 }] })) } };
  } else if (m === 'POST' && path === '/Classification/transaction') {
    const b = body.PeakClassifications; const c = b.classifications;
    (s.classes[b.transactionId] = s.classes[b.transactionId] || {})[c.classificationGroupCode] = c.classificationItemList[0].number;
    out = { PeakClassifications: { resCode: '200' } };
  } else if (m === 'GET' && path === '/Services/list') {
    const t = String(q.searchText || '').toLowerCase(); const page = Number(q.page || 1);
    out = { PeakServices: { resCode: '200', services: page > 1 ? [] : s.services.filter((x) => (x.code + ' ' + x.name).toLowerCase().includes(t)) } };
  } else if (m === 'GET' && path === '/Services') out = { PeakServices: { resCode: '200', services: s.services.filter((x) => x.id === q.id) } };
  else if (/insertfile$/.test(path)) { s.files = (s.files || 0) + 1; out = { ok: { resCode: '200' } }; }
  else { save(s); return json({ error: 'fake PEAK: no route ' + m + ' ' + path }, 404); }
  save(s);
  return json(out);
};
