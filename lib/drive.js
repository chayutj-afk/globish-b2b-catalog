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

// file = { name, type, data (base64) } → web link
async function upload(file, name) {
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
  const meta = JSON.stringify({ name: safe, parents: [process.env.DOCS_FOLDER_ID] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${file.type}\r\n\r\n`),
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

module.exports = { enabled, upload, MAX_BYTES };
