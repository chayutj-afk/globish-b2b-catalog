// PEAK Open API: quotations as Draft, for accounting to review and approve in PEAK.
//
// PEAK_MODE  off (default) | uat | prod
//   off  → nothing is sent; the request stays "new" in the Revenue Hub.
//   uat  → https://peakengineapidev.azurewebsites.net/api/v1
//   prod → https://api.peakaccount.com/api/v1
//
// Credentials (Vercel env only): PEAK_CONNECT_ID, PEAK_PASSWORD (for the client token),
// PEAK_USER_TOKEN. Signing follows PEAK's client-token guide:
//   Time-Stamp     = yyyyMMddHHmmss in UTC
//   Time-Signature = HMAC-SHA1(Time-Stamp, key = connectId)
// The guide doesn't say hex or base64; hex is used here (what PEAK's Postman collection
// produces with CryptoJS). Confirm on UAT before switching to prod.

const crypto = require('crypto');

const BASE = {
  uat: 'https://peakengineapidev.azurewebsites.net/api/v1',
  prod: 'https://api.peakaccount.com/api/v1',
};

function mode() {
  const m = String(process.env.PEAK_MODE || 'off').toLowerCase();
  return BASE[m] ? m : 'off';
}

function stamp(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function signature(ts, connectId) {
  return crypto.createHmac('sha1', connectId).update(ts).digest('hex');
}

let clientToken = null; // { token, exp } cached per instance (valid 24 h; endpoint allows 10/min)

async function call(path, body, { withClientToken = true } = {}) {
  const base = BASE[mode()];
  const connectId = process.env.PEAK_CONNECT_ID;
  if (!connectId) throw Object.assign(new Error('Server ยังไม่ได้ตั้งค่า PEAK_CONNECT_ID'), { status: 500 });
  const ts = stamp();
  const headers = { 'Content-Type': 'application/json', 'Time-Stamp': ts, 'Time-Signature': signature(ts, connectId) };
  if (withClientToken) {
    headers['Client-Token'] = await getClientToken();
    headers['User-Token'] = process.env.PEAK_USER_TOKEN || '';
  }
  const res = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw Object.assign(new Error(`PEAK ${res.status}: ${text.slice(0, 300)}`), { status: 502 });
  return data;
}

async function getClientToken() {
  if (clientToken && Date.now() < clientToken.exp) return clientToken.token;
  const data = await call('/ClientToken', {
    PeakClientToken: { connectId: process.env.PEAK_CONNECT_ID, password: process.env.PEAK_PASSWORD },
  }, { withClientToken: false });
  const t = data && data.PeakClientToken;
  if (!t || !t.token || String(t.resCode) !== '200') throw Object.assign(new Error('PEAK ไม่ออก Client Token'), { status: 502 });
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
function whtOf(l, rate) {
  const r = Number(rate) || 0;
  if (!r) return undefined;
  const net = (Number(l.qty) || 0) * (Number(l.unitPrice) || 0) - (Number(l.discount) || 0);
  return net > 0 ? String(Math.round(net * r) / 100) : '0';
}

function buildQuotation(request, lines, serviceCode, today = new Date()) {
  const missing = [];
  const products = lines.map((l) => {
    const code = serviceCode(l);
    if (!code) missing.push(l.role === 'supplement' ? `ส่วนเสริม "${l.component}"` : l.role === 'surcharge' ? `surcharge` : `แพ็กเกจ ${l.packageId}`);
    return { productCode: code || undefined, description: l.description, quantity: l.qty, price: l.unitPrice, discount: unitDiscount(l), vatType: 3, withHoldingTaxAmount: whtOf(l, request.whtRate) };
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
          taxStatus: 0, // prices exclude VAT
          discountTotal,
          status: 'Draft',
          products,
        }],
      },
    },
  };
}

async function createQuotationDraft(body) {
  const data = await call('/Quotations?getResult=1', body);
  const q = data && data.PeakQuotations && (data.PeakQuotations.quotations || [])[0];
  return { id: q && q.id, code: q && q.code, raw: data };
}

function addDays(yyyymmdd, n) {
  const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8) + n));
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

module.exports = { mode, stamp, signature, buildQuotation, createQuotationDraft, unitDiscount, addDays };
