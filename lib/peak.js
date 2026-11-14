// PEAK Open API: quotations as Draft, for accounting to review and approve in PEAK.
//
// PEAK_MODE  off (default) | uat | prod
//   off  → nothing is sent; the request stays "new" in the Revenue Hub.
//   uat  → https://peakengineapidev.azurewebsites.net/api/v1
//   prod → https://api.peakaccount.com/api/v1
//
// Credentials (Vercel env only): PEAK_CONNECT_ID, PEAK_PASSWORD (both sent by PEAK for the
// app "Globish Sales Desk"), PEAK_USER_TOKEN (made in PEAK → ตั้งค่า → เชื่อมต่อแอปพลิเคชันภายนอก
// with the Application Code, while signed in as the PEAK user whose rights the app should have).
//
// Signing (PEAK client-token guide, checked 11 Nov 2026):
//   Time-Stamp     = yyyyMMddHHmmss, UTC+0 only
//   Time-Signature = HMAC-SHA1(Time-Stamp, key = connectId)
//   ClientToken body = { PeakClientToken: { connectId, password } } → { PeakClientToken: { token, resCode } }, valid 24 h
// The guide still doesn't say hex or base64. Default hex (PEAK's Postman collection uses
// CryptoJS); set PEAK_SIG_ENCODING=base64 if UAT answers "Invalid TimeSignature".
//
// Limits (PEAK "API Rate Limiting & Concurrency Control"):
//   ClientToken 10/min per IP; per User Token 20 concurrent GET, 10 concurrent POST.
//   429 body: { error: "RATE_LIMITED", type, policy, retryAfterSeconds }. Wait, don't hammer.
// Data limits per request: 10 documents, 100 lines per document, 10 tags per document.
//
// Safety: this module only creates documents as Draft. PEAK approves a document when status is
// omitted (createbyquotation says so explicitly), so every create sets status 'Draft' and
// refuses anything else. There is no approve, void or contact-create call here on purpose.

const crypto = require('crypto');

const BASE = {
  uat: 'https://peakengineapidev.azurewebsites.net/api/v1',
  prod: 'https://api.peakaccount.com/api/v1',
};

let forced = null; // set only by testConnection (read-only check while PEAK_MODE is still off)
function mode() {
  if (forced) return forced;
  const m = String(process.env.PEAK_MODE || 'off').toLowerCase();
  return BASE[m] ? m : 'off';
}

