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

// lines: [{ role, keyHS, component, description, qty, unitPrice }]
// serviceCode(line) → PEAK product/service code or '' (unmapped).
function buildQuotation(request, lines, serviceCode, today = new Date()) {
  const missing = [];
  const products = lines.map((l) => {
    const code = serviceCode(l);
    if (!code) missing.push(l.role === 'supplement' ? `ส่วนเสริม "${l.component}"` : l.role === 'surcharge' ? `surcharge` : `แพ็กเกจ ${l.packageId}`);
    return { productCode: code || undefined, description: l.description, quantity: l.qty, price: l.unitPrice, discount: l.discount ? String(l.discount) : undefined, vatType: 3 };
  });
  return {
    missing: [...new Set(missing)],
    body: {
      PeakQuotations: {
        quotations: [{
          issuedDate: ymd(request.wantedQtDate) || stamp(today).slice(0, 8),
          contactCode: request.clientCode || undefined,
          reference: request.requestId,
          remark: [request.company, request.taxId ? `Tax ID ${request.taxId}` : '', request.note].filter(Boolean).join(' · ').slice(0, 1000),
          taxStatus: 0, // prices exclude VAT
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

module.exports = { mode, stamp, signature, buildQuotation, createQuotationDraft };
