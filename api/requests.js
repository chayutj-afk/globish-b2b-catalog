// /api/requests
//   GET  → the signed-in user's quotation requests (Operation sees everyone's), newest first
//   POST → create a quotation request from catalog packages; writes Requests + RequestLines
//          to the Revenue Hub and, when PEAK_MODE is on, creates a Draft quotation in PEAK.

const crypto = require('crypto');
const { checkOrigin, sendError } = require('../lib/session');
const { requireUser } = require('../lib/users');
const { priceItem, priceCustomKeyHS, priceService } = require('../lib/pricing');
const { validTaxId, normBranch } = require('../lib/taxid');
const hub = require('../lib/hub');
const peak = require('../lib/peak');
const { OPP_RE, normaliseOppId } = require('../lib/crm');
const { services } = require('./services');

const SEGMENTS = ['B2B', 'B2S', 'B2E', 'Others'];
const DEAL_TYPES = ['New Logo', 'Retention', 'Others'];
const LIMIT_PER_HOUR = 30;
// Which segments carry a CRM Opportunity ID: B2B and B2E always, B2S never.
const OPP_REQUIRED = ['B2B', 'B2E'];
const OPP_NONE = ['B2S'];
// Line kinds a segment may use. catalog = B2B Standard Catalog package, keyhs = customized
// B2B package with its own Key H.S., service = Whitehouse Package ID or PEAK service code.
const KINDS = { B2B: ['catalog', 'keyhs'], B2E: ['service'], B2S: ['service'], Others: ['catalog', 'keyhs', 'service'] };

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const text = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);

