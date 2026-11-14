// /api/requests
//   GET  → the signed-in user's quotation requests (Operation sees everyone's), newest first
//   POST → create a quotation request from catalog packages; writes Requests + RequestLines
//          to the Revenue Hub and, when PEAK_MODE is on, creates a Draft quotation in PEAK.

const crypto = require('crypto');
const { checkOrigin, sendError } = require('../lib/session');
const { requireUser, can, visibility } = require('../lib/users');
const { priceItem, priceCustomKeyHS, priceService, priceSurcharge, vatIncluded, vatSplit } = require('../lib/pricing');
const { validTaxId, normBranch } = require('../lib/taxid');
const hub = require('../lib/hub');
const peak = require('../lib/peak');
const qtdraft = require('../lib/qtdraft');
const { OPP_RE, normaliseOppId } = require('../lib/crm');

const SEGMENTS = ['B2B', 'B2C', 'MaoMao', 'B2S', 'B2E', 'Others'];
// The rules the old segments had (requests made before customer types came from PEAK, and tests).
const LEGACY_TYPE = (seg) => SEGMENTS.includes(seg) ? { name: seg, vat: vatIncluded(seg) ? 'incl' : 'excl', kinds: KINDS[seg], opp: !OPP_NONE.includes(seg), prefix: '' } : null;
// Withholding tax the customer deducts from the payment: 0 = none, otherwise percent (services to a company: usually 3%).
const WHT_RATES = ['0', '1', '2', '3', '5'];
const DEAL_TYPES = ['New Logo', 'Retention', 'Others'];
const LIMIT_PER_HOUR = 30;
// Which segments carry a CRM Opportunity ID: every segment except B2S (required), B2S never.
const OPP_REQUIRED = ['B2B', 'B2C', 'MaoMao', 'B2E', 'Others'];
const OPP_NONE = ['B2S'];
// Line kinds a segment may use. catalog = B2B Standard Catalog package, keyhs = customized
// B2B package with its own Key H.S., service = Whitehouse Package ID or PEAK service code.
const KINDS = { B2B: ['catalog', 'keyhs', 'surcharge'], B2C: ['service'], MaoMao: ['service'], B2E: ['service'], B2S: ['service'], Others: ['catalog', 'keyhs', 'service', 'surcharge'] };

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const text = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);

