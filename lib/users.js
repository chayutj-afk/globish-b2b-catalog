// Users and roles.
//   sales  (default) — sees and edits their own requests
//   op     Accountant / Admin — sees every request, accounting actions, contact import
// Admins (chayut.j@ and finance@ by default, plus ADMIN_EMAILS / OWNER_EMAILS) are always 'op'
// and are the only ones who can change roles. Roles live in the Revenue Hub "Users" tab; every
// sign-in is recorded there (new users start as sales).

const hub = require('./hub');
const session = require('./session');

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const ROLES = ['sales', 'op'];

let cache = null; // { at, rows } per instance, 30 s
async function rows(fresh) {
  if (!fresh && cache && Date.now() - cache.at < 30e3) return cache.rows;
  const r = await hub.readTable('Users');
  cache = { at: Date.now(), rows: r };
  return r;
}

async function roleOf(email) {
  const e = String(email || '').toLowerCase();
  if (session.isAdmin(e)) return 'op';
  try {
    const row = (await rows()).find((x) => x.email.toLowerCase() === e);
    return row && row.role === 'op' ? 'op' : 'sales';
  } catch (err) {
    console.error('Users read failed', err);
    return 'sales'; // fail closed
  }
}

// Async replacement for session.requireUser: role comes from the Users tab.
async function requireUser(req, { role } = {}) {
  const u = session.requireUser(req);
  u.role = await roleOf(u.email);
  u.admin = session.isAdmin(u.email);
  if (role && u.role !== role) throw bad('เฉพาะฝ่ายบัญชี / Admin', 403);
  return u;
}

// Called on every sign-in. Never blocks the login if the sheet is unavailable.
async function touch(email, name) {
  try {
    const e = String(email || '').toLowerCase();
    const now = hub.sheetDateTime();
    const all = await rows(true);
    const row = all.find((x) => x.email.toLowerCase() === e);
    if (row) await hub.updateRow('Users', row._row, { name: name || row.name, lastLogin: now });
    else await hub.appendRows('Users', [{ email: e, name: name || e, role: session.isAdmin(e) ? 'op' : 'sales', firstLogin: now, lastLogin: now, updatedBy: '', updatedAt: '' }]);
    cache = null;
  } catch (err) {
    console.error('Users touch failed', err);
  }
}

async function list() {
  return (await rows(true)).map(({ _row, ...r }) => ({ ...r, role: session.isAdmin(r.email) ? 'op' : (r.role === 'op' ? 'op' : 'sales'), admin: session.isAdmin(r.email) }));
}

async function setRole(admin, email, role) {
  if (!admin.admin) throw bad('เฉพาะผู้ดูแลสิทธิ์ (finance@ / chayut.j@)', 403);
  if (!ROLES.includes(role)) throw bad('role ต้องเป็น sales หรือ op');
  const e = String(email || '').toLowerCase();
  if (session.isAdmin(e)) throw bad('ผู้ดูแลสิทธิ์เป็นฝ่ายบัญชี / Admin เสมอ เปลี่ยนไม่ได้');
  const row = (await rows(true)).find((x) => x.email.toLowerCase() === e);
  if (!row) throw bad('ไม่พบผู้ใช้นี้ (ต้องเคยเข้าสู่ระบบก่อน)', 404);
  await hub.updateRow('Users', row._row, { role, updatedBy: admin.email, updatedAt: hub.sheetDateTime() });
  await hub.log('users', 'role_changed', e, `${admin.email} → ${role}`);
  cache = null;
}

module.exports = { requireUser, roleOf, touch, list, setRole, ROLES };
