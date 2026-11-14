// A customer not yet in PEAK: Sales fills the details on the QT request (Requests AL, JSON), and the
// app creates the contact in PEAK when accounting approves the request (lib/qtdraft.js). Field names
// follow PEAK POST /Contacts (additionalProperties false, so nothing else is sent).

const bad = (m) => Object.assign(new Error(m), { status: 400 });
const text = (v, n) => String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, n);

// PEAK contact type (int). Labels as Sales sees them.
const TYPES = { 2: 'บริษัทจำกัด', 3: 'บริษัทมหาชนจำกัด', 1: 'ห้างหุ้นส่วนจำกัด', 8: 'ห้างหุ้นส่วนสามัญ', 5: 'บุคคลธรรมดา',
  9: 'มูลนิธิ', 10: 'สมาคม', 6: 'คณะบุคคล', 4: 'ร้านค้า', 11: 'กิจการร่วมค้า', 7: 'อื่นๆ (เช่น หน่วยงานรัฐ)' };
const PREFIX = { 1: 'คุณ', 2: 'นาย', 3: 'นาง', 4: 'นางสาว' };

// Request body → the object stored in Requests AL (or null when the form sent none).
function clean(b) {
  if (!b || typeof b !== 'object') return null;
  const c = {
    type: Number(b.type), prefixNameType: b.prefixNameType === undefined || b.prefixNameType === '' ? undefined : Number(b.prefixNameType),
    address: text(b.address, 250), subDistrict: text(b.subDistrict, 100), district: text(b.district, 100),
    province: text(b.province, 100), postCode: text(b.postCode, 5).replace(/\D/g, ''),
    callCenterNumber: text(b.phone, 40), contactFirstName: text(b.contactName, 120), contactPhoneNumber: text(b.contactPhone, 40),
  };
  if (!TYPES[c.type]) throw bad('เลือกประเภทลูกค้าใหม่ (บริษัท / บุคคลธรรมดา / …)');
  if (c.type === 5 && !PREFIX[c.prefixNameType]) throw bad('เลือกคำนำหน้าชื่อลูกค้า (คุณ / นาย / นาง / นางสาว)');
  if (c.type !== 5) delete c.prefixNameType;
  if (!c.address) throw bad('ใส่ที่อยู่ลูกค้าใหม่ (ตามหนังสือรับรอง / ภ.พ.20)');
  if (!c.province) throw bad('ใส่จังหวัดของลูกค้าใหม่');
  if (!/^\d{5}$/.test(c.postCode)) throw bad('รหัสไปรษณีย์ลูกค้าใหม่ต้องมี 5 หลัก');
  for (const k of Object.keys(c)) if (c[k] === '' || c[k] === undefined) delete c[k];
  return c;
}

// Stored details + the request → PEAK contact body.
function toPeak(c, row) {
  return {
    name: text(row.company, 256), type: c.type, ...(c.prefixNameType ? { prefixNameType: c.prefixNameType } : {}),
    taxNumber: String(row.taxId || '').replace(/\D/g, ''), branchCode: row.branch || '00000',
    address: c.address, subDistrict: c.subDistrict, district: c.district, province: c.province, country: 'Thailand', postCode: c.postCode,
    callCenterNumber: c.callCenterNumber, email: row.customerEmail || undefined,
    contactFirstName: c.contactFirstName, contactPhoneNumber: c.contactPhoneNumber, contactEmail: row.customerEmail || undefined,
    contactFinanceType: 1, // revenue documents only
  };
}

function parse(json) { try { const c = JSON.parse(json || ''); return c && typeof c === 'object' ? c : null; } catch { return null; } }
function summary(c) {
  if (!c) return '';
  return [TYPES[c.type], [c.address, c.subDistrict, c.district, c.province, c.postCode].filter(Boolean).join(' '), c.callCenterNumber, c.contactFirstName && `ผู้ติดต่อ ${c.contactFirstName} ${c.contactPhoneNumber || ''}`].filter(Boolean).join(' · ');
}

module.exports = { TYPES, PREFIX, clean, toPeak, parse, summary };