function newId(now = new Date()) {
  const t = new Date(now.getTime() + 7 * 3600e3);
  const p = (x) => String(x).padStart(2, '0');
  return `REQ-${String(t.getUTCFullYear()).slice(2)}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function validate(b, type) {
  if (!b || typeof b !== 'object') throw bad('ข้อมูลคำขอไม่ถูกต้อง');
  // Customer type = PEAK G012 (lib/types.js); older callers/tests pass the old segment rules.
  type = type || LEGACY_TYPE(text(b.segment, 20));
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
    whtRate: String(b.whtRate ?? '').trim(),
    customerEmail: text(b.customerEmail, 120),
    replaces: text(b.replaces, 40),
  };
  // Customer not in PEAK yet: its details, created in PEAK when accounting approves (lib/newcontact.js).
  const nc = !text(b.clientCode, 20) && b.newContact ? require('../lib/newcontact').clean(b.newContact) : null;
  r.newContact = nc ? JSON.stringify(nc) : '';
  if (!type) throw bad('เลือกประเภทลูกค้า');
  r.segment = type.name;
  if (!DEAL_TYPES.includes(r.dealType)) throw bad('เลือกประเภทดีล (New Logo / Retention / Others)');
  if (!type.opp) r.opportunityId = '';
  if (r.opportunityId && !OPP_RE.test(r.opportunityId)) throw bad('Opportunity ID ต้องเป็นรูปแบบ CRM-OPP-YYYY-NNNNN');
  if (type.opp && !r.opportunityId) throw bad(`ใส่ Opportunity ID จาก CRM (CRM-OPP-YYYY-NNNNN) สำหรับลูกค้า ${r.segment}`);
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.wantedQtDate)) throw bad('ใส่วันที่ต้องการให้ลงใน QT');
  if (r.creditTermDays === '') throw bad('ใส่เครดิตเทอม (วัน)');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.customerEmail)) throw bad('ใส่อีเมลลูกค้าสำหรับส่งเอกสาร');
  if (!WHT_RATES.includes(r.whtRate)) throw bad('เลือกหัก ณ ที่จ่าย (ไม่หัก / 1% / 2% / 3% / 5%)');
  if ((!Number.isFinite(r.creditTermDays) || r.creditTermDays < 0 || r.creditTermDays > 180)) throw bad('เครดิตเทอมต้องอยู่ระหว่าง 0 ถึง 180 วัน');
  const items = Array.isArray(b.items) ? b.items : [];
  if (items.length < 1) throw bad('ยังไม่มีแพ็กเกจในคำขอ');
  if (items.length > 20) throw bad('ใส่แพ็กเกจได้ไม่เกิน 20 รายการต่อคำขอ');
  for (const it of items) {
    const kind = (it && it.kind) || 'catalog';
    if (!type.kinds.includes(kind)) {
      throw bad(kind === 'service'
        ? `ลูกค้า ${r.segment} ใช้แพ็กเกจจาก Catalog หรือ Key H.S. เท่านั้น`
        : `ลูกค้า ${r.segment} ใช้ Package ID ของ Whitehouse หรือรหัสบริการใน PEAK`);
    }
  }
  return { r, items, type };
}

function toYmdDisplay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

async function create(req, res, user) {
  checkOrigin(req);
  if (!can(user, 'request')) throw bad('ไม่มีสิทธิ์ขอเอกสาร', 403);
  const type = await require('../lib/types').resolve(req.body && (req.body.customerType || req.body.segment));
  const { r, items } = validate(req.body, type);

  // Rate limit, counted from the sheet so it holds across serverless instances.
  const existing = await hub.readTable('Requests');
  // New request rebuilt from a rejected one: it takes that card's place in "my requests".
  if (r.replaces) {
    const old = existing.find((x) => x.requestId === r.replaces);
    if (!old || old.requestedBy !== user.email || old.status !== 'rejected') throw bad('คำขอเดิมที่จะแทนต้องเป็นของคุณและอยู่ในสถานะตีกลับ');
    if (existing.some((x) => x.replaces === r.replaces)) throw bad(`คำขอ ${r.replaces} ถูกสร้างใหม่ไปแล้ว`, 409);
  }
  const hourAgo = Date.now() - 3600e3;
  const recent = existing.filter((x) => x.requestedBy === user.email && (parseSheetDate(x.createdAt) || 0) > hourAgo).length;
  if (recent >= LIMIT_PER_HOUR) throw bad(`ส่งคำขอได้ไม่เกิน ${LIMIT_PER_HOUR} ครั้งต่อชั่วโมง`, 429);
  const dupCheck = req.body && req.body.confirmDuplicate !== true;

  // Whitehouse Package ID / PEAK service code must exist in PEAK; the name always comes from PEAK.
  // PEAK API on: every service code is checked in PEAK (name + text from PEAK). Types that pick from PEAK
  // groups (e.g. B2S: B2S services + Assessment) may only use services in those groups.
  if (items.some((it) => it.kind === 'service')) {
    if (peak.mode() === 'off') throw bad('ยังไม่ได้เปิดการเชื่อมต่อ PEAK API ตรวจรหัสบริการไม่ได้ แจ้งผู้ดูแลระบบ', 503);
    const allowed = type.svcGroups && type.svcGroups.length ? new Map((await peak.servicesForGroups(type.svcGroups)).flatMap((g) => g.services).map((x) => [String(x.code).toUpperCase(), x])) : null;
    for (const it of items.filter((x) => x.kind === 'service')) {
      const code = String(it.code || '').trim().toUpperCase();
      const s = allowed ? allowed.get(code) : await peak.getServiceByCode(code);
      if (!s) throw bad(allowed ? `ลูกค้า ${type.name} เลือกได้เฉพาะบริการในกลุ่ม ${type.svcGroups.map((g) => g.label).join(' / ')} (${code})` : `ไม่พบรหัส ${code || '(ว่าง)'} ใน PEAK ตรวจ Package ID อีกครั้ง`);
      Object.assign(it, { code, name: String(s.name || '').trim(), fromPeak: true });
      if (allowed) it.peakDesc = String(s.description || '').trim(); // WH packages keep the WH text (below)
    }
  }
  if (items.some((it) => it.kind === 'service' && it.peakDesc === undefined)) {
    // Customer-readable description from the Whitehouse package details (WHPackages tab, imported on /import-wh).
    let wh = new Map();
    try { wh = new Map((await hub.readTable('WHPackages')).map((x) => [String(x.id), x])); } catch (e) { console.error('WHPackages read failed', e); }
    for (const it of items.filter((x) => x.kind === 'service' && x.peakDesc === undefined)) it.wh = wh.get(it.code.replace(/_.*$/, '')) || null;
  }

  const priced = items.map((it) => {
    const kind = it.kind || 'catalog';
    const lang = r.docLang;
    if (kind === 'keyhs') return priceCustomKeyHS({ keyHS: it.keyHS, name: it.name, qty: it.qty, unitPrice: it.unitPrice, discount: it.discount, lang });
    if (kind === 'surcharge') return priceSurcharge({ type: it.type, note: it.note, qty: it.qty, unitPrice: it.unitPrice, discount: it.discount, lang });
    if (kind === 'service') return priceService({ code: it.code, name: it.name, qty: it.qty, unitPrice: it.unitPrice, discount: it.discount, wh: it.wh, peakDesc: it.peakDesc, lang });
    return priceItem({
      packageId: text(it.packageId, 60), students: it.students, classes: it.classes,
      unitPrice: it.unitPrice, discount: it.discount, intl: it.intl, loc: it.loc, lang, vatIncl: type.vat === 'incl',
    });
  });
  // Sales' extra description for a package goes on its first (priced) line. The PEAK sync (Claude)
  // blends it into the generated description before creating the QT (RequestLines L → M).
  priced.forEach((p, i) => {
    const note = text(items[i].extra, 500); if (note && p.lines[0]) p.lines[0].salesNote = note;
    // Freebies (ของแถม, e.g. FMC 3 ครั้ง) on the package line: the sync adds them to the QT description.
    const free = text(items[i].freebie, 300); if (free && p.lines[0]) p.lines[0].freebie = free;
  });
  const lines = priced.flatMap((p) => p.lines);
  // Line prices are in the segment's basis: before VAT (B2B / B2S) or VAT-inclusive (B2C / B2E / MaoMao / Others).
  const incl = type.vat === 'incl';
  const entered = Math.round(priced.reduce((s, p) => s + p.total, 0) * 100) / 100;
  const { preVat: total, inclVat: totalInclVat } = vatSplit(entered, incl);
  const catalogTotal = priced.reduce((s, p) => s + p.catalogTotal, 0);
  const belowFloor = priced.map((p) => p.belowFloor).filter(Boolean).join('; ');

  // Same customer + segment + total in the last 14 days (not rejected) → probably sent twice. Ask first.
  if (dupCheck) {
    const since = Date.now() - 14 * 86400e3;
    const same = existing.filter((x) => x.taxId === r.taxId && x.branch === r.branch && x.segment === r.segment
      && Math.abs((Number(String(x.totalPreVat).replace(/,/g, '')) || 0) - total) < 0.01
      && !['rejected', 'cancelled'].includes(x.status) && (parseSheetDate(x.createdAt) || 0) > since);
    if (same.length) {
      return res.status(409).json({ ok: false, duplicate: true,
        error: `มีคำขอ QT ของลูกค้านี้ ยอดเท่ากันอยู่แล้ว ${same.length} ใบ`,
        matches: same.slice(-5).map((x) => ({ id: x.requestId, createdAt: x.createdAt, by: x.salesName || x.requestedBy, status: x.status, qtNo: x.peakQtNo })) });
    }
  }

  // PEAK classification Sales picked on the form (G012 / G013 …), checked against PEAK's own items.
  const picks = { ...(await require('../lib/classrules').cleanPicks(req.body && req.body.classPicks, await hub.readTable('Users').catch(() => [])) || {}), ...(type.code ? { G012: type.code } : {}) };
  const now = new Date();
  const request = {
    requestId: newId(now), createdAt: hub.sheetDateTime(now), requestedBy: user.email, salesName: user.name,
    ...r, wantedQtDate: toYmdDisplay(r.wantedQtDate), status: 'new', peakQtNo: '', peakQtId: '',
    totalPreVat: total, qtApprovedAt: '', ivRequestedAt: '', updatedAt: hub.sheetDateTime(now),
    catalogTotal, belowFloor, vatMode: incl ? 'incl' : 'excl', totalInclVat, voidedQts: '',
    classPicks: Object.keys(picks).length ? JSON.stringify(picks) : '',
  };

  // The QT Draft is made when accounting approves the request (live via the PEAK API when
  // PEAK_MODE is on, otherwise by the scheduled sync), never straight from Sales' submit.
  const peakNote = 'ส่งคำขอแล้ว รอฝ่ายบัญชีตรวจ เมื่ออนุมัติ ระบบจะสร้าง QT Draft ใน PEAK แล้วเลข QT จะขึ้นในคำขอของฉัน';
  // WH packages and PEAK services carry their own code; catalog lines map through Products.
  // Own code (WH package / PEAK service) → per-package override in Products → per-component code
  // (Components tab). Always resolved, so RequestLines carry the code PEAK will use.
  const codes = await hub.readServiceCodes();
  const serviceCodeOf = (l) => l.peakCode || (l.role === 'hero' && codes.byKeyHS.get(l.keyHS)) || codes.byComponent.get(l.component) || '';

  await hub.appendRows('Requests', [request]);
  await hub.appendRows('RequestLines', lines.map((l, i) => ({
    requestId: request.requestId, line: i + 1, role: l.role, keyHS: l.keyHS, packageId: l.packageId,
    peakServiceCode: serviceCodeOf(l), description: l.description, qty: l.qty, unitPrice: l.unitPrice,
    discount: l.discount, listPrice: l.listPrice, salesNote: l.salesNote || '', qtDescription: '', freebie: l.freebie || '',
  })));
  await hub.log('catalog', 'request_created', request.requestId, `${user.email} · ${r.company} · ${total}${incl ? ` (incl. VAT ${totalInclVat})` : ''}${belowFloor ? ' · below catalog floor: ' + belowFloor : ''}`);

  res.status(200).json({ ok: true, requestId: request.requestId, status: request.status, peakQtNo: request.peakQtNo, total, totalInclVat, vatMode: request.vatMode, catalogTotal, belowFloor, lines: lines.length, message: peakNote });
}

function parseSheetDate(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}):(\d{2}))?/.exec(String(s || ''));
  if (!m) return null;
  return Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0)) - 7 * 3600e3;
}

async function list(req, res, user) {
  const [rows, lines, ivs] = await Promise.all([hub.readTable('Requests'), hub.readTable('RequestLines'), hub.readTable('InvoiceRequests')]);
  const invoiced = {}, invoicedIncl = {};
  const n = (x) => Number(String(x ?? '').replace(/,/g, '')) || 0;
  ivs.filter((v) => v.requestId && v.status !== 'rejected').forEach((v) => {
    invoiced[v.requestId] = (invoiced[v.requestId] || 0) + n(v.amountPreVat);
    invoicedIncl[v.requestId] = (invoicedIncl[v.requestId] || 0) + (n(v.amountInclVat) || Math.round(n(v.amountPreVat) * 107) / 100);
  });
  const sees = await visibility(user);
  const mine = rows
    .filter((r) => sees(r.requestedBy))
    .map((r) => ({ ...r, _createdMs: parseSheetDate(r.createdAt) }))
    .sort((a, b) => (b._createdMs || 0) - (a._createdMs || 0))
    // newest 50, plus every approved QT that still has a balance to invoice (e.g. QTs imported from PEAK)
    .filter((r, i) => i < 50 || (['qt_approved', 'accepted', 'iv_requested'].includes(r.status)
      && (Number(String(r.totalPreVat).replace(/,/g, '')) || 0) - (invoiced[r.requestId] || 0) > 0.01))
    .slice(0, 400);
  const ids = new Set(mine.map((r) => r.requestId));
  const byId = {};
  lines.filter((l) => ids.has(l.requestId)).forEach((l) => { (byId[l.requestId] = byId[l.requestId] || []).push(l); });
  res.status(200).json({
    ok: true, peakLive: peak.mode() !== 'off',
    requests: mine.map(({ _row, _createdMs, _invoicedPreVat, _remainingPreVat, ...r }) => ({ ...r,
      // AG empty (rows from before the VAT split): the segment decides.
      vatMode: r.vatMode || (vatIncluded(r.segment) ? 'incl' : 'excl'),
      newContact: r.newContact && !r.clientCode ? require('../lib/newcontact').summary(require('../lib/newcontact').parse(r.newContact)) : '',
      totalInclVat: n(r.totalInclVat) || Math.round(n(r.totalPreVat) * 107) / 100,
      invoicedInclVat: Math.round((invoicedIncl[r.requestId] || 0) * 100) / 100,
      invoicedPreVat: Math.round((invoiced[r.requestId] || 0) * 100) / 100, lines: (byId[r.requestId] || []).map(({ _row: _, ...l }) => l) })),
  });
}

// PATCH (Accountant / Admin only) { requestId, action, note? }
//   approve     → approved: accounting checked the request; the PEAK sync creates the Draft QT
//                 only for approved rows (status new = waiting for this approval)
//   reject      → rejected, with the reason shown to sales (required)
//   reopen      → approved again (re-run the sync after fixing a contact / service code)
//   qt_approved → the Draft was approved in PEAK
//   qt_voided   → accounting voided the QT in PEAK by mistake: back to approved with the QT
//                 number cleared, so the PEAK sync drafts a new QT from the same request and lines.
//                 The old number goes to voidedQts (AI) so it is never written back.
const OP_ACTIONS = { approve: 'approved', retry: 'approved', reject: 'rejected', reopen: 'approved', qt_approved: 'qt_approved', qt_voided: 'approved', qt_fixed: 'qt_draft' };
// GET ?view=qt-live&id=REQ-…  → the QT as PEAK has it now (lines, totals, status). Read-only.
async function qtLive(req, res, user) {
  if (peak.mode() === 'off') throw bad('ยังไม่ได้เปิดการเชื่อมต่อ PEAK API', 503);
  const id = text(req.query && req.query.id, 40);
  const row = (await hub.readTable('Requests')).find((x) => x.requestId === id);
  const sees = await visibility(user);
  if (!row || (!sees(row.requestedBy) && !can(user, 'approve'))) throw bad('ไม่พบคำขอนี้', 404);
  if (!row.peakQtId) throw bad('คำขอนี้ยังไม่มี QT ใน PEAK', 404);
  const raw = await peak.getQuotation(row.peakQtId);
  const q = peak.quotationView(raw);
  if (!q) throw bad('ไม่พบ QT นี้ใน PEAK', 404);
  // Edited in PEAK without the app knowing: bring the request (totals, lines) up to date now.
  const sigBefore = row.qtSig;
  await require('../lib/qtlines').refreshRequest(row, raw).catch(() => null);
  await require('../lib/peaksync').syncQuotationClasses(row, raw).catch(() => false);
  res.status(200).json({ ok: true, qt: q, editedAt: row.qtEditedAt || '', changed: !!sigBefore && row.qtSig !== sigBefore });
}

async function update(req, res, user) {
  checkOrigin(req);
  if (!can(user, 'approve')) throw bad('ไม่มีสิทธิ์อนุมัติเอกสาร', 403);
  const b = req.body || {};
  // Accounting pressed refresh in PEAK after an edit: the public PDF is current again.
  if (b.action === 'qt_refreshed') {
    const r = (await hub.readTable('Requests')).find((x) => x.requestId === text(b.requestId, 40));
    if (!r) throw bad('ไม่พบคำขอนี้', 404);
    if (!r.qtEditedAt) return res.status(200).json({ ok: true, status: r.status });
    await hub.updateRow('Requests', r._row, { qtEditedAt: '', updatedAt: hub.sheetDateTime() });
    await hub.log('catalog', 'qt_refreshed', r.requestId, user.email);
    return res.status(200).json({ ok: true, status: r.status });
  }
  const status = OP_ACTIONS[b.action];
  if (!status) throw bad('คำสั่งไม่ถูกต้อง');
  const note = text(b.note, 500);
  if (b.action === 'reject' && !note) throw bad('ใส่เหตุผลที่ตีกลับ');
  const rows = await hub.readTable('Requests');
  const row = rows.find((x) => x.requestId === text(b.requestId, 40));
  if (!row) throw bad('ไม่พบคำขอนี้', 404);
  const at = hub.sheetDateTime();
  const fields = { status, updatedAt: at };
  // Status guards: a second click, a stale page or two accountants at once must not move a request backwards.
  const FROM = {
    approve: ['new'],
    reject: ['new', 'approved', 'needs_contact', 'needs_service_code', 'needs_review', 'qt_error'],
    // needs_review = sales must change the request: accounting rejects it, sales rebuilds it.
    reopen: ['needs_contact', 'needs_service_code', 'qt_error'],
    // retry: approved but the Draft wasn't made (PEAK / Claude API busy): try again now instead of waiting for the sync.
    retry: ['approved'],
    qt_approved: ['qt_draft'],
    // qt_error: the sync found the Draft voided in PEAK ("QT ถูก void ใน PEAK").
    qt_voided: ['qt_draft', 'qt_approved', 'qt_error'],
    // qt_fixed: the sync flagged the Draft (e.g. account code differs from the service); accounting
    // fixed it in PEAK, so it goes back to qt_draft and the sync re-checks it on the next run.
    qt_fixed: ['qt_error'],
  };
  if (!FROM[b.action].includes(row.status)) {
    const done = { approve: 'คำขอนี้อนุมัติไปแล้วหรือไม่ได้รออนุมัติ', reject: 'ตีกลับไม่ได้: คำขอนี้ไม่ได้อยู่ในสถานะที่ตีกลับได้ (อาจสร้าง QT ใน PEAK แล้ว)', reopen: 'คำขอนี้ไม่ได้ติดปัญหาแล้ว', retry: 'คำขอนี้ไม่ได้รอสร้าง QT แล้ว', qt_approved: 'QT นี้ไม่ได้อยู่ในสถานะ Draft', qt_voided: 'คำขอนี้ไม่มี QT ใน PEAK ที่จะยกเลิก', qt_fixed: 'คำขอนี้ไม่ได้ติดปัญหาแล้ว' };
    throw bad(`${done[b.action]} (สถานะตอนนี้: ${row.status}) รีเฟรชหน้าเพื่อดูข้อมูลล่าสุด`, 409);
  }
  hub.checkSeen(row, text(b.seen, 80));
  if (b.action === 'qt_approved') fields.qtApprovedAt = at;
  const who = user.name || user.email;
  const live = peak.mode() !== 'off';
  // With the PEAK API on, check PEAK before trusting the click.
  if (live && b.action === 'qt_approved' && row.peakQtId) {
    const q = await peak.getQuotation(row.peakQtId).catch(() => null);
    if (q && (q.isVoid || /void/i.test(q.status || ''))) throw bad(`QT ${row.peakQtNo} ถูกยกเลิกใน PEAK แล้ว ถ้าเผลอยกเลิก ใช้ "เผลอยกเลิก QT นี้ใน PEAK?"`, 409);
    if (q && /draft/i.test(q.status || '')) throw bad(`QT ${row.peakQtNo} ใน PEAK ยังเป็น Draft อนุมัติใน PEAK ก่อน แล้วกดอีกครั้ง`, 409);
  }
  if (live && b.action === 'qt_fixed' && row.peakQtId) {
    const q = await peak.getQuotation(row.peakQtId);
    const acc = await qtdraft.accountProblems(q);
    if (acc) throw bad(`ใน PEAK ยังไม่ตรง: ${acc}`, 409);
    fields.peakNote = `Draft ${row.peakQtNo} รอฝ่ายบัญชีอนุมัติใน PEAK (ตรวจแล้ว) — ${who}`;
  }
  if (b.action === 'qt_fixed' && !row.peakQtId) throw bad('ยังไม่มี QT ใน PEAK ให้ตรวจใหม่ ใช้ "แก้แล้ว ให้ระบบสร้าง QT ใหม่"', 409);
  if (b.action === 'qt_voided') {
    if (!row.peakQtNo && !row.peakQtId) throw bad('คำขอนี้ยังไม่มีเลข QT ใน PEAK', 409);
    // A QT that already has INV requests can't just be redone: the INVs point at the old number.
    const ivs = (await hub.readTable('InvoiceRequests')).filter((v) => v.requestId === row.requestId && v.status !== 'rejected');
    if (ivs.length) throw bad(`QT นี้มีคำขอ INV แล้ว ${ivs.length} ใบ ใช้ "ขอแก้เอกสาร" แทน`, 409);
    const old = `${row.peakQtNo || '?'}|${row.peakQtId || ''}`;
    Object.assign(fields, {
      peakQtNo: '', peakQtId: '', peakDocLink: '', qtApprovedAt: '',
      voidedQts: [row.voidedQts, old].filter(Boolean).join('; '),
    });
  }
  const auto = { approve: `ฝ่ายบัญชีอนุมัติคำขอแล้ว รอระบบสร้าง QT Draft ใน PEAK — ${who}`, retry: `ลองสร้าง QT อีกครั้ง — ${who}`, reopen: `ให้ระบบสร้าง QT ใหม่ — ${who}`, qt_approved: `อนุมัติ QT ใน PEAK แล้ว — ${who}`, qt_fixed: `แก้ QT ${row.peakQtNo || ''} ใน PEAK แล้ว รอระบบตรวจใหม่รอบถัดไป — ${who}`, qt_voided: `QT ${row.peakQtNo || ''} ถูกยกเลิกใน PEAK ระบบจะสร้าง QT Draft ใหม่จากข้อมูลเดิม — ${who}` };
  if (!(live && b.action === 'qt_fixed')) fields.peakNote = b.action === 'qt_voided' ? `${auto.qt_voided}${note ? ` · ${note}` : ''}` : note ? `${note} — ${who}` : (auto[b.action] || row.peakNote);
  // Approved (or sent back to be re-created) and the PEAK API is on: make the Draft now.
  const makeNow = live && status === 'approved';
  if (makeNow) fields.status = 'qt_creating';
  await hub.writeChecked('Requests', 'requestId', row, fields);
  await hub.log('catalog', `qt_${b.action}`, row.requestId, `${user.email}${note ? ' · ' + note : ''}`);
  if (!makeNow) return res.status(200).json({ ok: true, status });

  const merged = { ...row, ...fields };
  let out;
  try {
    const [lines, users] = await Promise.all([hub.readTable('RequestLines'), hub.readTable('Users')]);
    const r = await qtdraft.createForRequest(merged, lines, users);
    out = r.defer
      ? { ...(r.fields || {}), status: 'approved', peakNote: [r.defer === 'notes' ? `${fields.peakNote} · มีโน้ตเซล / ของแถม ระบบจะเรียบเรียงคำอธิบายแล้วสร้าง QT รอบ 10:49 / 17:49` : `${fields.peakNote} · ${r.defer}`, ...(r.notes || [])].join(' · ') }
      : r.fields;
  } catch (e) {
    // PEAK down / busy: leave it approved so the scheduled sync retries. A PEAK validation error needs a person.
    out = qtdraft.transient(e)
      ? { status: 'approved', peakNote: `${fields.peakNote} · สร้างใน PEAK ทันทีไม่สำเร็จ (${String(e.message).slice(0, 120)}) ระบบจะลองอีกครั้งรอบ 10:49 / 17:49` }
      : { status: 'qt_error', peakNote: `สร้าง QT ใน PEAK ไม่สำเร็จ: ${String(e.message).slice(0, 300)}` };
  }
  out.updatedAt = hub.sheetDateTime();
  await hub.updateRow('Requests', row._row, out);
  await hub.log('peak', `qt_live_${out.status}`, row.requestId, out.peakQtNo || out.peakNote.slice(0, 200));
  res.status(200).json({ ok: true, status: out.status, peakQtNo: out.peakQtNo || '', message: out.peakNote });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const user = await requireUser(req);
    if (req.method === 'POST') return await create(req, res, user);
    if (req.method === 'GET' && req.query && req.query.view === 'qt-live') return await qtLive(req, res, user);
    if (req.method === 'GET' && req.query && req.query.view === 'classes') return res.status(200).json({ ok: true, types: await require('../lib/types').list(), groups: await require('../lib/classrules').formGroups(await hub.readTable('Users').catch(() => [])) });
    if (req.method === 'GET') return await list(req, res, user);
    if (req.method === 'PATCH') return await update(req, res, user);
    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    sendError(res, e);
  }
};

module.exports._test = { validate, newId, parseSheetDate, KINDS, WHT_RATES };
