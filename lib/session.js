// Session cookie shared by every API route (and verified again in middleware.js).
//
// Format: base64url(JSON {email, name, role, exp}) + "." + base64url(HMAC-SHA256(that, AUTH_SECRET))
// The cookie is HttpOnly + Secure + SameSite=Lax, so page JavaScript never sees it and
// cross-site POSTs don't carry it. middleware.js re-implements verify() with Web Crypto
// (Edge runtime); keep the two in step.

const crypto = require('crypto');

const COOKIE = 'gc_session';
const STATE_COOKIE = 'gc_oauth_state';
const TTL_MS = 12 * 60 * 60 * 1000; // 12 hours, same as License Desk

function secret() {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) {
    const e = new Error('Server ยังไม่ได้ตั้งค่า AUTH_SECRET (ต้องยาวอย่างน้อย 32 ตัวอักษร)');
    e.status = 500;
    throw e;
  }
  return s;
}

function domain() {
  return (process.env.ALLOWED_EMAIL_DOMAIN || 'globish.co.th').toLowerCase();
}

function domainOk(email) {
  return typeof email === 'string' && email.toLowerCase().endsWith('@' + domain());
}

function listEnv(name, fallback) {
  return (process.env[name] || fallback || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Admins (fixed): manage other users' roles and are always Accountant/Admin ('op').
// Everyone else gets their role from the Users tab in the Revenue Hub (lib/users.js); this
// synchronous check only knows the admins, so it returns 'sales' for the rest.
const DEFAULT_ADMINS = 'chayut.j@globish.co.th,finance@globish.co.th';
function adminEmails() {
  return new Set([...DEFAULT_ADMINS.split(','), ...listEnv('ADMIN_EMAILS'), ...listEnv('OWNER_EMAILS')]);
}
function isAdmin(email) { return adminEmails().has(String(email || '').toLowerCase()); }
function roleFor(email) { return isAdmin(email) ? 'op' : 'sales'; }

function sign(payload) {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verify(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 1) return null;
  const [b64, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret()).update(b64).digest('base64url');
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')); } catch { return null; }
  if (!p || typeof p.exp !== 'number' || Date.now() > p.exp) return null;
  if (!domainOk(p.email)) return null;
  return p;
}

function parseCookies(req) {
  const out = {};
  const raw = (req.headers && req.headers.cookie) || '';
  raw.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function cookieHeader(name, value, maxAgeSec) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

function issue(email, name) {
  const user = { email: email.toLowerCase(), name: name || email, role: roleFor(email), exp: Date.now() + TTL_MS };
  return { user, header: cookieHeader(COOKIE, sign(user), Math.floor(TTL_MS / 1000)) };
}

function clearHeader(name = COOKIE) {
  return cookieHeader(name, '', 0);
}

// Returns the signed-in user or throws a 401/403 error. The role is re-derived from the
// environment on every call, so removing someone from OPS_EMAILS takes effect at once.
function requireUser(req, { role } = {}) {
  const p = verify(parseCookies(req)[COOKIE]);
  if (!p) {
    const e = new Error('กรุณาเข้าสู่ระบบด้วยบัญชี @' + domain());
    e.status = 401;
    throw e;
  }
  const user = { email: p.email, name: p.name, role: roleFor(p.email) };
  if (role && user.role !== role) {
    const e = new Error('บัญชีนี้ไม่มีสิทธิ์ Operation');
    e.status = 403;
    throw e;
  }
  return user;
}

// State-changing calls must come from our own pages (defence in depth next to SameSite).
function checkOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  let ok = false;
  try { ok = !!origin && !!host && new URL(origin).host === host; } catch { ok = false; }
  if (!ok) {
    const e = new Error('คำขอไม่ถูกต้อง');
    e.status = 403;
    throw e;
  }
}

function sendError(res, e) {
  const status = e && e.status >= 400 && e.status < 600 ? e.status : 500;
  if (status >= 500) console.error(e);
  res.status(status).json({ ...((e && e.extra) || {}), ok: false, error: (e && e.message) || 'เกิดข้อผิดพลาด' });
}

module.exports = {
  COOKIE, STATE_COOKIE, TTL_MS,
  domain, domainOk, roleFor, isAdmin, sign, verify, parseCookies, cookieHeader,
  issue, clearHeader, requireUser, checkOrigin, sendError,
};
