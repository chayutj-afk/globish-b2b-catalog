// Revenue Hub (Google Sheet) access through a service account.
// The sheet must be shared with GOOGLE_SERVICE_ACCOUNT_EMAIL as Editor.
//
// HUB_MODE=mock keeps everything in a local JSON file instead (for local runs and tests).

const fs = require('fs');

// Column order of the input columns only. Columns to the right of these hold
// ARRAYFORMULAs in the sheet, so the app must never write past them.
const TABLES = {
  Requests: ['requestId', 'createdAt', 'requestedBy', 'salesName', 'segment', 'dealType', 'clientCode', 'company',
    'taxId', 'branch', 'docLang', 'wantedQtDate', 'creditTermDays', 'poRequired', 'note', 'status', 'peakQtNo',
    'peakQtId', 'totalPreVat', 'qtApprovedAt', 'ivRequestedAt', 'updatedAt', 'catalogTotal', 'belowFloor', 'opportunityId',
    // Z/AA are ARRAYFORMULA columns in the sheet (invoiced / remaining): read, never written.
    '_invoicedPreVat', '_remainingPreVat', 'peakNote', 'peakDocLink',
    // AD: withholding tax rate the customer deducts (0 = none, 1/2/3/5 %).
    'whtRate',
    // AE: customer email for sending documents (B2C / B2E). AF: Request ID this one was rebuilt from (rejected).
    'customerEmail', 'replaces',
    // AG: excl | incl (prices in the QT include VAT). AH: total incl. VAT.
    // AI: QTs voided in PEAK for this request, "QO-…|id; …" (the sync never reuses them).
    'vatMode', 'totalInclVat', 'voidedQts',
    // AJ: when the approved QT was edited in PEAK (its public PDF stays old until someone presses refresh in PEAK;
    // cleared by accounting's "รีเฟรชแล้ว"). AK: signature of the QT content we last saw (lines + amounts).
    // AL: details of a customer not yet in PEAK (JSON), created in PEAK when accounting approves.
    'qtEditedAt', 'qtSig', 'newContact',
    // AM: PEAK classification items Sales picked on the form (JSON { G012: item, G013: item }).
    // AN: pre-VAT amount invoiced from this QT before the app existed (a QT brought in from PEAK), counted in the balance.
    'classPicks', 'openingInvoiced'],
  RequestLines: ['requestId', 'line', 'role', 'keyHS', 'packageId', 'peakServiceCode', 'description', 'qty', 'unitPrice', 'discount', 'listPrice', 'salesNote', 'qtDescription', 'freebie'],
  InvoiceRequests: ['ivRequestId', 'createdAt', 'requestedBy', 'salesName', 'requestId', 'qtNo', 'company', 'taxId',
    'evidenceType', 'evidenceLink', 'wantedIssueDate', 'billing', 'installment', 'amountPreVat', 'students',
    'creditTermDays', 'poNo', 'financeContact', 'financeEmail', 'financePhone', 'deliveryAddress', 'note',
    'status', 'peakIvNo', 'updatedAt', 'opportunityId',
    'batchId', 'branch', 'billToRelation', 'originalDoc', 'originalStatus', 'originalRecipient', 'originalAddress',
    'originalRequestedAt', 'originalSentAt', 'trackingNo', 'overReason',
    // AL–AN: written by accounting actions in the app or by the PEAK sync.
    'peakIvId', 'peakDocLink', 'accountNote',
    // AO: withholding tax rate (0 = none, 1/2/3/5 %).
    'whtRate',
    // AP–AR: customer billing details (legacy B2B INV form): pay-cycle day, PO needed to bill, company documents.
    'payCycle', 'poNeeded', 'companyDocsLink',
    // AS: amount incl. VAT (what Sales entered for VAT-inclusive segments).
    'amountInclVat'],
  SyncLog: ['at', 'source', 'event', 'reference', 'detail'],
  // Copy of PEAK contacts that have a tax ID (from the PEAK contact export, kept up to date by the
  // PEAK QT sync). Lets the form fill the PEAK contact code from the 13-digit tax ID + branch.
  // Everyone who has signed in. role: sales (default) | op (Accountant / Admin). Admins set roles.
  // Which PEAK classification item goes on the app's documents (lib/classrules.js).
  ClassRules: ['group', 'scope', 'key', 'item', 'updatedBy', 'updatedAt'],
  Users: ['email', 'name', 'role', 'firstLogin', 'lastLogin', 'updatedBy', 'updatedAt', 'team', 'salesPerf', 'perms', 'googleId'],
  // AR (replaces the Debt Follow Up sheet). A–Z inputs, AA–AN ARRAYFORMULAs (read only), AO+ inputs.
  Invoices: ['ivNo', 'issueDate', 'segment', 'dealType', 'salesEmail', 'clientCode', 'company', 'taxId', 'qtNo', 'requestId',
    'keyHS', 'students', 'preVat', 'creditTermDays', 'whtRate', 'poNo', 'installment', 'docStatus', 'commitDate', 'paidDate',
    'paidAmount', 'paymentMethod', 'rtNo', 'delayReason', 'note', 'source',
    '_dueDate', '_vat', '_expected', '_productLine', '_packageGroup', '_issueMonth', '_issueWeek', '_arState', '_daysOverdue',
    '_aging', '_cycleDays', '_paidMonth', '_forecastWeek', '_lastFollowUp',
    'packageName', 'salesName', 'ivRequestId', 'peakIvId', 'peakDocLink', 'branch', 'followStatus', 'nextActionDate',
    'productLineIn', 'packageGroupIn',
    // AY: classification items on the INV in PEAK (JSON { G012, G013, G014 }), refreshed when PEAK reports an edit.
    'classPicks',
    // AZ: the commit date as it was when the money came in (commitDate itself then moves to the paid date).
    'commitAtPaid',
    // BA: the date on the receipt / the day the cheque was collected. paidDate is the day the money reached the
    // bank; a row with rtDate (or rtNo) and no paidDate has a receipt but is still waiting for the money.
    'rtDate'],
  // Receipt / tax invoice requests (mostly B2C / B2E after the customer paid; also B2B).
  ReceiptRequests: ['rtRequestId', 'createdAt', 'requestedBy', 'salesName', 'segment', 'docKind', 'refDoc', 'whStudent',
    'billName', 'taxId', 'branch', 'address', 'deliveryAddress', 'email', 'whtRate', 'packages', 'description', 'price',
    'discount', 'paidDate', 'paymentProof', 'deliveryChannel', 'docLang', 'note', 'status', 'peakRtNo', 'peakDocLink',
    'sentStatus', 'sentAt', 'trackingNo', 'accountNote', 'updatedAt',
    // AG: PEAK receipt id (RT Draft made by the app from a paid INV; rt_draft until approved in PEAK).
    // AH: PEAK classification Sales picked (JSON { G012, G013 }).
    'peakRtId', 'classPicks'],
  // Sales asking accounting to change a QT / INV that was already issued.
  EditRequests: ['editId', 'createdAt', 'requestedBy', 'salesName', 'docType', 'docNo', 'refId', 'company', 'detail',
    'status', 'accountNote', 'newDocNo', 'doneBy', 'updatedAt'],
  // Payment notices: Sales tells accounting a customer paid an INV (slip attached), or accounting
  // recorded a payment the customer reported directly (source = accounting). One INV is paid once.
  PaymentNotices: ['noticeId', 'createdAt', 'requestedBy', 'salesName', 'ivRequestId', 'ivNo', 'company', 'paidDate', 'amount',
    'paymentMethod', 'slipLink', 'deliveryChannel', 'email', 'deliveryAddress', 'note', 'status', 'source', 'accountNote', 'doneBy', 'updatedAt'],
  // commitDate: the pay date the customer gave at that contact (the INV itself only keeps the latest one).
  FollowUps: ['loggedAt', 'ivNo', 'channel', 'by', 'result', 'nextActionDate', 'note', 'commitDate'],
  WHPackages: ['id', 'packageName', 'type', 'product', 'privateClass', 'freeTalk', 'discussion', 'realwork', 'months', 'extras', 'status', 'updatedAt'],
  // Written by the scheduled PEAK cross-check (read-only in PEAK): one row per document checked.
  // key = docType|docNo|appRef; result = ok | mismatch | missing | voided | not_approved | approved_in_peak.
  PeakChecks: ['key', 'docType', 'docNo', 'refId', 'result', 'detail', 'checkedAt'],
  // Wording of QT / INV line descriptions per product (lib/templates.js holds the defaults). Product edits th / en here.
  DescTemplates: ['key', 'name', 'th', 'en', 'updatedAt'],
};

