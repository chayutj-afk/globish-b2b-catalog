// Data health: is what the app works from up to date and complete?
// The app has no live link to PEAK or Whitehouse, so this collects the signs that a copy is stale,
// the scheduled sync stopped, items are stuck, the sheet layout changed, or the PEAK cross-check
// found a mismatch. Shown on /users (admins) and sent once a day to Google Chat when anything is wrong.

const hub = require('./hub');

// "dd/MM/yyyy HH:mm" (Bangkok) or "yyyy-mm-dd…" → ms (UTC), or null.
function when(s) {
  s = String(s || '').trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(s);
  if (m) return Date.UTC(+m[3] > 2400 ? +m[3] - 543 : +m[3], +m[2] - 1, +m[1], +(m[4] || 0) - 7, +(m[5] || 0));
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2}))?/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0) - 7, +(m[5] || 0));
  return null;
}
const H = 3600e3, D = 24 * H;
const ago = (ms, now) => { if (ms === null) return '(ไม่พบเวลา)'; const h = (now - ms) / H; return h < 1 ? 'ไม่ถึง 1 ชม.' : h < 48 ? `${Math.round(h)} ชม.` : `${Math.round(h / 24)} วัน`; };
const latest = (rows, k) => rows.reduce((m, r) => { const t = when(r[k]); return t !== null && (m === null || t > m) ? t : m; }, null);

// Limits (days) after which a copy counts as stale; tune here.
const STALE = { contacts: 14, wh: 14, run: 0.75 }; // run: longest normal gap is 17:49 → 10:49 (17 h); + 2 h grace below // the PEAK sync runs at 10:49 and 17:49

