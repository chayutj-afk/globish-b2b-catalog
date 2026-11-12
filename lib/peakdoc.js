// Checks on PEAK document numbers and links that accounting types into the app.
// Without a PEAK API the app can't confirm a document exists (the scheduled cross-check does that later),
// but it can stop the common slips: pasting the link of another document type, a number of the wrong type,
// or a number / link already used for a different document.

const KIND_NAME = { QT: 'ใบเสนอราคา (QT)', INV: 'ใบแจ้งหนี้ (INV)', RT: 'ใบเสร็จ (RT)' };

// Document type a PEAK link points to, or '' when the link doesn't say.
// doc.peakaccount.com/quotation?… /invoice?… /receipt?…  or  doc.peakaccount.com/?…&etti=MQ== (1 = QT, 2 = INV)
// secure.peakaccount.com/income/quotationEdit?… etc.
function linkKind(link) {
  let u;
  try { u = new URL(String(link || '')); } catch (e) { return ''; }
  const p = u.pathname.toLowerCase();
  if (p.includes('receipt')) return 'RT';
  if (p.includes('invoice')) return 'INV';
  if (p.includes('quotation')) return 'QT';
  const t = u.searchParams.get('etti');
  if (t) {
    let v = '';
    try { v = Buffer.from(t, 'base64').toString('utf8'); } catch (e) { /* ignore */ }
    if (v === '1') return 'QT';
    if (v === '2') return 'INV';
  }
  return '';
}

// Document type a number's prefix says, or '' when unknown.
function numberKind(no) {
  const s = String(no || '').toUpperCase();
  if (/^(QO|QT)/.test(s)) return 'QT';
  if (/^(IV|INV)/.test(s)) return 'INV';
  if (/^(RT|RE|RC)/.test(s)) return 'RT';
  return '';
}

// Same document whatever the link format: PEAK's document id (eti) inside the link.
function linkKey(link) {
  try { const u = new URL(String(link || '')); const e = u.searchParams.get('eti') || u.searchParams.get('eii'); return e ? decodeURIComponent(e).replace(/=+$/, '') : ''; } catch (e) { return ''; }
}

const isPeakLink = (link) => /^https:\/\/(doc|secure)\.peakaccount\.com\//.test(String(link || ''));

// → error message or ''.  want = 'QT' | 'INV' | 'RT'
function checkDoc(want, no, link) {
  if (no) {
    const k = numberKind(no);
    if (k && k !== want) return `เลข ${no} เป็นเลข${KIND_NAME[k]} ไม่ใช่${KIND_NAME[want]} ตรวจอีกครั้ง`;
  }
  if (link) {
    if (!isPeakLink(link)) return 'ลิงก์ต้องเป็นลิงก์เอกสารจาก PEAK (https://doc.peakaccount.com/… หรือ https://secure.peakaccount.com/…)';
    const k = linkKind(link);
    if (k && k !== want) return `ลิงก์ที่ใส่เป็นลิงก์${KIND_NAME[k]} ไม่ใช่${KIND_NAME[want]} ให้คัดลอกลิงก์จากเอกสาร${KIND_NAME[want]}ใน PEAK`;
  }
  return '';
}

// Finds another record already using this number or link. used = [{ no, link, ref, label, taxId }]
// sameCustomerOk: a receipt may cover several INVs of the same customer, so reuse is fine there.
function findReuse(used, { no, link, ref, taxId, sameCustomerOk = false }) {
  const n = String(no || '').toUpperCase(), key = linkKey(link);
  const digits = (v) => String(v || '').replace(/\D/g, '');
  for (const u of used) {
    if (!u || (ref && u.ref === ref)) continue;
    if (sameCustomerOk && taxId && digits(u.taxId) === digits(taxId)) continue;
    if (n && String(u.no || '').toUpperCase() === n) return `เลข ${n} ถูกใช้กับ ${u.label} แล้ว`;
    if (key && linkKey(u.link) === key) return `ลิงก์นี้ถูกใช้กับ ${u.label} แล้ว (เอกสารคนละใบต้องมีลิงก์คนละอัน)`;
  }
  return '';
}

module.exports = { linkKind, numberKind, linkKey, checkDoc, findReuse, isPeakLink, KIND_NAME };