const col = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

// Columns whose values must stay text even when they look like numbers (tax IDs keep
// their leading zero, branch "00000" stays as typed).
const TEXT_COLS = new Set(['id', 'whtRate', 'taxId', 'branch', 'clientCode', 'peakQtNo', 'peakQtId', 'peakServiceCode', 'packageId', 'reference', 'qtNo', 'poNo', 'financePhone', 'installment', 'peakIvNo', 'opportunityId', 'batchId', 'trackingNo', 'code', 'peakIvId', 'ivNo', 'rtNo', 'keyHS', 'rtRequestId', 'editId', 'docNo', 'refId', 'refDoc', 'peakRtNo', 'newDocNo', 'packages', 'replaces']);

// Text that starts with = + - @ would run as a formula with USER_ENTERED; keep it text.
function cell(v, key) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  let s = String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, 2000);
  if (s !== '' && (/^[=+\-@]/.test(s) || TEXT_COLS.has(key))) s = "'" + s;
  return s;
}

// dd/mm/yyyy hh:mm in Bangkok time; the sheet's locale (en_GB) reads it as a date.
function sheetDateTime(d = new Date()) {
  const t = new Date(d.getTime() + 7 * 3600e3);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(t.getUTCDate())}/${p(t.getUTCMonth() + 1)}/${t.getUTCFullYear()} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}

