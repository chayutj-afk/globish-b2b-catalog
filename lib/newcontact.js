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

// PEAK prints the legal form itself from the contact type ("บริษัท … จำกัด (มหาชน)" for type 3), so the
// name sent must be the bare name: "บริษัท ก จำกัด (มหาชน) สำนักงานใหญ่" → "ก". Sending the full name gave
// "บริษัท บริษัท… จำกัด (มหาชน) สำนักงานใหญ่ จำกัด (มหาชน)" on the document. The head-office / branch words go
// too (the branch is its own field). Only Thai legal forms of the types PEAK decorates are removed.
function bareName(name, type) {
  let n = text(name, 256).replace(/\s+/g, ' ');
  n = n.replace(/\s*\(?\s*(สำนักงานใหญ่|สนญ\.?)\s*\)?\s*$/u, '').replace(/\s*\(?\s*สาขา(ที่)?\s*[\d๐-๙]{1,5}\s*\)?\s*$/u, '').trim();
  const t = Number(type);
  if (t === 3) n = n.replace(/^(บริษัท|บมจ\.?)\s*/u, '').replace(/\s*(จำกัด\s*\(\s*มหาชน\s*\)|\(\s*มหาชน\s*\)\s*จำกัด|มหาชน\s*จำกัด|จำกัด\s*มหาชน)\s*$/u, '');
  else if (t === 2) n = n.replace(/^(บริษัท|บจก\.?)\s*/u, '').replace(/\s*จำกัด\s*$/u, '');
  else if (t === 1) n = n.replace(/^(ห้างหุ้นส่วนจำกัด|หจก\.?)\s*/u, '');
  else if (t === 8) n = n.replace(/^(ห้างหุ้นส่วนสามัญ|หสม\.?)\s*/u, '');
  n = n.trim();
  return n || text(name, 256);
}

// Stored details + the request → PEAK contact body.
function toPeak(c, row) {
  return {
    name: bareName(row.company, c.type), type: c.type, ...(c.prefixNameType ? { prefixNameType: c.prefixNameType } : {}),
    taxNumber: String(row.taxId || '').replace(/\D/g, ''), branchCode: row.branch || '00000',
    address: c.address, subDistrict: c.subDistrict, district: c.district, province: c.province, country: 'Thailand', postCode: c.postCode,
    callCenterNumber: c.callCenterNumber, email: row.customerEmail || undefined,
    contactFirstName: c.contactFirstName, contactPhoneNumber: c.contactPhoneNumber, contactEmail: row.customerEmail || undefined,
    contactFinanceType: 1, // revenue documents only
  };
}

// Contact code by customer type: B2C → C, B2B → CB, B2E → CE, then a 5-digit running number kept in the
// Settings tab ("Next contact no. C" …). A number PEAK already has (a contact made by hand there) is
// skipped. Other customer types, or a setting left empty, get the code PEAK generates.
const CODE_PREFIX = { B2C: 'C', B2B: 'CB', B2E: 'CE' };
const seqKey = (prefix) => `Next contact no. ${prefix}`;
async function createCoded(peak, hub, body, segment) {
  const prefix = CODE_PREFIX[segment];
  let n = prefix ? Number(await hub.getSetting(seqKey(prefix)).catch(() => '')) : 0;
  if (!prefix || !Number.isInteger(n) || n <= 0) return peak.createContact(body);
  for (let i = 0; i < 30; i++, n++) {
    const code = prefix + String(n).padStart(5, '0');
    try {
      const c = await peak.createContact({ ...body, code });
      await hub.setSetting(seqKey(prefix), n + 1).catch(() => {});
      return c;
    } catch (e) {
      if (!/ซ้ำ|duplicate|already|exist|in use|ถูกใช้|มีอยู่/i.test(String(e.message))) throw e;
    }
  }
  throw Object.assign(new Error(`หารหัสลูกค้า ${prefix} ที่ว่างไม่ได้ ตรวจค่า "${seqKey(prefix)}" ในแท็บ Settings`), { status: 409 });
}

function parse(json) { try { const c = JSON.parse(json || ''); return c && typeof c === 'object' ? c : null; } catch { return null; } }
function summary(c) {
  if (!c) return '';
  return [TYPES[c.type], [c.address, c.subDistrict, c.district, c.province, c.postCode].filter(Boolean).join(' '), c.callCenterNumber, c.contactFirstName && `ผู้ติดต่อ ${c.contactFirstName} ${c.contactPhoneNumber || ''}`].filter(Boolean).join(' · ');
}

module.exports = { TYPES, PREFIX, clean, toPeak, parse, summary, bareName, createCoded, CODE_PREFIX };