function newId(now = new Date()) {
  const t = new Date(now.getTime() + 7 * 3600e3);
  const p = (x) => String(x).padStart(2, '0');
  return `REQ-${String(t.getUTCFullYear()).slice(2)}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function validate(b) {
  if (!b || typeof b !== 'object') throw bad('ข้อมูลคำขอไม่ถูกต้อง');
  const r = {
    segment: text(b.segment, 20),
    dealType: text(b.dealType, 20),
    clientCode: text(b.clientCode, 20).toUpperCase(),
    company: text(b.company, 200),
    taxId: text(b.taxId, 20).replace(/[\s-]/g, ''),
    branch: text(b.branch, 60),
    docLang: text(b.docLang, 2).toUpperCase(),
    wantedQtDate: text(b.wantedQtDate, 10),
    creditTermDays: b.creditTermDays === '' || b.creditTermDays === undefined ? '' : Math.floor(Number(b.creditTermDays)),
    poRequired: b.poRequired === true || b.poRequired === 'yes' ? 'Yes' : 'No',
    note: text(b.note, 1000),
    opportunityId: normaliseOppId(b.opportunityId),
  };
  if (!SEGMENTS.includes(r.segment)) throw bad('เลือกกลุ่มลูกค้า (B2B / B2S / B2E / Others)');
  if (!DEAL_TYPES.includes(r.dealType)) throw bad('เลือกประเภทดีล (New Logo / Retention / Others)');
  if (OPP_NONE.includes(r.segment)) r.opportunityId = '';
  if (r.opportunityId && !OPP_RE.test(r.opportunityId)) throw bad('Opportunity ID ต้องเป็นรูปแบบ CRM-OPP-YYYY-NNNNN');
  if (OPP_REQUIRED.includes(r.segment) && !r.opportunityId) throw bad(`ใส่ Opportunity ID จาก CRM (CRM-OPP-YYYY-NNNNN) สำหรับลูกค้า ${r.segment}`);
  if (!r.company) throw bad('กรอกชื่อบริษัทหรือหน่วยงาน');
  // The 13-digit tax ID (+ branch) is the single source of truth for the customer in every segment.
  // Client code is only a hint; the PEAK sync matches on tax ID and flags a mismatch.
  if (!/^\d{13}$/.test(r.taxId)) throw bad('กรอกเลขประจำตัวผู้เสียภาษี 13 หลัก (บังคับทุกกลุ่มลูกค้า บุคคลธรรมดาใช้เลขบัตรประชาชน)');
  // Filled by the form from PEAK Contacts (codes vary: C01988, CB00458, CA00101, 274804 …).
  if (r.clientCode && !/^[A-Z0-9-]{1,20}$/.test(r.clientCode)) throw bad('รหัสลูกค้าใน PEAK ไม่ถูกต้อง');
  // Check digit is a warning only: flag it for accounting instead of blocking the request.
  if (r.taxId && !validTaxId(r.taxId)) r.note = `[ตรวจเลขภาษี: หลักสุดท้ายไม่ผ่าน] ${r.note}`.trim();
  const br = normBranch(r.branch);
  if (br === null) throw bad('สาขาต้องเป็นรหัส 5 หลัก เช่น 00000 (สำนักงานใหญ่) หรือ 00001');
  r.branch = br;
  if (!['TH', 'EN'].includes(r.docLang)) throw bad('เลือกภาษาเอกสาร (TH / EN)');
  if (r.wantedQtDate && !/^\d{4}-\d{2}-\d{2}$/.test(r.wantedQtDate)) throw bad('วันที่ใบเสนอราคาไม่ถูกต้อง');
  if (r.creditTermDays !== '' && (!Number.isFinite(r.creditTermDays) || r.creditTermDays < 0 || r.creditTermDays > 180)) throw bad('เครดิตเทอมต้องอยู่ระหว่าง 0 ถึง 180 วัน');
  const items = Array.isArray(b.items) ? b.items : [];
  if (items.length < 1) throw bad('ยังไม่มีแพ็กเกจในคำขอ');
  if (items.length > 20) throw bad('ใส่แพ็กเกจได้ไม่เกิน 20 รายการต่อคำขอ');
  for (const it of items) {
    const kind = (it && it.kind) || 'catalog';
    if (!KINDS[r.segment].includes(kind)) {
      throw bad(kind === 'service'
        ? `ลูกค้า ${r.segment} ใช้แพ็กเกจจาก Catalog หรือ Key H.S. เท่านั้น`
        : `ลูกค้า ${r.segment} ใช้ Package ID ของ Whitehouse หรือรหัสบริการใน PEAK`);
    }
  }
  return { r, items };
}

function toYmdDisplay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

async function create(req, res, user) {
  checkOrigin(req);
  const { r, items } = validate(req.body);

  // Rate limit, counted from the sheet so it holds across serverless instances.
  const existing = await hub.readTable('Requests');
  const hourAgo = Date.now() - 3600e3;
  const recent = existing.filter((x) => x.requestedBy === user.email && (parseSheetDate(x.createdAt) || 0) > hourAgo).length;
  if (recent >= LIMIT_PER_HOUR) throw bad(`ส่งคำขอได้ไม่เกิน ${LIMIT_PER_HOUR} ครั้งต่อชั่วโมง`, 429);

  // Whitehouse Package ID / PEAK service code must exist in PEAK; the name always comes from PEAK.
  if (items.some((it) => it.kind === 'service')) {
    const svc = await services();
    for (const it of items.filter((x) => x.kind === 'service')) {
      const code = String(it.code || '').trim().toUpperCase();
      const s = svc.get(code);
      if (!s) throw bad(`ไม่พบรหัส ${code || '(ว่าง)'} ใน PEAK ตรวจ Package ID อีกครั้ง (ถ้าเพิ่งสร้างใน PEAK แจ้งฝ่ายบัญชี)`);
      it.code = code;
      it.name = s.name;
    }
  }

  const priced = items.map((it) => {
    const kind = it.kind || 'catalog';
    if (kind === 'keyhs') return priceCustomKeyHS({ keyHS: it.keyHS, name: it.name, qty: it.qty, unitPrice: it.unitPrice, discount: it.discount });
    if (kind === 'service') return priceService({ code: it.code, name: it.name, qty: it.qty, unitPrice: it.unitPrice, discount: it.discount });
    return priceItem({
      packageId: text(it.packageId, 60), students: it.students, classes: it.classes,
      unitPrice: it.unitPrice, discount: it.discount, intl: it.intl, loc: it.loc,
    });
  });
  const lines = priced.flatMap((p) => p.lines);
  const total = Math.round(priced.reduce((s, p) => s + p.total, 0) * 100) / 100;
  const catalogTotal = priced.reduce((s, p) => s + p.catalogTotal, 0);
  const belowFloor = priced.map((p) => p.belowFloor).filter(Boolean).join('; ');

  const now = new Date();
  const request = {
    requestId: newId(now), createdAt: hub.sheetDateTime(now), requestedBy: user.email, salesName: user.name,
    ...r, wantedQtDate: toYmdDisplay(r.wantedQtDate), status: 'new', peakQtNo: '', peakQtId: '',
    totalPreVat: total, qtApprovedAt: '', ivRequestedAt: '', updatedAt: hub.sheetDateTime(now),
    catalogTotal, belowFloor,
  };

  // PEAK Draft quotation (only when PEAK_MODE is uat/prod and every line has a service code).
  let peakNote = 'ระบบจะสร้าง QT Draft ใน PEAK ให้ฝ่ายบัญชีตรวจและอนุมัติ แล้วเลข QT จะขึ้นในคำขอของฉัน';
  // WH packages and PEAK services carry their own code; catalog lines map through Products.
  let serviceCodeOf = (l) => l.peakCode || '';
  if (peak.mode() !== 'off') {
    const codes = await hub.readServiceCodes();
    // Own code (WH package / PEAK service) → per-package override in Products → per-component code.
    serviceCodeOf = (l) => l.peakCode || (l.role === 'hero' && codes.byKeyHS.get(l.keyHS)) || codes.byComponent.get(l.component) || '';
    const { missing, body } = peak.buildQuotation({ ...request, wantedQtDate: r.wantedQtDate }, lines, serviceCodeOf, now);
    if (missing.length) {
      peakNote = `ยังสร้างใน PEAK ไม่ได้: ยังไม่มีรหัสบริการ PEAK ของ ${missing.join(', ')}`;
      await hub.log('catalog', 'peak_unmapped', request.requestId, missing.join(', '));
    } else {
      try {
        const q = await peak.createQuotationDraft(body);
        request.status = 'qt_draft';
        request.peakQtNo = q.code || '';
        request.peakQtId = q.id || '';
        peakNote = `สร้างใบเสนอราคา Draft ใน PEAK แล้ว${q.code ? ` (${q.code})` : ''}`;
        await hub.log('peak', 'qt_draft_created', request.requestId, q.code || q.id || '');
      } catch (e) {
        peakNote = 'สร้างใน PEAK ไม่สำเร็จ ฝ่ายบัญชีจะออกเอกสารให้';
        await hub.log('peak', 'qt_draft_failed', request.requestId, e.message);
      }
    }
  }

  await hub.appendRows('Requests', [request]);
  await hub.appendRows('RequestLines', lines.map((l, i) => ({
    requestId: request.requestId, line: i + 1, role: l.role, keyHS: l.keyHS, packageId: l.packageId,
    peakServiceCode: serviceCodeOf(l), description: l.description, qty: l.qty, unitPrice: l.unitPrice,
    discount: l.discount, listPrice: l.listPrice,
  })));
  await hub.log('catalog', 'request_created', request.requestId, `${user.email} · ${r.company} · ${total}${belowFloor ? ' · below catalog floor: ' + belowFloor : ''}`);

  res.status(200).json({ ok: true, requestId: request.requestId, status: request.status, peakQtNo: request.peakQtNo, total, catalogTotal, belowFloor, lines: lines.length, message: peakNote });
}

function parseSheetDate(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}):(\d{2}))?/.exec(String(s || ''));
  if (!m) return null;
  return Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0)) - 7 * 3600e3;
}

async function list(req, res, user) {
  const [rows, lines, ivs] = await Promise.all([hub.readTable('Requests'), hub.readTable('RequestLines'), hub.readTable('InvoiceRequests')]);
  const invoiced = {};
  ivs.filter((v) => v.requestId && v.status !== 'rejected').forEach((v) => { invoiced[v.requestId] = (invoiced[v.requestId] || 0) + (Number(String(v.amountPreVat).replace(/,/g, '')) || 0); });
  const mine = rows
    .filter((r) => user.role === 'op' || r.requestedBy === user.email)
    .map((r) => ({ ...r, _createdMs: parseSheetDate(r.createdAt) }))
    .sort((a, b) => (b._createdMs || 0) - (a._createdMs || 0))
    .slice(0, 50);
  const ids = new Set(mine.map((r) => r.requestId));
  const byId = {};
  lines.filter((l) => ids.has(l.requestId)).forEach((l) => { (byId[l.requestId] = byId[l.requestId] || []).push(l); });
  res.status(200).json({
    ok: true,
    requests: mine.map(({ _row, _createdMs, _invoicedPreVat, _remainingPreVat, ...r }) => ({ ...r, invoicedPreVat: Math.round((invoiced[r.requestId] || 0) * 100) / 100, lines: (byId[r.requestId] || []).map(({ _row: _, ...l }) => l) })),
  });
}

// PATCH (Operation only) { requestId, action, note? }
//   reject  → status rejected, note shown to sales (required)
//   approved → status qt_approved (QT approved in PEAK)
//   reopen  → status new (send it back to the sync)
const OP_ACTIONS = { reject: 'rejected', approved: 'qt_approved', reopen: 'new' };
async function update(req, res, user) {
  checkOrigin(req);
  if (user.role !== 'op') throw bad('เฉพาะฝ่ายบัญชี / Admin', 403);
  const b = req.body || {};
  const status = OP_ACTIONS[b.action];
  if (!status) throw bad('คำสั่งไม่ถูกต้อง');
  const note = text(b.note, 500);
  if (b.action === 'reject' && !note) throw bad('ใส่เหตุผลที่ตีกลับ');
  const rows = await hub.readTable('Requests');
  const row = rows.find((x) => x.requestId === text(b.requestId, 40));
  if (!row) throw bad('ไม่พบคำขอนี้', 404);
  const at = hub.sheetDateTime();
  const fields = { status, updatedAt: at };
  if (b.action === 'approved') fields.qtApprovedAt = at;
  fields.peakNote = note ? `${note} — ${user.name || user.email}` : (b.action === 'approved' ? `อนุมัติ QT ใน PEAK แล้ว — ${user.name || user.email}` : row.peakNote);
  await hub.updateRow('Requests', row._row, fields);
  await hub.log('catalog', `qt_${b.action}`, row.requestId, `${user.email}${note ? ' · ' + note : ''}`);
  res.status(200).json({ ok: true, status });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const user = await requireUser(req);
    if (req.method === 'POST') return await create(req, res, user);
    if (req.method === 'GET') return await list(req, res, user);
    if (req.method === 'PATCH') return await update(req, res, user);
    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    sendError(res, e);
  }
};

module.exports._test = { validate, newId, parseSheetDate, KINDS };
