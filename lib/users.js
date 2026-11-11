// Users and roles.
//   sales  (default) — sees and edits their own requests
//   op     Accountant / Admin — sees every request, accounting actions, contact import
// Admins (chayut.j@ and finance@ by default, plus ADMIN_EMAILS / OWNER_EMAILS) are always 'op'
// and are the only ones who can change roles. Roles live in the Revenue Hub "Users" tab; every
// sign-in is recorded there (new users start as sales).
//
// Team (Users tab column H) applies to Sales users: b2b, b2c or both (default both).
// b2c users don't get the B2B Product Catalog. Accountant / Admin always see everything.

const hub = require('./hub');
const session = require('./session');

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
// sales = Sales; operation = Sales + Catalog Operation (Key.H.S / manage packages); op = Accountant / Admin.
const ROLES = ['sales', 'operation', 'op'];
const roleVal = (r) => (ROLES.includes(r) ? r : 'sales');
const TEAMS = ['b2b', 'b2c', 'both'];
const teamVal = (t) => (TEAMS.includes(String(t || '').toLowerCase()) ? String(t).toLowerCase() : 'both');

let cache = null; // { at, rows } per instance, 30 s
async function rows(fresh) {
  if (!fresh && cache && Date.now() - cache.at < 30e3) return cache.rows;
  // Two sign-ins at the same moment can append the same new user twice; the first row wins.
  const seen = new Set();
  const r = (await hub.readTable('Users')).filter((x) => {
    const e = String(x.email || '').toLowerCase();
    if (!e || seen.has(e)) return false;
    seen.add(e); return true;
  });
  cache = { at: Date.now(), rows: r };
  return r;
}

// → { role, team }
async function accessOf(email) {
  const e = String(email || '').toLowerCase();
  if (session.isAdmin(e)) return { role: 'op', team: 'both' };
  try {
    const row = (await rows()).find((x) => x.email.toLowerCase() === e);
    return { role: roleVal(row && row.role), team: teamVal(row && row.team) };
  } catch (err) {
    console.error('Users read failed', err);
    return { role: 'sales', team: 'b2c' }; // fail closed
  }
}
async function roleOf(email) { return (await accessOf(email)).role; }

// Can this user open the B2B Product Catalog?
const seesCatalog = (u) => u.role === 'op' || u.role === 'operation' || u.team !== 'b2c';
// Catalog Operation section (Key.H.S generator, edit / save packages).
const catalogOp = (u) => u.role === 'op' || u.role === 'operation';

// Async replacement for session.requireUser: role comes from the Users tab.
async function requireUser(req, { role } = {}) {
  const u = session.requireUser(req);
  Object.assign(u, await accessOf(u.email));
  u.admin = session.isAdmin(u.email);
  u.catalog = seesCatalog(u);
  u.catalogOp = catalogOp(u);
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
    else await hub.appendRows('Users', [{ email: e, name: name || e, role: session.isAdmin(e) ? 'op' : 'sales', firstLogin: now, lastLogin: now, updatedBy: '', updatedAt: '', team: 'both' }]);
    cache = null;
  } catch (err) {
    console.error('Users touch failed', err);
  }
}

async function list() {
  return (await rows(true)).map(({ _row, ...r }) => ({ ...r, role: session.isAdmin(r.email) ? 'op' : roleVal(r.role), team: teamVal(r.team), salesPerf: r.salesPerf || '', admin: session.isAdmin(r.email) }));
}

// change = { role?, team?, salesPerf? }  salesPerf = PEAK "Sales Performance" item code ('' = none)
async function setRole(admin, email, change) {
  if (!admin.admin) throw bad('เฉพาะผู้ดูแลสิทธิ์ (finance@ / chayut.j@)', 403);
  const patch = {};
  if (change.role !== undefined) {
    if (!ROLES.includes(change.role)) throw bad('role ต้องเป็น sales, operation หรือ op');
    patch.role = change.role;
  }
  if (change.team !== undefined) {
    if (!TEAMS.includes(change.team)) throw bad('team ต้องเป็น b2b, b2c หรือ both');
    patch.team = change.team;
  }
  if (change.salesPerf !== undefined) {
    const code = String(change.salesPerf || '').trim();
    if (code && !(await hub.readSalesPerf()).some((x) => x.code === code)) throw bad('ไม่พบรหัส Sales Performance นี้ในรายการ (Lists!K)');
    patch.salesPerf = code;
  }
  if (!Object.keys(patch).length) throw bad('ไม่มีอะไรให้เปลี่ยน');
  const e = String(email || '').toLowerCase();
  if (session.isAdmin(e) && (patch.role || patch.team)) throw bad('ผู้ดูแลสิทธิ์เป็นฝ่ายบัญชี / Admin เสมอ เปลี่ยนไม่ได้');
  const row = (await rows(true)).find((x) => x.email.toLowerCase() === e);
  if (!row) throw bad('ไม่พบผู้ใช้นี้ (ต้องเคยเข้าสู่ระบบก่อน)', 404);
  await hub.updateRow('Users', row._row, { ...patch, updatedBy: admin.email, updatedAt: hub.sheetDateTime() });
  await hub.log('users', 'access_changed', e, `${admin.email} → ${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  cache = null;
}

module.exports = { requireUser, roleOf, touch, list, setRole, seesCatalog, catalogOp, ROLES, TEAMS };
