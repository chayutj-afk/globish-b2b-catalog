// Evidence files (signed QT, PO, confirmation email) go to a Drive folder that sits in a
// Shared Drive. Service accounts have no My Drive storage, so DOCS_FOLDER_ID must be a
// folder inside a Shared Drive where the service account is a Content manager.
// Without DOCS_FOLDER_ID the form takes a Drive link instead of an upload.

const MAX_BYTES = 3 * 1024 * 1024; // Vercel's 4.5 MB request limit, minus base64 overhead
const TYPES = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };

function enabled() {
  return !!process.env.DOCS_FOLDER_ID || process.env.HUB_MODE === 'mock';
}

let client = null;
function jwt() {
  if (client) return client;
  const { JWT } = require('google-auth-library');
  client = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return client;
}

// Sub-folders under DOCS_FOLDER_ID: <type> / <yyyy-mm>, created on first use.
const KINDS = {
  inv: { folder: 'หลักฐาน INV', tag: 'INV-EVIDENCE' },
  company: { folder: 'เอกสารบริษัท', tag: 'COMPANY-DOC' },
  payment: { folder: 'หลักฐานชำระ (ใบเสร็จ)', tag: 'PAYMENT-PROOF' },
};
const bkk = () => new Date(Date.now() + 7 * 3600e3).toISOString();
// yyyy-mm-dd_TYPE_docNo_company_ref  (the user's own file name is never used)
function fileName({ kind, docNo, company, ref, part }) {
  const clean = (v, n) => String(v || '').replace(/\s+/g, '').replace(/[^\w.\-ก-๙]/g, '').slice(0, n);
  return [bkk().slice(0, 10), (KINDS[kind] || KINDS.inv).tag + (part ? `-${part}` : ''), clean(docNo, 40), clean(company, 50), clean(ref, 40)].filter(Boolean).join('_');
}

const folderCache = new Map();
async function folderId(parent, name) {
  const key = `${parent}/${name}`;
  if (folderCache.has(key)) return folderCache.get(key);
  const q = encodeURIComponent(`name = '${name.replace(/'/g, "\\'")}' and '${parent}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const found = await jwt().request({ url: `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,createdTime)&orderBy=createdTime&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives` });
  let id = found.data.files && found.data.files[0] && found.data.files[0].id;
  if (!id) {
    const made = await jwt().request({ url: 'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id', method: 'POST',
      data: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] } });
    id = made.data.id;
  }
  folderCache.set(key, id);
  return id;
}

// file = { name, type, data (base64) }, meta = { kind: inv|company|payment, docNo, company, ref, part } → web link
async function upload(file, meta) {
  const name = typeof meta === 'string' ? meta : fileName(meta || {});
  const kind = (meta && meta.kind) || 'inv';
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  if (!file || typeof file.data !== 'string') throw bad('ไม่พบไฟล์แนบ');
  const ext = TYPES[file.type];
  if (!ext) throw bad('แนบได้เฉพาะไฟล์ PDF, JPG หรือ PNG');
  const bytes = Buffer.from(file.data, 'base64');
  if (!bytes.length) throw bad('ไฟล์แนบว่างเปล่า');
  if (bytes.length > MAX_BYTES) throw bad('ไฟล์แนบใหญ่เกิน 3 MB (ลองย่อหรือแปลงเป็น PDF ก่อน)');
  const safe = `${name}.${ext}`.replace(/[^\w.\-ก-๙ ]/g, '_');

  if (process.env.HUB_MODE === 'mock') return `mock://drive/${safe}`;

  const boundary = 'gc' + Date.now().toString(36);
  let parent = process.env.DOCS_FOLDER_ID;
  try { parent = await folderId(await folderId(parent, (KINDS[kind] || KINDS.inv).folder), bkk().slice(0, 7)); }
  catch (e) { console.error('Drive folder lookup failed, saving to the root folder', e.message); }
  const metaJson = JSON.stringify({ name: safe, parents: [parent] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metaJson}\r\n--${boundary}\r\nContent-Type: ${file.type}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const res = await jwt().request({
    url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink',
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  return res.data.webViewLink || `https://drive.google.com/file/d/${res.data.id}/view`;
}

module.exports = { enabled, upload, fileName, MAX_BYTES };
