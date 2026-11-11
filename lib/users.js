// Users, roles and permissions (Revenue Hub "Users" tab; every sign-in is recorded, new users start as Sales).
// A role is a fixed set of permissions (ROLE_PERMS); admins can add extra permissions per person (column J).
// Team (column H: b2b / b2c / both) limits the B2B catalog and what a หัวหน้าเซล sees.
// finance@ / chayut.j@ (and ADMIN_EMAILS) are always Admin and can't be changed from the app.

const hub = require('./hub');
const session = require('./session');

const bad = (m, status = 400) => Object.assign(new Error(m), { status });

// Roles = a fixed set of permissions; admins can add extra permissions per person (Users column J).
//   'op' is the internal value for Accounting (kept so existing rows stay valid).
const ROLES = ['sales', 'lead', 'operation', 'op', 'collector', 'admin'];
const ROLE_LABEL = { sales: 'Sales', lead: 'หัวหน้าเซล', operation: 'Product / Operation', op: 'บัญชี', collector: 'ตามหนี้', admin: 'Admin' };
const PERMS = {
  request: 'ขอ QT / INV / ใบเสร็จ',
  catalog: 'ดู B2B Catalog',
  catalog_edit: 'แก้ Catalog / Key H.S.',
  team_view: 'เห็นคำขอของทั้งทีม',
  approve: 'อนุมัติเอกสาร (QT / INV / ใบเสร็จ / ขอแก้ไข / ตัวจริง)',
  ar_view: 'ดูหน้าติดตามหนี้',
  ar: 'บันทึกติดตามหนี้ / รับเงิน',
  import: 'นำเข้าลูกค้า PEAK / แพ็กเกจ WH',
  users: 'จัดการผู้ใช้',
};
const ROLE_PERMS = {
  sales: ['request', 'catalog'],
  lead: ['request', 'catalog', 'team_view', 'ar_view'],
  operation: ['request', 'catalog', 'catalog_edit'],
  op: ['request', 'catalog', 'team_view', 'approve', 'ar_view', 'ar', 'import'],
  collector: ['ar_view', 'ar'],
  admin: Object.keys(PERMS),
};
const roleVal = (r) => (ROLES.includes(r) ? r : 'sales');
const TEAMS = ['b2b', 'b2c', 'both'];
const teamVal = (t) => (TEAMS.includes(String(t || '').toLowerCase()) ? String(t).toLowerCase() : 'both');
const extraVal = (v) => String(v || '').split(/[,\s]+/).filter((p) => PERMS[p]);

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

// Effective permissions. B2C-team people don't see the B2B catalog unless they can edit it.
function permsFor({ role, team, extra, admin }) {
  const p = new Set(admin ? ROLE_PERMS.admin : [...(ROLE_PERMS[role] || []), ...(extra || [])]);
  if (team === 'b2c' && !p.has('catalog_edit') && !p.has('approve') && !admin) p.delete('catalog');
  if (p.has('ar')) p.add('ar_view');
  return [...p];
}

// → { role, team, extra }
async function accessOf(email) {
  const e = String(email || '').toLowerCase();
  if (session.isAdmin(e)) return { role: 'admin', team: 'both', extra: [] };
  try {
    const row = (await rows()).find((x) => x.email.toLowerCase() === e);
    return { role: roleVal(row && row.role), team: teamVal(row && row.team), extra: extraVal(row && row.perms) };
  } catch (err) {
    console.error('Users read failed', err);
    return { role: 'sales', team: 'b2c', extra: [] }; // fail closed
  }
}
async function roleOf(email) { return (await accessOf(email)).role; }

const can = (u, perm) => !!u && (u.admin === true || (Array.isArray(u.perms) && u.perms.includes(perm)));
const seesCatalog = (u) => can(u, 'catalog');
const catalogOp = (u) => can(u, 'catalog_edit');