function stamp(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function signature(ts, connectId, enc = process.env.PEAK_SIG_ENCODING) {
  return crypto.createHmac('sha1', connectId).update(ts).digest(String(enc || '').toLowerCase() === 'base64' ? 'base64' : 'hex');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Per-instance concurrency gate under PEAK's per-User-Token caps (GET 20, POST 10).
function gate(max) {
  let running = 0; const queue = [];
  const next = () => { if (running < max && queue.length) { running++; queue.shift()(); } };
  return async (fn) => {
    await new Promise((r) => { queue.push(r); next(); });
    try { return await fn(); } finally { running--; next(); }
  };
}
const gates = { GET: gate(10), POST: gate(5) };

let clientToken = null; // { token, exp } cached per instance (valid 24 h; endpoint allows 10/min per IP)

function fail(msg, extra = {}) { return Object.assign(new Error(msg), { status: 502 }, extra); }

// PEAK often answers HTTP 200 with an error inside: { PeakX: { resCode: "4xx", resDesc } }.
function resCodeOf(data) {
  if (!data || typeof data !== 'object') return null;
  const inner = Object.values(data).find((v) => v && typeof v === 'object' && 'resCode' in v);
  return inner ? { code: String(inner.resCode), desc: inner.resDesc || '' } : null;
}

async function request(method, path, { body, query, withClientToken = true, retries = 3 } = {}) {
  const m = mode();
  if (m === 'off') throw Object.assign(new Error('PEAK_MODE = off'), { status: 503 });
  const connectId = process.env.PEAK_CONNECT_ID;
  if (!connectId) throw Object.assign(new Error('Server ยังไม่ได้ตั้งค่า PEAK_CONNECT_ID'), { status: 500 });
  if (withClientToken && !process.env.PEAK_USER_TOKEN) throw Object.assign(new Error('Server ยังไม่ได้ตั้งค่า PEAK_USER_TOKEN'), { status: 500 });
  const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== '')).toString() : '';
  let tokenRefreshed = false;
  for (let attempt = 0; ; attempt++) {
    const ts = stamp();
    const headers = { 'Content-Type': 'application/json', 'Time-Stamp': ts, 'Time-Signature': signature(ts, connectId) };
    if (withClientToken) {
      headers['Client-Token'] = await getClientToken();
      headers['User-Token'] = process.env.PEAK_USER_TOKEN;
    }
    const send = () => fetch(BASE[m] + path + qs, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await (gates[method] || gates.POST)(send);
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (res.status === 429) {
      if (attempt >= retries) throw fail(`PEAK 429 ${data.policy || ''}: ส่งคำขอถี่เกินไป`, { rateLimited: true });
      const header = Number(res.headers.get && res.headers.get('retry-after'));
      const wait = (Number.isFinite(header) && header > 0 ? header : Number(data.retryAfterSeconds) || 2 ** attempt) * 1000;
      await sleep(Math.min(wait, 20000));
      continue;
    }
    // An expired or rejected Client-Token: drop the cache and try once more.
    if (withClientToken && !tokenRefreshed && (res.status === 401 || /client[- ]?token/i.test(text) && /invalid|expire|unauthor/i.test(text))) {
      clientToken = null; tokenRefreshed = true; continue;
    }
    if (!res.ok) throw fail(`PEAK ${res.status}: ${text.slice(0, 300)}`);
    const rc = resCodeOf(data);
    if (rc && rc.code !== '200') throw fail(`PEAK ${rc.code}: ${rc.desc}`.slice(0, 300), { resCode: rc.code });
    return data;
  }
}

const call = (path, body, opts = {}) => request('POST', path, { ...opts, body });
const get = (path, query, opts = {}) => request('GET', path, { ...opts, query });

async function getClientToken() {
  if (clientToken && Date.now() < clientToken.exp) return clientToken.token;
  if (!process.env.PEAK_PASSWORD) throw Object.assign(new Error('Server ยังไม่ได้ตั้งค่า PEAK_PASSWORD'), { status: 500 });
  const data = await call('/ClientToken', {
    PeakClientToken: { connectId: process.env.PEAK_CONNECT_ID, password: process.env.PEAK_PASSWORD },
  }, { withClientToken: false, retries: 1 });
  const t = data && data.PeakClientToken;
  if (!t || !t.token) throw fail('PEAK ไม่ออก Client Token');
  clientToken = { token: t.token, exp: Date.now() + 23 * 3600e3 };
  return t.token;
}

const ymd = (s) => {
  // accepts yyyy-mm-dd
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  return m ? `${m[1]}${m[2]}${m[3]}` : null;
};

// PEAK applies a product line's `discount` to EACH unit (tested 2026-11-10: qty 2,
// discount 1590 → 3180 off). Our lines store the discount for the whole line, so divide.
function unitDiscount(l) {
  const d = Number(l.discount) || 0;
  const q = Number(l.qty) || 0;
  if (!d || !q) return undefined;
  return String(Math.round((d / q) * 100) / 100);
}

// lines: [{ role, keyHS, component, description, qty, unitPrice }]
// serviceCode(line) → PEAK product/service code or '' (unmapped).
// Withholding tax per line = rate × line amount after discount (PEAK takes an amount, as text).
// WHT is on the amount before VAT: with VAT-inclusive prices, take VAT out first.
function whtOf(l, rate, incl = false) {
  const r = Number(rate) || 0;
  if (!r) return undefined;
  const gross = (Number(l.qty) || 0) * (Number(l.unitPrice) || 0) - (Number(l.discount) || 0);
  const net = incl ? gross / 1.07 : gross;
  return net > 0 ? String(Math.round(net * r) / 100) : '0';
}

// request.vatMode 'incl' → line prices include VAT (B2C / B2E / MaoMao / Others): taxStatus 1.
function buildQuotation(request, lines, serviceCode, today = new Date()) {
  const missing = [];
  const incl = request.vatMode === 'incl';
  const products = lines.map((l) => {
    const code = serviceCode(l);
    if (!code) missing.push(l.role === 'supplement' ? `ส่วนเสริม "${l.component}"` : l.role === 'surcharge' ? `surcharge` : `แพ็กเกจ ${l.packageId}`);
    return { productCode: code || undefined, description: l.description, quantity: l.qty, price: l.unitPrice, discount: unitDiscount(l), vatType: 3, withHoldingTaxAmount: whtOf(l, request.whtRate, incl) };
  });
  // A per-unit discount that doesn't divide evenly leaves satang (1000 / 3 → 999.99).
  // Then move every line discount into PEAK's document-level discountTotal (exact; all lines are VAT 7%).
  const uneven = lines.some((l, i) => {
    const d = Number(l.discount) || 0;
    return d && Math.abs(Number(products[i].discount) * Number(l.qty) - d) > 0.001;
  });
  let discountTotal;
  if (uneven) {
    discountTotal = String(Math.round(lines.reduce((s, l) => s + (Number(l.discount) || 0), 0) * 100) / 100);
    products.forEach((x) => { delete x.discount; });
  }
  const issuedDate = ymd(request.wantedQtDate) || stamp(today).slice(0, 8);
  return {
    missing: [...new Set(missing)],
    body: {
      PeakQuotations: {
        quotations: [{
          issuedDate,
          dueDate: addDays(issuedDate, 30), // PEAK rejects a QT without dueDate (QT validity)
          contactCode: request.clientCode || undefined,
          reference: request.requestId,
          remark: [request.company, request.taxId ? `Tax ID ${request.taxId}` : '', request.opportunityId, request.note].filter(Boolean).join(' · ').slice(0, 1000),
          tags: [request.opportunityId, request.requestId].filter(Boolean),
          taxStatus: incl ? 1 : 0, // 0 = prices exclude VAT, 1 = include VAT
          discountTotal,
          status: 'Draft',
          products,
        }],
      },
    },
  };
}

// A document inside a 200 response can still carry its own error code.
function docOk(d) {
  if (!d) throw fail('PEAK ไม่ส่งเอกสารที่สร้างกลับมา');
  if (d.resCode && String(d.resCode) !== '200') throw fail(`PEAK ${d.resCode}: ${d.resDesc || ''}`.slice(0, 300), { resCode: String(d.resCode) });
}

function assertDraft(docs) {
  for (const d of [].concat(docs || [])) {
    if (!d || d.status !== 'Draft') throw Object.assign(new Error('PEAK: สร้างได้เฉพาะเอกสารสถานะ Draft'), { status: 500 });
  }
}

async function createQuotationDraft(body) {
  assertDraft(body && body.PeakQuotations && body.PeakQuotations.quotations);
  const data = await call('/Quotations', body, { query: { getResult: 1 }, retries: 2 }); // a 429 is rejected before processing, so a retry can't duplicate
  const q = data && data.PeakQuotations && (data.PeakQuotations.quotations || [])[0];
  docOk(q);
  return { id: q && q.id, code: q && q.code, raw: data };
}

// Contacts by tax ID + branch (PEAK GET /Contacts?taxId=&branchCode=). Read-only.
// PEAK stores some tax IDs with dashes (133 in the 10 Nov export); those won't match a plain
// 13-digit search, so a miss here is "not found in PEAK by this exact tax ID", not proof of absence.
async function findContacts(taxId, branchCode) {
  const tax = String(taxId || '').replace(/\D/g, '');
  if (tax.length !== 13) throw Object.assign(new Error('เลขผู้เสียภาษีต้องมี 13 หลัก'), { status: 400 });
  const branch = /^\d{5}$/.test(String(branchCode || '')) ? String(branchCode) : undefined; // none = every branch
  const dashed = `${tax[0]}-${tax.slice(1, 5)}-${tax.slice(5, 10)}-${tax.slice(10, 12)}-${tax[12]}`;
  const seen = new Map();
  for (const t of [tax, dashed]) {
    const data = await get('/Contacts', { taxId: t, branchCode: branch });
    for (const c of (data && data.PeakContacts && data.PeakContacts.contacts) || []) {
      if (String(c.taxNumber || '').replace(/\D/g, '') !== tax) continue;
      const b = c.branchCode || '00000';
      if (branch && b !== branch) continue;
      seen.set(c.id || c.code, { id: c.id, code: c.code, name: c.name, taxNumber: c.taxNumber, branchCode: b, type: c.type });
    }
  }
  return [...seen.values()];
}

// New customer (POST /Contacts). Only called when accounting approves a request whose tax ID + branch
// PEAK does not have. Returns { id, code, name }.
async function createContact(contact) {
  const data = await call('/Contacts', { PeakContacts: { contacts: [contact] } }, { retries: 1 });
  const c = data && data.PeakContacts && (data.PeakContacts.contacts || [])[0];
  docOk(c);
  if (!c.code) throw fail('PEAK ไม่ส่งรหัสลูกค้ากลับมา');
  return { id: c.id, code: c.code, name: c.name };
}

// Admin check: token + one contact lookup, read-only. Works even while PEAK_MODE is off (uses prod).
// Never returns token values.
async function testConnection(taxId) {
  const was = forced;
  const target = mode() === 'off' ? 'prod' : mode();
  forced = target;
  const out = { mode: String(process.env.PEAK_MODE || 'off'), target,
    env: { connectId: !!process.env.PEAK_CONNECT_ID, password: !!process.env.PEAK_PASSWORD, userToken: !!process.env.PEAK_USER_TOKEN, webhookKey: !!process.env.PEAK_WEBHOOK_KEY } };
  try {
    clientToken = null;
    await getClientToken();
    out.token = 'ok';
    if (taxId) { const cs = await findContacts(taxId); out.contacts = cs.map((c) => `${c.code} ${c.name} (${c.branchCode})`); }
    out.ok = true;
  } catch (e) { out.ok = false; out.error = String(e.message).slice(0, 300); }
  finally { forced = was; clientToken = null; }
  return out;
}

// One quotation by PEAK id (Requests column R). Read-only.
// QTs imported from before the app carry "legacy:QO-…" until first used: PEAK's list API gives no ids,
// so the real one is looked up by document number (skipping a voided twin with the same number).
async function getQuotation(id) {
  if (String(id || '').startsWith('legacy:')) return findQuotationByCode(String(id).slice(7));
  const data = await get('/Quotations', { id });
  return ((data && data.PeakQuotations && data.PeakQuotations.quotations) || [])[0] || null;
}

async function findQuotationByCode(code) {
  const data = await get('/Quotations', { code });
  const list = (data && data.PeakQuotations && data.PeakQuotations.quotations) || [];
  return list.find((q) => q && q.id && Number(q.isVoid) !== 1 && !/void/i.test(q.status || '')) || null;
}

// One invoice / receipt by document number (imported rows have no PEAK id). Skips a voided twin unless
// that is all there is (so a void still shows). Read-only.
async function findInvoiceByCode(code) {
  const data = await get('/Invoices', { code });
  const list = ((data && data.PeakInvoices && data.PeakInvoices.invoices) || []).filter((x) => x && x.id);
  return list.find((x) => Number(x.isVoid) !== 1 && !/void/i.test(x.status || '')) || list[0] || null;
}
async function findReceiptByCode(code) {
  const data = await get('/Receipts', { code });
  const box = data && (data.PeakReceipts || data.peakReceipts);
  const list = ((box && box.receipts) || []).filter((x) => x && x.id);
  return list.find((x) => Number(x.isVoid) !== 1 && !/void/i.test(x.status || '')) || list[0] || null;
}

// Classification items on one document, as { G013: 'G013-00001', G014: 'B2B-S001' } (first item per group).
//   type: 101 quotation, 102 invoice, 103 receipt. Read-only.
async function getClassifications(transactionId, type, transactionCode) {
  const data = await get('/Classification/transaction', transactionId ? { transactionId, transactionType: type } : { transactionCode, transactionType: type });
  const box = data && (data.peakClassification || data.PeakClassification || data.PeakClassifications);
  const out = {};
  for (const c of (box && box.classifications) || []) {
    const it = (c.classificationItemList || [])[0];
    if (c.classificationGroupCode && it && it.number) out[c.classificationGroupCode] = it.number;
  }
  return out;
}

// One invoice by PEAK id. Read-only.
async function getInvoice(id) {
  const data = await get('/Invoices', { id });
  return ((data && data.PeakInvoices && data.PeakInvoices.invoices) || [])[0] || null;
}

// INV as Draft, linked to its QT in PEAK (POST /Invoices/createbyquotation). PEAK puts the
// QT number in the invoice's Reference. Used only if accounting decides the app may draft INVs;
// not wired into any page yet.
//   inv: { quotationId | quotationCode, issuedDate (yyyy-mm-dd), creditTermDays, reference,
//          remark, tags, lines?: [{ productCode, description, qty, unitPrice, discount }], whtRate }
//   Without lines PEAK copies the QT lines (whole QT). With lines (an instalment) they replace them.
function buildInvoiceFromQuotation(inv, today = new Date()) {
  if (!inv.quotationId && !inv.quotationCode) throw Object.assign(new Error('ต้องมี QT id หรือเลข QT'), { status: 400 });
  const issuedDate = ymd(inv.issuedDate) || stamp(today).slice(0, 8);
  const days = Math.max(0, Number(inv.creditTermDays) || 0);
  const invoice = {
    issuedDate,
    dueDate: addDays(issuedDate, days), // credit term in days; 0 = due on the issue date
    reference: inv.reference || undefined,
    remark: inv.remark ? String(inv.remark).slice(0, 1000) : undefined,
    tags: (inv.tags || []).filter(Boolean).slice(0, 10),
    taxStatus: inv.vatMode === 'incl' ? 1 : 0,
    status: 'Draft',
  };
  if (inv.lines && inv.lines.length) {
    if (inv.lines.length > 100) throw Object.assign(new Error('PEAK รับได้ไม่เกิน 100 บรรทัดต่อเอกสาร'), { status: 400 });
    invoice.products = inv.lines.map((l) => ({
      productCode: l.productCode || undefined, description: l.description, quantity: l.qty, price: l.unitPrice,
      discount: unitDiscount(l), vatType: 3, withHoldingTaxAmount: whtOf(l, inv.whtRate, inv.vatMode === 'incl'),
    }));
  }
  return { PeakInvoices: { quotationId: inv.quotationId || undefined, quotationCode: inv.quotationId ? undefined : inv.quotationCode, invoices: invoice } };
}

async function createInvoiceFromQuotationDraft(body) {
  assertDraft(body && body.PeakInvoices && body.PeakInvoices.invoices);
  const data = await call('/Invoices/createbyquotation', body, { query: { getResult: 1 }, retries: 2 });
  const iv = data && data.PeakInvoices && [].concat(data.PeakInvoices.invoices || [])[0];
  docOk(iv);
  return { id: iv && iv.id, code: iv && iv.code, status: iv && iv.status, raw: data };
}

// Edit an INV Draft the app itself just made (POST /Invoices/edit). PEAK approves the document when
// status is left out, so it is always sent as Draft; anything not Draft is refused here.
async function editInvoiceDraft(code, invoice) {
  if (!code) throw Object.assign(new Error('ต้องมีเลข INV'), { status: 400 });
  const inv = { ...invoice, code, status: 'Draft' };
  assertDraft(inv);
  const data = await call('/Invoices/edit', { PeakInvoices: { code, invoices: inv } }, { query: { getResult: 1 }, retries: 1 });
  const iv = data && data.PeakInvoices && [].concat(data.PeakInvoices.invoices || [])[0];
  docOk(iv);
  return { id: iv && iv.id, code: iv && iv.code };
}

// Receipt from a paid invoice, as Draft (POST /Receipts/createbyinvoice). Accounting approves it in PEAK.
async function createReceiptFromInvoiceDraft(body) {
  assertDraft(body && body.PeakReceipts && body.PeakReceipts.receipts);
  const data = await call('/Receipts/createbyinvoice', body, { query: { getResult: 1 }, retries: 2 });
  const box = data && (data.PeakReceipts || data.peakReceipts);
  const rt = box && [].concat(box.receipts || [])[0];
  docOk(rt);
  return { id: rt && rt.id, code: rt && rt.code, documentLink: rt && rt.documentLink, raw: data };
}

async function getReceipt(id) {
  const data = await get('/Receipts', { id });
  const box = data && (data.PeakReceipts || data.peakReceipts);
  return ((box && box.receipts) || [])[0] || null;
}

// Where money can be received (PEAK payment methods: 1 cash, 2 bank account, 4 e-wallet), cached 1 h.
let payMethods = null;
async function listPaymentMethods() {
  if (payMethods && Date.now() - payMethods.at < 3600e3) return payMethods.list;
  const all = [];
  for (let page = 1; page <= 30; page++) {
    const data = await get('/PaymentMethods', { page });
    const box = data && (data.PeakPaymentMethods || data.peakPaymentMethods);
    const xs = (box && box.paymentMethods) || [];
    all.push(...xs);
    if (!xs.length || all.length >= Number(box.totalPaymentMethod || 0)) break;
  }
  const list = all.filter((m) => [1, 2, 4].includes(Number(m.type))).map((m) => ({ code: m.code, name: m.name, type: Number(m.type) }))
    .sort((a, b) => a.type - b.type || String(a.code).localeCompare(String(b.code)));
  payMethods = { at: Date.now(), list };
  return list;
}

// Classification groups with their items (GET /Classification). Read-only.
async function listClassificationGroups() {
  const data = await get('/Classification');
  const box = data && (data.peakClassification || data.PeakClassification);
  return (box && box.classificationGroup) || [];
}

// One service by its code: searched with GET /Services/list (GET /Services only takes an id). Read-only.
async function getServiceByCode(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  return (await searchServices(c)).find((x) => String(x.code).toUpperCase() === c) || null;
}

// PEAK services for a customer type's groups (lib/types.js): code prefixes and/or a word in the name.
// [{ label, services: [{ code, name, description, unit }] }], cached 10 min per search.
const svcSearch = new Map();
async function searchServices(text) {
  const key = String(text || '').toLowerCase();
  const hit = svcSearch.get(key);
  if (hit && Date.now() - hit.at < 600e3) return hit.list;
  const out = new Map();
  // PEAK may honour limit (up to 100) or keep 10 per page: keep paging while a page comes back full and adds something new.
  let size = 0;
  for (let page = 1; page <= 40; page++) {
    const data = await get('/Services/list', { searchText: text, limit: 100, page });
    const box = data && (data.PeakServices || data.peakServices);
    const xs = (box && box.services) || [];
    const before = out.size;
    xs.forEach((x) => out.set(x.code, { id: x.id, code: x.code, name: x.name, description: x.description || '', unit: x.unit && (x.unit.nameTh || x.unit.nameEn) || '' }));
    if (page === 1) size = xs.length;
    if (!xs.length || xs.length < size || out.size === before) break;
  }
  const list = [...out.values()];
  svcSearch.set(key, { at: Date.now(), list });
  return list;
}
async function servicesForGroups(groups) {
  const { inGroup } = require('./types');
  const res = [];
  for (const g of groups || []) {
    const found = new Map();
    for (const t of [...g.prefixes, ...(g.keyword ? [g.keyword] : [])]) {
      for (const s of await searchServices(t)) if (inGroup(g, s)) found.set(s.code, s);
    }
    res.push({ label: g.label, services: [...found.values()].sort((a, b) => String(a.code).localeCompare(String(b.code))) });
  }
  return res;
}

// One service by PEAK id (the productId on a document line). Read-only; carries sellAccount.
async function getService(id) {
  const data = await get('/Services', { id });
  const box = data && (data.PeakServices || data.peakServices);
  return ((box && box.services) || [])[0] || null;
}

// Tag a document with one classification item (POST /Classification/transaction, one group per call).
//   type: 101 quotation, 102 invoice, 103 receipt
async function classify(transactionId, type, group, number) {
  return call('/Classification/transaction', { PeakClassifications: {
    transactionId, transactionType: type, classifications: { classificationGroupCode: group, classificationItemList: [{ number, percent: 100 }] },
  } }, { retries: 1 });
}

// Attach a file to a quotation / invoice (POST /Quotations|Invoices/insertfile). Max 5 MB decoded.
//   file: { name, type, data (base64) }
async function insertFile(kind, transactionId, file) {
  const K = { invoice: ['PeakInvoices', '/Invoices/insertfile'], receipt: ['PeakReceipts', '/Receipts/insertfile'], quotation: ['PeakQuotations', '/Quotations/insertfile'] };
  const [key, path] = K[kind] || K.quotation;
  return call(path, { [key]: { transactionId, file: { fileName: file.name, rawString: `data:${file.type || 'application/octet-stream'};base64,${file.data}` } } }, { retries: 1 });
}

// What a quotation says (lines + totals), as a short hash. Attaching a file or a tag doesn't change it.
function quotationSig(q) {
  if (!q) return '';
  const r = (x) => (Number(String(x ?? '').replace(/,/g, '')) || 0).toFixed(2);
  const lines = (q.products || []).map((p) => [p.productCode || p.productId || '', String(p.description || '').trim(), r(p.quantity), r(p.price), r(p.discount)].join('~'));
  const txt = [r(q.preTaxAmount), r(q.netAmount), q.contactCode || (q.contact && q.contact.code) || '', ...lines].join('|');
  return require('crypto').createHash('sha1').update(txt).digest('hex').slice(0, 16);
}

// Lines of a quotation for showing in the app (read-only view of what PEAK has now).
function quotationView(q) {
  if (!q) return null;
  const n = (x) => Number(String(x ?? '').replace(/,/g, '')) || 0;
  return {
    id: q.id, code: q.code, status: q.status, isVoid: !!(Number(q.isVoid) === 1 || /void/i.test(q.status || '')),
    issuedDate: q.issuedDate, dueDate: q.dueDate, documentLink: q.documentLink || '', taxStatus: q.taxStatus,
    preTaxAmount: n(q.preTaxAmount), vatAmount: n(q.vatAmount), netAmount: n(q.netAmount), whtAmount: n(q.withHoldingTaxAmount || q.whtAmount),
    discountTotal: n(q.discountTotal), remark: q.remark || '',
    lines: (q.products || []).map((p) => ({ code: p.productCode || '', description: p.description || '', qty: n(p.quantity), price: n(p.price), discount: n(p.discount),
      total: Math.round((n(p.quantity) * (n(p.price) - n(p.discount))) * 100) / 100 })),
  };
}

function addDays(yyyymmdd, n) {
  const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8) + n));
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

module.exports = {
  findQuotationByCode, findInvoiceByCode, findReceiptByCode, getClassifications,
  mode, stamp, signature, buildQuotation, createQuotationDraft, unitDiscount, addDays,
  findContacts, createContact, listClassificationGroups, getServiceByCode, searchServices, servicesForGroups, createReceiptFromInvoiceDraft, getReceipt, listPaymentMethods, getQuotation, getInvoice, getService, classify, insertFile, buildInvoiceFromQuotation, createInvoiceFromQuotationDraft, editInvoiceDraft,
  quotationSig, quotationView, getClientToken, testConnection, _test: { resCodeOf, assertDraft, reset: () => { clientToken = null; } },
};
