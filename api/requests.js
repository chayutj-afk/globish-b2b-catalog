// /api/requests
//   GET  → the signed-in user's quotation requests (Operation sees everyone's), newest first
//   POST → create a quotation request from catalog packages; writes Requests + RequestLines
//          to the Revenue Hub and, when PEAK_MODE is on, creates a Draft quotation in PEAK.

const crypto = require('crypto');
const { requireUser, checkOrigin, sendError } = require('../lib/session');
const { priceItem } = require('../lib/pricing');
const hub = require('../lib/hub');
const peak = require('../lib/peak');

const SEGMENTS = ['B2B', 'B2S', 'B2E', 'Others'];
const DEAL_TYPES = ['New Logo', 'Retention', 'Others'];
const LIMIT_PER_HOUR = 30;

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
    clientCode: text(b.clientCode, 20),
    company: text(b.company, 200),
    taxId: text(b.taxId, 20).replace(/[\s-]/g, ''),
    branch: text(b.branch, 60),
    docLang: text(b.docLang, 2).toUpperCase(),
    wantedQtDate: text(b.wantedQtDate, 10),
    creditTermDays: b.creditTermDays === '' || b.creditTermDays === undefined ? '' : Math.floor(Number(b.creditTermDays)),
    poRequired: b.poRequired === true || b.poRequired === 'yes' ? 'Yes' : 'No',
    note: text(b.note, 1000),
  };
  if (!SEGMENTS.includes(r.segment)) throw bad('เลือกกลุ่มลูกค้า (B2B / B2S / B2E / Others)');
  if (!DEAL_TYPES.includes(r.dealType)) throw bad('เลือกประเภทดีล (New Logo / Retention / Others)');
  if (!r.company) throw bad('กรอกชื่อบริษัทหรือหน่วยงาน');
  if (!r.clientCode && !/^\d{13}$/.test(r.taxId)) throw bad('เลขประจำตัวผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก (หรือใส่รหัสลูกค้าใน PEAK)');
  if (r.taxId && !/^\d{13}$/.test(r.taxId)) throw bad('เลขประจำตัวผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก');
  if (!['TH', 'EN'].includes(r.docLang)) throw bad('เลือกภาษาเอกสาร (TH / EN)');
  if (r.wantedQtDate && !/^\d{4}-\d{2}-\d{2}$/.test(r.wantedQtDate)) throw bad('วันที่ใบเสนอราคาไม่ถูกต้อง');
  if (r.creditTermDays !== '' && (!Number.isFinite(r.creditTermDays) || r.creditTermDays < 0 || r.creditTermDays > 180)) throw bad('เครดิตเทอมต้องอยู่ระหว่าง 0 ถึง 180 วัน');
  const items = Array.isArray(b.items) ? b.items : [];
  if (items.length < 1) throw bad('ยังไม่มีแพ็กเกจในคำขอ');
  if (items.length > 20) throw bad('ใส่แพ็กเกจได้ไม่เกิน 20 รายการต่อคำขอ');
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

  const priced = items.map((it) => priceItem({
    packageId: text(it.packageId, 60), students: it.students, classes: it.classes,
    unitPrice: it.unitPrice, intl: it.intl, loc: it.loc,
  }));
  const lines = priced.flatMap((p) => p.lines);
  const total = priced.reduce((s, p) => s + p.total, 0);

  const now = new Date();
  const request = {
    requestId: newId(now), createdAt: hub.sheetDateTime(now), requestedBy: user.email, salesName: user.name,
    ...r, wantedQtDate: toYmdDisplay(r.wantedQtDate), status: 'new', peakQtNo: '', peakQtId: '',
    totalPreVat: total, qtApprovedAt: '', ivRequestedAt: '', updatedAt: hub.sheetDateTime(now),
  };

  // PEAK Draft quotation (only when PEAK_MODE is uat/prod and every line has a service code).
  let peakNote = 'PEAK ยังไม่เปิดใช้ คำขอรอฝ่ายบัญชีออกใบเสนอราคา';
  let serviceCodeOf = () => '';
  if (peak.mode() !== 'off') {
    const codes = await hub.readServiceCodes();
    serviceCodeOf = (l) => (l.role === 'supplement' ? codes.byComponent.get(l.component) : l.role === 'hero' ? codes.byKeyHS.get(l.keyHS) : codes.byComponent.get('Surcharge')) || '';
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
  })));
  await hub.log('catalog', 'request_created', request.requestId, `${user.email} · ${r.company} · ${total}`);

  res.status(200).json({ ok: true, requestId: request.requestId, status: request.status, peakQtNo: request.peakQtNo, total, lines: lines.length, message: peakNote });
}

function parseSheetDate(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}):(\d{2}))?/.exec(String(s || ''));
  if (!m) return null;
  return Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0)) - 7 * 3600e3;
}

async function list(req, res, user) {
  const [rows, lines] = await Promise.all([hub.readTable('Requests'), hub.readTable('RequestLines')]);
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
    requests: mine.map(({ _row, _createdMs, ...r }) => ({ ...r, lines: (byId[r.requestId] || []).map(({ _row: _, ...l }) => l) })),
  });
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

module.exports._test = { validate, newId, parseSheetDate };
