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
    '_invoicedPreVat', '_remainingPreVat', 'peakNote', 'peakDocLink'],
  RequestLines: ['requestId', 'line', 'role', 'keyHS', 'packageId', 'peakServiceCode', 'description', 'qty', 'unitPrice', 'discount', 'listPrice'],
  InvoiceRequests: ['ivRequestId', 'createdAt', 'requestedBy', 'salesName', 'requestId', 'qtNo', 'company', 'taxId',
    'evidenceType', 'evidenceLink', 'wantedIssueDate', 'billing', 'installment', 'amountPreVat', 'students',
    'creditTermDays', 'poNo', 'financeContact', 'financeEmail', 'financePhone', 'deliveryAddress', 'note',
    'status', 'peakIvNo', 'updatedAt', 'opportunityId',
    'batchId', 'branch', 'billToRelation', 'originalDoc', 'originalStatus', 'originalRecipient', 'originalAddress',
    'originalRequestedAt', 'originalSentAt', 'trackingNo', 'overReason',
    // AL–AN: written by accounting actions in the app or by the PEAK sync.
    'peakIvId', 'peakDocLink', 'accountNote'],
  SyncLog: ['at', 'source', 'event', 'reference', 'detail'],
  // Copy of PEAK contacts that have a tax ID (from the PEAK contact export, kept up to date by the
  // PEAK QT sync). Lets the form fill the PEAK contact code from the 13-digit tax ID + branch.
  PeakContacts: ['taxId', 'branch', 'code', 'name', 'type', 'source', 'updatedAt'],
  // Everyone who has signed in. role: sales (default) | op (Accountant / Admin). Admins set roles.
  Users: ['email', 'name', 'role', 'firstLogin', 'lastLogin', 'updatedBy', 'updatedAt'],
};

const col = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

// Columns whose values must stay text even when they look like numbers (tax IDs keep
// their leading zero, branch "00000" stays as typed).
const TEXT_COLS = new Set(['taxId', 'branch', 'clientCode', 'peakQtNo', 'peakQtId', 'peakServiceCode', 'packageId', 'reference', 'qtNo', 'poNo', 'financePhone', 'installment', 'peakIvNo', 'opportunityId', 'batchId', 'trackingNo', 'code', 'peakIvId']);

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

async function appendRows(table, objects) {
  const cols = writableCols(table);
  const rows = objects.map((o) => cols.map((c) => cell(o[c], c)));
  if (mock()) {
    const db = mockRead();
    db[table] = (db[table] || []).concat(rows);
    mockWrite(db);
    return;
  }
  const range = encodeURIComponent(`${table}!A:${col(cols.length)}`);
  await api(`/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=OVERWRITE`, {
    method: 'POST', body: { values: rows },
  });
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
  const cols = TABLES[table];
  const entries = Object.entries(fields).filter(([k]) => cols.includes(k) && !k.startsWith('_'));
  if (mock()) {
    const db = mockRead();
    const row = (db[table] || [])[rowNumber - 2];
    if (row) entries.forEach(([k, v]) => { row[cols.indexOf(k)] = cell(v, k); });
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

// Replaces every data row of a table (row 2 down) with `objects`. Used for PeakContacts,
// which is a copy of PEAK and is rebuilt from each PEAK contact export.
async function replaceTable(table, objects) {
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

module.exports = { TABLES, appendRows, readTable, updateRow, replaceTable, log, sheetDateTime, cell };

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
