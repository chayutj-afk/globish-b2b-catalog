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
    'qtEditedAt', 'qtSig', 'newContact'],
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
  Users: ['email', 'name', 'role', 'firstLogin', 'lastLogin', 'updatedBy', 'updatedAt', 'team', 'salesPerf', 'perms'],
  // AR (replaces the Debt Follow Up sheet). A–Z inputs, AA–AN ARRAYFORMULAs (read only), AO+ inputs.
  Invoices: ['ivNo', 'issueDate', 'segment', 'dealType', 'salesEmail', 'clientCode', 'company', 'taxId', 'qtNo', 'requestId',
    'keyHS', 'students', 'preVat', 'creditTermDays', 'whtRate', 'poNo', 'installment', 'docStatus', 'commitDate', 'paidDate',
    'paidAmount', 'paymentMethod', 'rtNo', 'delayReason', 'note', 'source',
    '_dueDate', '_vat', '_expected', '_productLine', '_packageGroup', '_issueMonth', '_issueWeek', '_arState', '_daysOverdue',
    '_aging', '_cycleDays', '_paidMonth', '_forecastWeek', '_lastFollowUp',
    'packageName', 'salesName', 'ivRequestId', 'peakIvId', 'peakDocLink', 'branch', 'followStatus', 'nextActionDate',
    'productLineIn', 'packageGroupIn'],
  // Receipt / tax invoice requests (mostly B2C / B2E after the customer paid; also B2B).
  ReceiptRequests: ['rtRequestId', 'createdAt', 'requestedBy', 'salesName', 'segment', 'docKind', 'refDoc', 'whStudent',
    'billName', 'taxId', 'branch', 'address', 'deliveryAddress', 'email', 'whtRate', 'packages', 'description', 'price',
    'discount', 'paidDate', 'paymentProof', 'deliveryChannel', 'docLang', 'note', 'status', 'peakRtNo', 'peakDocLink',
    'sentStatus', 'sentAt', 'trackingNo', 'accountNote', 'updatedAt',
    // AG: PEAK receipt id (RT Draft made by the app from a paid INV; rt_draft until approved in PEAK).
    'peakRtId'],
  // Sales asking accounting to change a QT / INV that was already issued.
  EditRequests: ['editId', 'createdAt', 'requestedBy', 'salesName', 'docType', 'docNo', 'refId', 'company', 'detail',
    'status', 'accountNote', 'newDocNo', 'doneBy', 'updatedAt'],
  // Payment notices: Sales tells accounting a customer paid an INV (slip attached), or accounting
  // recorded a payment the customer reported directly (source = accounting). One INV is paid once.
  PaymentNotices: ['noticeId', 'createdAt', 'requestedBy', 'salesName', 'ivRequestId', 'ivNo', 'company', 'paidDate', 'amount',
    'paymentMethod', 'slipLink', 'deliveryChannel', 'email', 'deliveryAddress', 'note', 'status', 'source', 'accountNote', 'doneBy', 'updatedAt'],
  FollowUps: ['loggedAt', 'ivNo', 'channel', 'by', 'result', 'nextActionDate', 'note'],
  WHPackages: ['id', 'packageName', 'type', 'product', 'privateClass', 'freeTalk', 'discussion', 'realwork', 'months', 'extras', 'status', 'updatedAt'],
  // Written by the scheduled PEAK cross-check (read-only in PEAK): one row per document checked.
  // key = docType|docNo|appRef; result = ok | mismatch | missing | voided | not_approved | approved_in_peak.
  PeakChecks: ['key', 'docType', 'docNo', 'refId', 'result', 'detail', 'checkedAt'],
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

async function api(path, { method = 'GET', body } = {}) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${process.env.HUB_SHEET_ID}${path}`;
  const res = await jwt().request({ url, method, data: body });
  return res.data;
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
  try { require('./notify').chat(`⛔ Sales Desk หยุดบันทึกแท็บ ${table}: ${again}`); } catch (x) { /* best effort */ }
  throw e;
}
async function layoutReport() {
  const out = {};
  for (const t of Object.keys(HEADERS)) {
    try { out[t] = await checkLayout(t, { fresh: true }); } catch (e) { out[t] = `อ่านไม่ได้: ${e.message}`; }
  }
  return out;
}

async function appendRows(table, objects) {
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
  const range = encodeURIComponent(`${table}!A:${col(cols.length)}`);
  const res = await api(`/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=OVERWRITE`, {
    method: 'POST', body: { values: rows },
  });
  const m = /![A-Z]+(\d+)/.exec((res && res.updates && res.updates.updatedRange) || '');
  if (tail.length && m) await writeTail(Number(m[1]));
}

async function readTable(table) {
  const cols = TABLES[table];
  let values;
  if (mock()) values = mockRead()[table] || [];
  else {
    const range = encodeURIComponent(`${table}!A2:${col(cols.length)}`);
    values = (await api(`/values/${range}?valueRenderOption=FORMATTED_VALUE`)).values || [];
  }
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

module.exports = { TABLES, layoutProblem, layoutReport, checkLayout, appendRows, readTable, updateRow, replaceTable, log, sheetDateTime, cell };

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

// PEAK services, from the "PEAK Services (สรุป)" tab (row 6 down: A code, B name, C group,
// D WH status, E proposal, G accounting decision). The effective status is G, or E when G says
// "ตามข้อเสนอ". Codes not yet created or already deactivated in PEAK are left out (unknown to the
// form); codes due to close later are kept but flagged.
const SERVICES_RANGE = "'PEAK Services (สรุป)'!A6:G";
const GONE = ['สร้างใหม่', 'ไม่สร้าง', 'ปิดใช้งาน'];
async function readServices() {
  let rows;
  if (mock()) rows = mockRead().PeakServices || [];
  else rows = (await api(`/values/${encodeURIComponent(SERVICES_RANGE)}`)).values || [];
  const map = new Map();
  for (const r of rows) {
    const code = String(r[0] || '').trim().toUpperCase();
    if (!code) continue;
    const proposal = String(r[4] || '').trim();
    const decision = String(r[6] || '').trim();
    const status = !decision || decision === 'ตามข้อเสนอ' ? proposal : decision;
    if (GONE.includes(status)) continue;
    map.set(code, { code, name: String(r[1] || '').trim(), group: String(r[2] || '').trim(), proposal: status });
  }
  return map;
}
module.exports.readServices = readServices;

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