// ---------------------------------------------------------------- mock store
function mockFile() { return process.env.HUB_MOCK_FILE || '/tmp/revenue-hub-mock.json'; }
function mockRead() { try { return JSON.parse(fs.readFileSync(mockFile(), 'utf8')); } catch { return {}; } }
function mockWrite(db) { fs.writeFileSync(mockFile(), JSON.stringify(db, null, 1)); }

// ---------------------------------------------------------------- Sheets API
let jwtClient = null;
function jwt() {
  if (jwtClient) return jwtClient;
  const { JWT } = require('google-auth-library');
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY || !process.env.HUB_SHEET_ID) {
    const e = new Error('Server ยังไม่ได้ตั้งค่า Revenue Hub (GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, HUB_SHEET_ID)');
    e.status = 500;
    throw e;
  }
  jwtClient = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return jwtClient;
}

// Google allows 60 reads a minute for the app's account, shared by everyone using the app.
//  - Read-only requests (GET) share each sheet read for a few seconds, and identical reads that are in
//    flight at the same moment become one. A page that fires six calls no longer reads Users, Requests…
//    six times.
//  - Requests that change data (POST / PATCH), and the first reads right after the user's own change
//    (x-fresh header), always read fresh. Any write drops the shared copies.
//  - A 429 waits a little and tries again instead of showing the quota error.
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();
const SHARE_MS = 8000;
const shared = new Map(); // path → { at, p }
function scope(req, fn) {
  const fresh = !req || req.method !== 'GET' || !!(req.headers && req.headers['x-fresh']);
  return als.run({ fresh }, fn);
}
async function call(path, method, body) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${process.env.HUB_SHEET_ID}${path}`;
  for (let attempt = 0; ; attempt++) {
    try { return (await jwt().request({ url, method, data: body, retry: false, timeout: 20000 })).data; } catch (e) {
      const code = Number((e.response && e.response.status) || e.code || e.status);
      if (code !== 429 || attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1) + Math.random() * 2000));
    }
  }
}
async function api(path, { method = 'GET', body } = {}) {
  if (method !== 'GET') { shared.clear(); try { return await call(path, method, body); } finally { shared.clear(); } }
  const st = als.getStore();
  const hit = shared.get(path);
  // Outside a request scope (cron, tests) and in fresh scopes: read now, but leave the result for others.
  if (hit && st && !st.fresh && Date.now() - hit.at < SHARE_MS) return hit.p;
  const p = call(path, 'GET');
  shared.set(path, { at: Date.now(), p });
  p.catch(() => { if ((shared.get(path) || {}).p === p) shared.delete(path); });
  if (shared.size > 200) for (const [k, v] of shared) if (Date.now() - v.at > SHARE_MS) shared.delete(k);
  return p;
}

const mock = () => process.env.HUB_MODE === 'mock';

// Columns the app may write. Names starting with "_" are formula columns; append stops before
// the first one so new rows never touch them (later input columns are set with updateRow).
function writableCols(table) {
  const cols = TABLES[table];
  const i = cols.findIndex((c) => c.startsWith('_'));
  return i < 0 ? cols : cols.slice(0, i);
}

// ---- column-layout guard: the app writes by position, so check the live header row first.
const HEADERS = require('./headers');
const normHead = (v) => String(v || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9\u0E00-\u0E7F]/g, '');
const layoutCache = new Map(); // table → { at, problem }
function layoutProblem(table, row) {
  const want = HEADERS[table];
  if (!want) return '';
  for (let i = 0; i < want.length; i++) {
    if (normHead(row[i]) !== normHead(want[i])) {
      return `แท็บ ${table} คอลัมน์ ${col(i + 1)}: ควรเป็น "${want[i]}" แต่เจอ "${row[i] || '(ว่าง)'}"`;
    }
  }
  return '';
}
async function checkLayout(table, { fresh = false } = {}) {
  if (mock() || !HEADERS[table]) return '';
  const c = layoutCache.get(table);
  if (!fresh && c && Date.now() - c.at < 300e3) return c.problem;
  // Nothing known yet about this tab (a fresh server instance): read every tab's header row in one
  // request, so the next tabs this instance writes to cost no read at all.
  if (!fresh && !c) { const all = await layoutReport(); if (typeof all[table] === 'string' && !/^อ่านไม่ได้/.test(all[table])) return all[table]; }
  const r = await api(`/values/${encodeURIComponent(`${table}!A1:${col(HEADERS[table].length)}1`)}`);
  const problem = layoutProblem(table, ((r && r.values) || [[]])[0]);
  layoutCache.set(table, { at: Date.now(), problem });
  return problem;
}
async function guard(table) {
  const problem = await checkLayout(table);
  if (!problem) return;
  // Re-read once: someone may have just fixed the sheet.
  const again = await checkLayout(table, { fresh: true });
  if (!again) return;
  const e = new Error(`หยุดบันทึกเพื่อกันข้อมูลลงผิดช่อง: ${again} (มีคนแทรก/ย้าย/ลบคอลัมน์ใน Revenue Hub) แจ้งผู้ดูแลให้แก้หัวคอลัมน์กลับก่อน`);
  e.status = 503;
  try { require('./notify').finance(`⛔ Sales Desk หยุดบันทึกแท็บ ${table}: ${again}`); } catch (x) { /* best effort */ }
  throw e;
}
// Every tab's header row in ONE read (was one read per tab, which used up the per-minute read quota).
async function layoutReport() {
  const out = {};
  const tabs = Object.keys(HEADERS);
  if (mock()) return Object.fromEntries(tabs.map((t) => [t, '']));
  try {
    const q = tabs.map((t) => 'ranges=' + encodeURIComponent(`${t}!A1:${col(HEADERS[t].length)}1`)).join('&');
    const r = await api(`/values:batchGet?${q}`);
    tabs.forEach((t, i) => {
      const problem = layoutProblem(t, (((r.valueRanges || [])[i] || {}).values || [[]])[0]);
      layoutCache.set(t, { at: Date.now(), problem }); out[t] = problem;
    });
  } catch (e) { for (const t of tabs) out[t] = `อ่านไม่ได้: ${e.message}`; }
  return out;
}

async function appendRows(table, objects) {
  readCache.delete(table);
  if (table !== 'SyncLog') await guard(table);
  const cols = writableCols(table);
  const rows = objects.map((o) => cols.map((c) => cell(o[c], c)));
  // Columns after a formula ("_") column can't go in the append (it would overwrite the formula);
  // they're written right after, cell by cell, on the rows the append landed on.
  const tail = TABLES[table].slice(cols.length).filter((c) => !c.startsWith('_'));
  const writeTail = async (firstRow) => {
    if (mock()) {
      for (let i = 0; i < objects.length; i++) {
        const f = Object.fromEntries(tail.filter((c) => objects[i][c] !== undefined && objects[i][c] !== '').map((c) => [c, objects[i][c]]));
        if (Object.keys(f).length) await updateRow(table, firstRow + i, f);
      }
      return;
    }
    // The tail columns sit side by side after the formula block: one range per row, one API call per 500 rows.
    const all = TABLES[table];
    const a = all.indexOf(tail[0]) + 1, z = all.indexOf(tail[tail.length - 1]) + 1;
    const data = [];
    objects.forEach((o, i) => {
      if (!tail.some((c) => o[c] !== undefined && o[c] !== '')) return;
      const vals = all.slice(a - 1, z).map((c) => (c.startsWith('_') ? null : cell(o[c], c)));
      data.push({ range: `${table}!${col(a)}${firstRow + i}:${col(z)}${firstRow + i}`, values: [vals] });
    });
    for (let k = 0; k < data.length; k += 500) {
      await api('/values:batchUpdate', { method: 'POST', body: { valueInputOption: 'USER_ENTERED', data: data.slice(k, k + 500) } });
    }
  };
  if (mock()) {
    const db = mockRead();
    const first = (db[table] || []).length + 2;
    db[table] = (db[table] || []).concat(rows);
    mockWrite(db);
    await writeTail(first);
    return;
  }
  // The append API looks for the "table" inside this range and writes under it: it takes the block of cells that
  // holds the right-most filled cell of the last row. Searched over all columns, a last row with empty cells in the
  // middle, cut off from the header by a blank row, made it pick the block at the END of that row and start the new
  // row there (tested against the API: header / blank row / "a b c _ _ _ g h" → new row lands at G, not A).
  // Searched in column A only it cannot shift: every real row has its first column filled (a row without it does
  // not exist for this app), so the new row always starts at column A, under the last row.
  const range = encodeURIComponent(`${table}!A:A`);
  const res = await api(`/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=OVERWRITE`, {
    method: 'POST', body: { values: rows },
  });
  const landed = (res && res.updates && res.updates.updatedRange) || '';
  const m = /!([A-Z]+)(\d+)/.exec(landed);
  // Belt and braces: should a row still land at a later column, put it back at column A.
  if (m && m[1] !== 'A') {
    const r = Number(m[2]);
    await api(`/values/${encodeURIComponent(landed)}:clear`, { method: 'POST', body: {} });
    await api(`/values/${encodeURIComponent(`${table}!A${r}:${col(cols.length)}${r + rows.length - 1}`)}?valueInputOption=USER_ENTERED`, { method: 'PUT', body: { values: rows } });
    try { await log('hub', 'append_realigned', table, `${landed} → column A`); } catch (e) { /* best effort */ }
  }
  if (tail.length && m) await writeTail(Number(m[2]));
}

// Table reads asked for at the same moment go to Google as ONE request (values:batchGet). A handler
// that reads Requests + InvoiceRequests + Invoices + Users together costs one read of the 60 a minute
// instead of four. The sharing rules of api() still apply (GET requests reuse a read for a few seconds,
// writes and "fresh" requests read again).
let batchQ = null; // Map(range → { resolve, reject }[])
function batchRead(range) {
  const st = als.getStore();
  const key = `range:${range}`;
  const hit = shared.get(key);
  if (hit && st && !st.fresh && Date.now() - hit.at < SHARE_MS) return hit.p;
  const p = new Promise((resolve, reject) => {
    if (!batchQ) { batchQ = new Map(); setTimeout(flushBatch, 4); }
    batchQ.set(range, (batchQ.get(range) || []).concat({ resolve, reject }));
  });
  shared.set(key, { at: Date.now(), p });
  p.catch(() => { if ((shared.get(key) || {}).p === p) shared.delete(key); });
  return p;
}
async function flushBatch() {
  const q = batchQ; batchQ = null;
  const ranges = [...q.keys()];
  try {
    const r = await call(`/values:batchGet?valueRenderOption=FORMATTED_VALUE&${ranges.map((x) => 'ranges=' + encodeURIComponent(x)).join('&')}`, 'GET');
    ranges.forEach((x, i) => { const v = (((r && r.valueRanges) || [])[i] || {}).values || []; q.get(x).forEach((w) => w.resolve(v)); });
  } catch (e) { for (const ws of q.values()) ws.forEach((w) => w.reject(e)); }
}

// { cache: ms } lets read-only screens (dashboards, the health check) share one read for a short while.
// Handlers that change data never pass it, and a write from this instance drops the cached copy.
const readCache = new Map(); // table → { at, p }
async function readValues(table, cache) {
  const cols = TABLES[table];
  const load = () => batchRead(`${table}!A2:${col(cols.length)}`);
  if (!cache) return load();
  const c = readCache.get(table);
  if (c && Date.now() - c.at < cache) return c.p;
  const p = load();
  readCache.set(table, { at: Date.now(), p });
  p.catch(() => { if ((readCache.get(table) || {}).p === p) readCache.delete(table); });
  return p;
}
async function readTable(table, { cache = 0, alone = false } = {}) {
  const cols = TABLES[table];
  let values;
  if (mock()) values = mockRead()[table] || [];
  else if (alone) values = ((await call(`/values/${encodeURIComponent(`${table}!A2:${col(cols.length)}`)}?valueRenderOption=FORMATTED_VALUE`, 'GET')) || {}).values || [];
  else values = await readValues(table, cache);
  return values
    .map((r, i) => { const o = { _row: i + 2 }; cols.forEach((c, j) => { o[c] = r[j] === undefined ? '' : String(r[j]).replace(/^'/, ''); }); return o; })
    .filter((o) => o[cols[0]] !== '');
}

async function log(source, event, reference, detail) {
  try {
    await appendRows('SyncLog', [{ at: sheetDateTime(), source, event, reference, detail: String(detail || '').slice(0, 1000) }]);
  } catch (e) {
    console.error('SyncLog write failed', e);
  }
}

// Writes only the given fields of one row (1-based sheet row), leaving other cells alone.
async function updateRow(table, rowNumber, fields) {
  readCache.delete(table);
  await guard(table);
  const cols = TABLES[table];
  const entries = Object.entries(fields).filter(([k]) => cols.includes(k) && !k.startsWith('_'));
  if (mock()) {
    const db = mockRead();
    const row = (db[table] || [])[rowNumber - 2];
    if (row) entries.forEach(([k, v]) => { const i = cols.indexOf(k); while (row.length < i) row.push(''); row[i] = cell(v, k); });
    mockWrite(db);
    return;
  }
  await api('/values:batchUpdate', {
    method: 'POST',
    body: {
      valueInputOption: 'USER_ENTERED',
      data: entries.map(([k, v]) => ({ range: `${table}!${col(cols.indexOf(k) + 1)}${rowNumber}`, values: [[cell(v, k)]] })),
    },
  });
}

// Replaces every data row of a table (row 2 down) with `objects` (tables rebuilt from an import).
async function replaceTable(table, objects) {
  readCache.delete(table);
  await guard(table);
  const cols = writableCols(table);
  const rows = objects.map((o) => cols.map((c) => cell(o[c], c)));
  if (mock()) {
    const db = mockRead();
    db[table] = rows;
    mockWrite(db);
    return;
  }
  await api(`/values/${encodeURIComponent(`${table}!A2:${col(cols.length)}`)}:clear`, { method: 'POST', body: {} });
  if (rows.length) {
    await api(`/values/${encodeURIComponent(`${table}!A2:${col(cols.length)}${rows.length + 1}`)}?valueInputOption=USER_ENTERED`, {
      method: 'PUT', body: { values: rows },
    });
  }
}

module.exports = { scope, TABLES, layoutProblem, layoutReport, checkLayout, appendRows, readTable, updateRow, replaceTable, log, sheetDateTime, cell };

// PEAK service codes the accounting team fills in on the Products and Components tabs.
// Returns { byKeyHS: Map, byComponent: Map }.
async function readServiceCodes() {
  let products, components;
  if (mock()) {
    const db = mockRead();
    products = db.Products || [];
    components = db.Components || [];
  } else {
    const data = await api(`/values:batchGet?ranges=${encodeURIComponent('Products!A2:P')}&ranges=${encodeURIComponent('Components!B2:D')}`);
    products = (data.valueRanges[0] && data.valueRanges[0].values) || [];
    components = (data.valueRanges[1] && data.valueRanges[1].values) || [];
  }
  const byKeyHS = new Map(products.filter((r) => r[0] && r[15]).map((r) => [String(r[0]), String(r[15]).trim()]));
  const byComponent = new Map(components.filter((r) => r[0] && r[2]).map((r) => [String(r[0]), String(r[2]).trim()]));
  return { byKeyHS, byComponent };
}

module.exports.readServiceCodes = readServiceCodes;


// PEAK classification "Sales Performance" (G014) items, kept by accounting in Lists!K:L.
async function readSalesPerf() {
  let rows;
  if (mock()) rows = mockRead().SalesPerf || [['B2B-S001', 'Siraprapa (Bee)'], ['B2C-S001', 'Gulpiyanat (Sine)']];
  else rows = (await api(`/values/${encodeURIComponent('Lists!K2:L')}`)).values || [];
  return rows.map((r) => ({ code: String(r[0] || '').trim(), name: String(r[1] || '').trim() })).filter((x) => x.code);
}
module.exports.readSalesPerf = readSalesPerf;

// Accounting actions on one row. Sheets has no locks, so two people acting on the same row a moment
// apart could both pass the status check. `seen` = "status|updatedAt" the page showed: a mismatch means
// someone changed the row since. After writing, the row is read back; if another write landed on top,
// the caller is told instead of silently losing.
function stamp(row) { return `${row.status || ''}|${row.updatedAt || ''}`; }
function checkSeen(row, seen) {
  if (seen && String(seen) !== stamp(row)) {
    throw Object.assign(new Error(`มีคนอัปเดตรายการนี้ไปแล้ว (สถานะตอนนี้: ${row.status}) รีเฟรชหน้าเพื่อดูข้อมูลล่าสุด`), { status: 409 });
  }
}
async function writeChecked(table, key, row, fields) {
  await updateRow(table, row._row, fields);
  const now = (await readTable(table)).find((x) => x[key] === row[key]);
  // Compare only the status fields: dates and numbers can read back formatted differently.
  const lost = !now || ['status', 'originalStatus', 'peakIvNo'].filter((k) => k in fields).some((k) => String(now[k] ?? '') !== String(fields[k] ?? ''));
  if (lost) throw Object.assign(new Error(`มีคนทำรายการนี้พร้อมกัน ระบบเก็บของอีกคนไว้ (สถานะตอนนี้: ${now ? now.status : '-'}) รีเฟรชหน้าเพื่อดู`), { status: 409 });
}
module.exports.stamp = stamp;
module.exports.checkSeen = checkSeen;
module.exports.writeChecked = writeChecked;

// Raw values of a fixed range (lookup lists kept by accounting).
async function readList(range) {
  if (mock()) return (mockRead().Lists || {})[range] || [];
  return (await api(`/values/${encodeURIComponent(range)}`)).values || [];
}
module.exports.readList = readList;

// Settings tab (A = setting, B = value): small values the app keeps between requests.
async function getSetting(key) {
  if (mock()) return String(((mockRead().Settings || []).find((r) => r[0] === key) || [])[1] ?? '');
  const rows = (await api(`/values/${encodeURIComponent('Settings!A2:B60')}`)).values || [];
  return String((rows.find((r) => String(r[0] || '').trim() === key) || [])[1] ?? '').trim();
}
async function setSetting(key, value) {
  if (mock()) { const db = mockRead(); db.Settings = db.Settings || []; const r = db.Settings.find((x) => x[0] === key); if (r) r[1] = String(value); else db.Settings.push([key, String(value)]); return mockWrite(db); }
  const rows = (await api(`/values/${encodeURIComponent('Settings!A2:A60')}`)).values || [];
  const i = rows.findIndex((r) => String(r[0] || '').trim() === key);
  if (i < 0) throw new Error(`Settings tab has no row "${key}"`);
  await api(`/values/${encodeURIComponent(`Settings!B${i + 2}`)}?valueInputOption=RAW`, { method: 'PUT', body: { values: [[String(value)]] } });
}
module.exports.getSetting = getSetting;
module.exports.setSetting = setSetting;