// Who's requests can this user see? own, all (approve), or the same team (team_view).
async function visibility(u) {
  if (can(u, 'approve') || u.admin) return () => true;
  if (!can(u, 'team_view')) return (email) => String(email).toLowerCase() === u.email;
  if (u.team === 'both') return () => true;
  const teams = new Map((await rows()).map((x) => [x.email.toLowerCase(), teamVal(x.team)]));
  return (email) => { const e = String(email).toLowerCase(); return e === u.email || [u.team, 'both'].includes(teams.get(e) || 'both'); };
}

// Async replacement for session.requireUser: role and permissions come from the Users tab.
//   requireUser(req, { perm: 'approve' }) → 403 without it. { role: 'op' } is the older form (= approve).
async function requireUser(req, { role, perm } = {}) {
  const u = session.requireUser(req);
  Object.assign(u, await accessOf(u.email));
  u.admin = session.isAdmin(u.email) || u.role === 'admin';
  u.perms = permsFor(u);
  u.catalog = seesCatalog(u);
  u.catalogOp = catalogOp(u);
  const need = perm || (role === 'op' ? 'approve' : role);
  if (need && !can(u, need)) throw bad(`ไม่มีสิทธิ์: ${PERMS[need] || need} (ขอสิทธิ์จากผู้ดูแลที่หน้าจัดการผู้ใช้)`, 403);
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
    else await hub.appendRows('Users', [{ email: e, name: name || e, role: session.isAdmin(e) ? 'admin' : 'sales', firstLogin: now, lastLogin: now, updatedBy: '', updatedAt: '', team: 'both' }]);
    cache = null;
  } catch (err) {
    console.error('Users touch failed', err);
  }
}

async function list() {
  return (await rows(true)).map(({ _row, ...r }) => {
    const fixed = session.isAdmin(r.email);
    const x = { ...r, role: fixed ? 'admin' : roleVal(r.role), team: teamVal(r.team), salesPerf: r.salesPerf || '', extra: fixed ? [] : extraVal(r.perms), admin: fixed, fixedAdmin: fixed };
    x.perms = permsFor({ ...x, admin: fixed || x.role === 'admin' });
    return x;
  });
}

// change = { role?, team?, salesPerf?, extra?: [perm] }  salesPerf = PEAK "Sales Performance" item code ('' = none)
async function setRole(admin, email, change) {
  if (!can(admin, 'users')) throw bad('เฉพาะผู้ดูแลสิทธิ์', 403);
  const patch = {};
  if (change.role !== undefined) {
    if (!ROLES.includes(change.role)) throw bad(`role ต้องเป็น ${ROLES.join(', ')}`);
    patch.role = change.role;
  }
  if (change.extra !== undefined) {
    if (!Array.isArray(change.extra) || change.extra.some((p) => !PERMS[p])) throw bad('สิทธิ์ไม่ถูกต้อง');
    patch.perms = [...new Set(change.extra)].join(',');
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
  if (session.isAdmin(e) && (patch.role || patch.team || patch.perms !== undefined)) throw bad('ผู้ดูแลสิทธิ์หลัก (finance@ / chayut.j@) เป็น Admin เสมอ เปลี่ยนไม่ได้');
  if (e === admin.email && patch.role && patch.role !== 'admin') throw bad('เปลี่ยน role ของตัวเองไม่ได้ ให้ผู้ดูแลคนอื่นเปลี่ยน');
  const row = (await rows(true)).find((x) => x.email.toLowerCase() === e);
  if (!row) throw bad('ไม่พบผู้ใช้นี้ (ต้องเคยเข้าสู่ระบบก่อน)', 404);
  await hub.updateRow('Users', row._row, { ...patch, updatedBy: admin.email, updatedAt: hub.sheetDateTime() });
  await hub.log('users', 'access_changed', e, `${admin.email} → ${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  cache = null;
}

module.exports = { requireUser, roleOf, touch, list, setRole, seesCatalog, catalogOp, can, visibility, ROLES, ROLE_LABEL, ROLE_PERMS, PERMS, TEAMS };
