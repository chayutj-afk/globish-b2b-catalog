// GET /catalog → the B2B Product Catalog page, only for users allowed to see it.
// Sales users on team b2c get a short "no access" page instead. The page file itself
// (/2026B2BStandardCatalog.html) is redirected here by middleware.js.
const fs = require('fs');
const path = require('path');
const { sendError } = require('../lib/session');
const { requireUser } = require('../lib/users');

const FILE = path.join(process.cwd(), '2026B2BStandardCatalog.html');
let html = null;

const DENIED = `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ไม่มีสิทธิ์ · Globish Sales Desk</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f7f7f8;color:#1f2937;margin:0;display:grid;place-items:center;min-height:100vh;padding:16px}
.c{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:28px;max-width:440px;text-align:center}a{color:#ea580c;font-weight:600}</style></head>
<body><div class="c"><h2>ไม่มีสิทธิ์ดู B2B Product Catalog</h2><p>บัญชีนี้อยู่ทีม B2C ถ้าต้องใช้ Catalog ให้แจ้งผู้ดูแลสิทธิ์ (finance@ / chayut.j@) เปลี่ยนทีมเป็น B2B หรือ Both</p><p><a href="/">← กลับหน้าแรก</a></p></div></body></html>`;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    let user;
    try { user = await requireUser(req); } catch (e) {
      if (e.status === 401) { res.statusCode = 302; res.setHeader('Location', '/signin.html?next=/catalog'); return res.end(); }
      if (e.status === 403) { res.statusCode = 302; res.setHeader('Location', '/'); return res.end(); } // account not activated yet: the home page says so
      throw e;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (!user.catalog) return res.status(403).send(DENIED);
    if (!html) html = fs.readFileSync(FILE, 'utf8');
    return res.status(200).send(html);
  } catch (e) {
    return sendError(res, e);
  }
};
