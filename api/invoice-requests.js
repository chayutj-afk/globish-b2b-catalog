// /api/invoice-requests
//   GET  → the signed-in user's invoice requests (Operation sees everyone's), newest first
//   POST → ask accounting to issue an invoice. Needs evidence that the customer accepted
//          the quotation: a signed QT, or an equivalent (PO, confirmation email, other),
//          uploaded as a file or given as a link.

const crypto = require('crypto');
const { requireUser, checkOrigin, sendError } = require('../lib/session');
const hub = require('../lib/hub');
const drive = require('../lib/drive');

const EVIDENCE = ['QT ที่ลูกค้าเซ็นแล้ว', 'PO จากลูกค้า', 'อีเมลยืนยันจากลูกค้า', 'อื่นๆ'];
const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const text = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
const dmy = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };

function newId(now = new Date()) {
  const t = new Date(now.getTime() + 7 * 3600e3);
  const p = (x) => String(x).padStart(2, '0');
  return `INVREQ-${String(t.getUTCFullYear()).slice(2)}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function validate(b) {
  if (!b || typeof b !== 'object') throw bad('ข้อมูลคำขอไม่ถูกต้อง');
  const r = {
    requestId: text(b.requestId, 40),
    qtNo: text(b.qtNo, 40),
    company: text(b.company, 200),
    taxId: text(b.taxId, 20).replace(/[\s-]/g, ''),
    evidenceType: text(b.evidenceType, 40),
    evidenceOther: text(b.evidenceOther, 120),
    evidenceLink: text(b.evidenceLink, 500),
    wantedIssueDate: text(b.wantedIssueDate, 10),
    billing: b.billing === 'installment' ? 'Installment' : 'Full',
    installment: text(b.installment, 20),
    amountPreVat: b.amountPreVat === '' || b.amountPreVat === undefined ? '' : Number(b.amountPreVat),
    students: b.students === '' || b.students === undefined ? '' : Math.floor(Number(b.students)),
    creditTermDays: b.creditTermDays === '' || b.creditTermDays === undefined ? '' : Math.floor(Number(b.creditTermDays)),
    poNo: text(b.poNo, 60),
    financeContact: text(b.financeContact, 120),
    financeEmail: text(b.financeEmail, 120),
    financePhone: text(b.financePhone, 40),
    deliveryAddress: text(b.deliveryAddress, 500) || 'ตามที่อยู่บริษัท',
    note: text(b.note, 1000),
  };
  if (!r.qtNo) throw bad('ใส่เลขที่ใบเสนอราคา (QT) ที่ต้องการออก INV');
  if (!r.company) throw bad('ใส่ชื่อบริษัท');
  if (r.taxId && !/^\d{13}$/.test(r.taxId)) throw bad('เลขประจำตัวผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก');
  if (!EVIDENCE.includes(r.evidenceType)) throw bad('เลือกประเภทหลักฐานที่ลูกค้ายอมรับ');
  if (r.evidenceType === 'อื่นๆ' && !r.evidenceOther) throw bad('ระบุว่าหลักฐานเป็นเอกสารอะไร');
  if (!b.file && !r.evidenceLink) throw bad('แนบไฟล์หลักฐาน หรือใส่ลิงก์ไฟล์ (Google Drive)');
  if (r.evidenceLink && !/^https:\/\/(drive|docs)\.google\.com\//.test(r.evidenceLink)) throw bad('ลิงก์หลักฐานต้องเป็นลิงก์ Google Drive หรือ Google Docs');
  if (r.wantedIssueDate && !/^\d{4}-\d{2}-\d{2}$/.test(r.wantedIssueDate)) throw bad('วันที่ออก INV ไม่ถูกต้อง');
  if (r.billing === 'Installment') {
    if (!r.installment) throw bad('ระบุงวด เช่น 1/2 หรือ 30%');
    if (!(r.amountPreVat > 0)) throw bad('ระบุยอดก่อน VAT ของงวดนี้');
  }
  if (r.amountPreVat !== '' && !(r.amountPreVat >= 0 && r.amountPreVat < 1e9)) throw bad('ยอดก่อน VAT ไม่ถูกต้อง');
  if (r.students !== '' && !(r.students >= 1 && r.students <= 5000)) throw bad('จำนวนผู้เรียนไม่ถูกต้อง');
  if (r.creditTermDays !== '' && !(r.creditTermDays >= 0 && r.creditTermDays <= 180)) throw bad('เครดิตเทอมต้องอยู่ระหว่าง 0 ถึง 180 วัน');
  if (r.financeEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.financeEmail)) throw bad('อีเมลฝ่ายการเงินไม่ถูกต้อง');
  return r;
}

async function create(req, res, user) {
  checkOrigin(req);
  const b = req.body || {};
  const r = validate(b);

  // A linked catalog request must be one this user may see.
  let linked = null;
  if (r.requestId) {
    const rows = await hub.readTable('Requests');
    linked = rows.find((x) => x.requestId === r.requestId);
    if (!linked || (user.role !== 'op' && linked.requestedBy !== user.email)) throw bad('ไม่พบคำขอใบเสนอราคาที่เลือก');
  }

  const now = new Date();
  const ivRequestId = newId(now);
  let evidenceLink = r.evidenceLink;
  if (b.file) {
    if (!drive.enabled()) throw bad('ยังอัปโหลดไฟล์ไม่ได้ ใส่ลิงก์ Google Drive ของไฟล์แทน');
    evidenceLink = await drive.upload(b.file, `${ivRequestId} ${r.qtNo} ${r.company}`.slice(0, 120));
  }

  const row = {
    ivRequestId, createdAt: hub.sheetDateTime(now), requestedBy: user.email, salesName: user.name,
    requestId: r.requestId, qtNo: r.qtNo, company: r.company, taxId: r.taxId,
    evidenceType: r.evidenceType === 'อื่นๆ' ? `อื่นๆ: ${r.evidenceOther}` : r.evidenceType, evidenceLink,
    wantedIssueDate: dmy(r.wantedIssueDate), billing: r.billing, installment: r.billing === 'Installment' ? r.installment : '',
    amountPreVat: r.amountPreVat, students: r.students, creditTermDays: r.creditTermDays, poNo: r.poNo,
    financeContact: r.financeContact, financeEmail: r.financeEmail, financePhone: r.financePhone,
    deliveryAddress: r.deliveryAddress, note: r.note, status: 'new', peakIvNo: '', updatedAt: hub.sheetDateTime(now),
  };
  await hub.appendRows('InvoiceRequests', [row]);
  if (linked) {
    await hub.updateRow('Requests', linked._row, {
      status: 'iv_requested', ivRequestedAt: row.createdAt, updatedAt: row.createdAt,
      peakQtNo: linked.peakQtNo || r.qtNo,
    });
  }
  await hub.log('catalog', 'invoice_requested', ivRequestId, `${user.email} · ${r.qtNo} · ${r.company}`);
  res.status(200).json({ ok: true, ivRequestId, evidenceLink, message: 'ส่งคำขอออก INV แล้ว ฝ่ายบัญชีจะตรวจหลักฐานและออกเอกสารใน PEAK' });
}

async function list(req, res, user) {
  const rows = await hub.readTable('InvoiceRequests');
  const out = rows
    .filter((r) => user.role === 'op' || r.requestedBy === user.email)
    .reverse()
    .slice(0, 50)
    .map(({ _row, ...r }) => r);
  res.status(200).json({ ok: true, uploads: drive.enabled(), requests: out });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const user = requireUser(req);
    if (req.method === 'POST') return await create(req, res, user);
    if (req.method === 'GET') return await list(req, res, user);
    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    sendError(res, e);
  }
};

module.exports._test = { validate };