async function collect(now = Date.now()) {
  const items = [];
  const add = (level, area, title, detail = '', fix = '') => items.push({ level, area, title, detail, fix });
  const safe = async (p, d) => { try { return await p; } catch (e) { add('bad', 'ระบบ', 'อ่านข้อมูลไม่ได้', e.message); return d; } };

  const [layout, contacts, wh, services, salesPerf, reqs, ivs, rts, edits, invs, log, checks] = await Promise.all([
    safe(hub.layoutReport(), {}), safe(hub.readTable('PeakContacts'), []), safe(hub.readTable('WHPackages'), []),
    safe(hub.readServices(), new Map()), safe(hub.readSalesPerf(), []), safe(hub.readTable('Requests'), []),
    safe(hub.readTable('InvoiceRequests'), []), safe(hub.readTable('ReceiptRequests'), []), safe(hub.readTable('EditRequests'), []),
    safe(hub.readTable('Invoices'), []), safe(hub.readTable('SyncLog'), []), hub.readTable('PeakChecks').catch(() => null),
  ]);

  // 1. Sheet layout
  const broken = Object.entries(layout).filter(([, p]) => p);
  if (broken.length) broken.forEach(([t, p]) => add('bad', 'Revenue Hub', `คอลัมน์แท็บ ${t} ไม่ตรง แอปหยุดบันทึกแท็บนี้`, p, 'แก้หัวคอลัมน์/ย้ายคอลัมน์กลับให้ตรงเดิม'));
  else add('ok', 'Revenue Hub', 'โครงคอลัมน์ทุกแท็บตรงกับที่แอปใช้');
  if (checks === null) add('warn', 'Revenue Hub', 'ยังไม่มีแท็บ PeakChecks (ผลตรวจกับ PEAK)');

  // 2. Copies of outside data
  const cAt = latest(contacts, 'updatedAt');
  add(cAt === null || now - cAt > STALE.contacts * D ? 'warn' : 'ok', 'สำเนาข้อมูล', `ลูกค้า PEAK (PeakContacts) ${contacts.length.toLocaleString()} ราย · อัปเดต ${ago(cAt, now)}${cAt === null ? '' : 'ที่แล้ว'}`,
    '', 'Export ผู้ติดต่อจาก PEAK แล้วอัปโหลดที่หน้า "ลูกค้า PEAK"');
  const wAt = latest(wh, 'updatedAt');
  add(wAt === null || now - wAt > STALE.wh * D ? 'warn' : 'ok', 'สำเนาข้อมูล', `แพ็กเกจ Whitehouse ${wh.length.toLocaleString()} รายการ · อัปเดต ${ago(wAt, now)}${wAt === null ? '' : 'ที่แล้ว'}`,
    '', 'นำเข้าใหม่ที่หน้า "แพ็กเกจ WH"');
  const svc = [...services.values()];
  const cut = svc.filter((s) => s.name.length === 45).length;
  add('ok', 'สำเนาข้อมูล', `รหัสบริการ PEAK (PEAK Services) ${svc.length.toLocaleString()} รหัส`, cut ? `${cut} รหัสชื่อถูกตัดที่ 45 ตัวอักษร (ใช้ชื่อเต็มจาก WH เมื่อมี)` : '',
    'รหัสใหม่ที่สร้างใน PEAK ต้องเพิ่มในแท็บนี้ ไม่งั้นเซลส่งคำขอไม่ได้');
  const users = await hub.readTable('Users').catch(() => []);
  const salesNoPerf = users.filter((u) => !u.salesPerf && (u.role === 'sales' || u.role === 'lead') && u.lastLogin).length;
  if (salesNoPerf) add('warn', 'สำเนาข้อมูล', `เซล ${salesNoPerf} คนยังไม่ได้ติด Sales Performance`, 'QT ของคนเหล่านี้จะไม่มีแท็ก G014', 'ตั้งที่หน้าจัดการผู้ใช้ (รายการรหัสอยู่ที่ Lists!K)');
  if (!salesPerf.length) add('warn', 'สำเนาข้อมูล', 'Lists!K (Sales Performance) ว่าง');

  // 3. Scheduled PEAK sync
  const runs = log.filter((r) => r.source === 'claude-peak-mcp');
  const lastRun = latest(runs, 'at');
  add(lastRun === null || now - lastRun > STALE.run * D + 2 * H ? 'warn' : 'ok', 'งานตั้งเวลา', lastRun === null ? 'ยังไม่พบบันทึกการทำงานของ PEAK sync ใน SyncLog' : `PEAK sync ทำงานล่าสุด ${ago(lastRun, now)}ที่แล้ว`,
    'รันทุกวัน 10:49 และ 17:49', 'ถ้าเกิน 1 รอบ: เปิดดูงานตั้งเวลา "PEAK QT sync" ว่า error หรือการเชื่อม PEAK/Sheets หลุดไหม');

  // 4. Stuck items
  const older = (r, k, ms) => { const t = when(r[k]); return t !== null && now - t > ms; };
  const stuck = (rows, test, title, fix, level = 'warn') => { const xs = rows.filter(test); if (xs.length) add(level, 'งานค้าง', `${title} (${xs.length})`, xs.slice(0, 5).map((x) => x.requestId || x.ivRequestId || x.rtRequestId || x.editId).join(', ') + (xs.length > 5 ? ' …' : ''), fix); };
  stuck(reqs, (r) => r.status === 'qt_creating' && older(r, 'updatedAt', 2 * H), 'QT ค้างที่ "กำลังสร้างใน PEAK"', 'งานตั้งเวลาอาจหยุดกลางทาง: ตรวจใน PEAK ว่ามี QT ของคำขอนี้หรือยัง แล้วแก้สถานะ', 'bad');
  stuck(reqs, (r) => r.status === 'approved' && older(r, 'updatedAt', 14 * H), 'อนุมัติแล้วแต่ยังไม่มี QT เกิน 1 รอบ sync', 'ดูว่างานตั้งเวลารันหรือไม่');
  stuck(reqs, (r) => ['needs_contact', 'needs_service_code', 'needs_review', 'qt_error'].includes(r.status), 'คำขอ QT รอฝ่ายบัญชีแก้ปัญหา', 'เปิดหน้ารออนุมัติ');
  stuck(reqs, (r) => r.status === 'new' && older(r, 'createdAt', D), 'คำขอ QT รออนุมัติเกิน 1 วัน', 'หน้ารออนุมัติ');
  stuck(reqs, (r) => r.status === 'qt_draft' && older(r, 'updatedAt', 2 * D), 'QT Draft รออนุมัติใน PEAK เกิน 2 วัน', 'อนุมัติใน PEAK');
  stuck(ivs, (r) => ['new', 'iv_draft'].includes(r.status) && older(r, 'createdAt', 2 * D), 'คำขอ INV ค้างเกิน 2 วัน', 'หน้ารออนุมัติ');
  stuck(ivs, (r) => r.status === 'iv_issued' && !r.peakIvNo, 'INV ออกแล้วแต่ไม่มีเลข INV', 'ใส่เลข INV', 'bad');
  stuck(rts, (r) => r.status === 'new' && older(r, 'createdAt', 2 * D), 'คำขอใบเสร็จค้างเกิน 2 วัน', 'หน้ารออนุมัติ');
  stuck(edits, (r) => r.status === 'new' && older(r, 'createdAt', 2 * D), 'คำขอแก้ไขเอกสารค้างเกิน 2 วัน', 'หน้ารออนุมัติ');
  const issuedNoAr = ivs.filter((r) => r.status === 'iv_issued' && r.peakIvNo && !invs.some((a) => String(a.ivNo).toUpperCase() === String(r.peakIvNo).toUpperCase()));
  if (issuedNoAr.length) add('bad', 'งานค้าง', `INV ออกแล้วแต่ไม่อยู่ในหน้าติดตามหนี้ (${issuedNoAr.length})`, issuedNoAr.slice(0, 5).map((r) => r.peakIvNo).join(', '), 'แจ้งผู้ดูแลระบบ');
  const legacy = invs.filter((r) => r.docStatus === 'Active' && !r.paidDate && r.followStatus === 'ตรวจสถานะกับ PEAK (ข้อมูลเก่า)').length;
  if (legacy) add('warn', 'งานค้าง', `INV ข้อมูลเก่ารอตรวจสถานะกับ PEAK (${legacy})`, 'งานตั้งเวลาตรวจรอบละ 40 ใบ');
  if (!items.some((i) => i.area === 'งานค้าง')) add('ok', 'งานค้าง', 'ไม่มีงานค้างผิดปกติ');

  // 5. PEAK cross-check results (latest row per document)
  if (checks) {
    const last = new Map();
    checks.forEach((c) => { const p = last.get(c.key); if (!p || (when(c.checkedAt) || 0) >= (when(p.checkedAt) || 0)) last.set(c.key, c); });
    const bad = [...last.values()].filter((c) => c.result && c.result !== 'ok');
    const lastCheck = latest(checks, 'checkedAt');
    const LABEL = { mismatch: 'ข้อมูลไม่ตรงกับ PEAK', missing: 'ไม่พบใน PEAK', voided: 'ถูก void ใน PEAK', not_approved: 'ยังไม่อนุมัติใน PEAK', approved_in_peak: 'อนุมัติใน PEAK แล้วแต่แอปยังไม่อัปเดต' };
    bad.forEach((c) => add(c.result === 'not_approved' || c.result === 'approved_in_peak' ? 'warn' : 'bad', 'ตรวจกับ PEAK', `${c.docType} ${c.docNo}: ${LABEL[c.result] || c.result}`, `${c.detail}${c.refId ? ' · ' + c.refId : ''} · ตรวจเมื่อ ${c.checkedAt}`));
    if (!bad.length) add('ok', 'ตรวจกับ PEAK', `เอกสารที่ตรวจแล้วตรงกับ PEAK ทั้งหมด (${last.size})`, lastCheck ? `ตรวจล่าสุด ${ago(lastCheck, now)}ที่แล้ว` : 'ยังไม่เคยตรวจ');
  }

  const order = { bad: 0, warn: 1, ok: 2 };
  items.sort((a, b) => order[a.level] - order[b.level]);
  return { at: hub.sheetDateTime(new Date(now)), bad: items.filter((i) => i.level === 'bad').length, warn: items.filter((i) => i.level === 'warn').length, items };
}

function digest(h) {
  const xs = h.items.filter((i) => i.level !== 'ok');
  if (!xs.length) return '';
  return [`🩺 สุขภาพข้อมูล Sales Desk (${h.at}): ผิดปกติ ${h.bad} · ควรดู ${h.warn}`,
    ...xs.slice(0, 15).map((i) => `${i.level === 'bad' ? '⛔' : '⚠️'} ${i.title}${i.detail ? ': ' + i.detail : ''}`),
    xs.length > 15 ? `…และอีก ${xs.length - 15} รายการ` : '', 'ดูทั้งหมดที่หน้าจัดการผู้ใช้ › สุขภาพข้อมูล'].filter(Boolean).join('\n');
}

module.exports = { collect, digest, when };
