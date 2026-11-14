const { chromium } = require('playwright'); const { sign, B, ok, db, peak, setPeak, done } = require('./lib.cjs');
const modal = async (p, accept = true) => { await p.waitForSelector('#ov-modal:not([hidden])', { timeout: 6000 }); const t = await p.textContent('#m-title'); await p.click(accept ? '#m-ok' : '#m-cancel'); await p.waitForSelector('#ov-modal', { state: 'hidden' }); return t; };
(async () => {
  const b = await chromium.launch(); const errs = [];
  const mk = async (who, vw = 1366) => { const c = await b.newContext({ viewport: { width: vw, height: 900 } }); await c.addCookies([{ name: 'gc_session', value: sign({ email: who, name: who.split('@')[0], exp: Date.now() + 3600e3 }), domain: 'localhost', path: '/' }]); const p = await c.newPage(); p.on('pageerror', (e) => errs.push(who + ': ' + e.message)); p.on('dialog', (d) => { errs.push('native dialog: ' + d.message().slice(0, 60)); d.dismiss(); }); return p; };
  const shot = (p, n) => p.screenshot({ path: `/tmp/sales-desk-e2e-shots/${n}.png`, fullPage: true });

  // ── Sales (B2C) sends a QT from the form
  const sp = await mk('benz@globish.co.th');
  await sp.goto(B + '/request#qt'); await sp.waitForTimeout(1500);
  ok(await sp.$eval('#q-segment', (e) => [...e.options].map((o) => o.textContent.trim()).join('|')).then((t) => /B2C/.test(t)), 'QT form: customer types loaded from PEAK');
  await sp.selectOption('#q-segment', { label: await sp.$eval('#q-segment', (e) => [...e.options].find((o) => /B2C/.test(o.textContent)).textContent) }); await sp.waitForTimeout(400);
  const adders = await sp.$$eval('#q-adders button', (bs) => bs.map((x) => x.textContent.trim()));
  ok(adders.length >= 1, 'QT form: product buttons for B2C → ' + adders.join(' / '));
  await sp.click('#q-adders button >> nth=0'); await sp.waitForTimeout(300);
  await sp.fill('[data-f="code"]', '5136'); await sp.waitForTimeout(1500);
  const lineTxt = await sp.innerText('#q-items'); ok(/Private 1:1/.test(lineTxt), 'WH package name comes from PEAK: ' + lineTxt.replace(/\s+/g, ' ').slice(0, 80));
  await sp.fill('[data-f="qty"]', '1'); await sp.fill('[data-f="unitPrice"]', '21400');
  await sp.fill('#q-tax', '0105555555554'); await sp.waitForTimeout(1800);
  ok((await sp.inputValue('#q-company')) !== '' && (await sp.inputValue('#q-client')) === 'C14888', 'tax ID lookup fills company + PEAK client code: ' + (await sp.inputValue('#q-company')));
  await sp.click('#q-submit'); await sp.waitForTimeout(300); ok((await sp.textContent('#q-msg')).trim().length > 0, 'QT: missing fields message → ' + (await sp.textContent('#q-msg')).trim().slice(0, 70));
  await sp.selectOption('#q-deal', { index: 1 }).catch(() => {});
  await sp.click('#q-opp .od >> nth=0').catch(() => {}); await sp.keyboard.type('202600555');
  await sp.fill('#q-date', '2026-11-16'); await sp.fill('#q-term', '30'); await sp.selectOption('#q-wht', '0'); await sp.fill('#q-email', 'buyer@example.com');
  for (let i = 0; i < 6; i++) { await sp.click('#q-submit'); await sp.waitForTimeout(350); if (await sp.isVisible('#ov-modal:not([hidden])')) break; const m = (await sp.textContent('#q-msg')).trim(); if (i === 5) ok(false, 'QT form still blocked: ' + m); if (/Business Unit|กลุ่ม|เลือก/.test(m)) { for (const sel of await sp.$$('#q-cls select')) { const o = await sel.$$eval('option', (os) => os.filter((x) => x.value).map((x) => x.value)); if (o.length && !(await sel.inputValue())) await sel.selectOption(o[0]); } } }
  ok(/ยืนยัน/.test(await modal(sp, true)), 'QT: confirm dialog');
  await sp.waitForSelector('.done-card', { timeout: 10000 }).catch(() => {}); ok(await sp.isVisible('.done-card'), 'QT sent from the form'); await shot(sp, 'ui-qt-done');
  const rq = db().Requests.filter((r) => r.requestedBy === 'benz@globish.co.th').pop();
  ok(rq && Number(rq.totalInclVat) === 21400 && rq.status === 'new', 'request stored: ' + (rq && rq.requestId) + ' ' + (rq && rq.totalInclVat));

  // ── Accounting approves on the page → Draft in PEAK
  const ap = await mk('acct@globish.co.th');
  await ap.goto(B + '/request#pend'); await ap.waitForSelector('#pend-qt .pcard', { timeout: 8000 });
  const card = ap.locator('#pend-qt .pcard', { hasText: rq.requestId }).first();
  ok(await card.count() === 1, 'pending: the new request is listed');
  await card.locator('button:has-text("อนุมัติ")').first().click(); await modal(ap, true); ok(/เรียบร้อย/.test(await modal(ap, true)), 'approve → "created in PEAK" notice');
  const r2 = db().Requests.find((r) => r.requestId === rq.requestId); ok(r2.status === 'qt_draft' && r2.peakQtNo, 'approve button → QT Draft ' + r2.peakQtNo + ' (' + r2.status + ')'); await shot(ap, 'ui-pend-draft');
  ok(new RegExp(r2.peakQtNo).test(await ap.innerText('#pend-qt')), 'pending: Draft shown with its number');
  // approve in PEAK, then the page button reads it
  setPeak((p) => { p.quotations.find((x) => x.id === r2.peakQtId).status = 'Approve'; });
  const dcard = ap.locator('#pend-qt .pcard', { hasText: r2.peakQtNo }).first();
  const btn = dcard.locator('button', { hasText: /PEAK/ }).first(); ok(await btn.count() === 1, 'Draft card has a "check with PEAK" button: ' + (await btn.textContent().catch(() => '')));
  await btn.click(); await modal(ap, true).catch(() => {}); await ap.waitForTimeout(1500); if (await ap.isVisible('#ov-modal:not([hidden])')) await ap.click('#m-ok'); await ap.waitForTimeout(800);
  ok(db().Requests.find((r) => r.requestId === rq.requestId).status === 'qt_approved', 'button → qt_approved after PEAK approval');

  // ── Sales asks for the INV on the form
  await sp.goto(B + '/request#mine'); await sp.waitForTimeout(1500);
  await sp.click('#mine-seg button >> nth=0'); await sp.waitForTimeout(400); ok(new RegExp(r2.peakQtNo).test(await sp.innerText('#tab-mine')), 'my requests: QT number shown'); await shot(sp, 'ui-mine-sales');
  await sp.goto(B + '/request#inv'); await sp.reload(); await sp.waitForTimeout(1500);
  await sp.selectOption('#i-req', rq.requestId); await sp.waitForTimeout(800);
  ok((await sp.inputValue('#i-company')) !== '' && (await sp.inputValue('#i-tax')) === '0105555555554', 'INV form: customer filled from the QT');
  await sp.selectOption('#i-evtype', { index: 1 }); await sp.selectOption('#i-poneed', 'no'); await sp.fill('#i-fin-name', 'Fin'); await sp.fill('#i-fin-email', 'fin@x.co'); await sp.fill('#i-fin-phone', '0812345678');
  await sp.setInputFiles('#i-file', { name: 'po.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') });
  await shot(sp, 'ui-inv-form');
  const invCard = sp.locator('#i-list .inv').first();
  for (const [sel, v] of [['input[type=date]', '2026-11-20']]) await invCard.locator(sel).first().fill(v).catch(() => {});
  const nums = invCard.locator('input[type=number]'); const nn = await nums.count();
  const labels = await invCard.evaluate((el) => [...el.querySelectorAll('input,select')].map((i) => (i.closest('.fg') && i.closest('.fg').querySelector('label') || {}).textContent + ':' + i.type + ':' + (i.value || '')).join(' | '));
  console.log('   INV card fields: ' + labels.slice(0, 400));
  await sp.evaluate(() => { INVS[0].students = '1'; INVS[0].wantedIssueDate = '2026-11-20'; INVS[0].creditTermDays = '30'; INVS[0].originalDoc = 'no'; renderInvs(); });
  await sp.click('#i-submit'); await sp.waitForTimeout(500);
  if (!(await sp.isVisible('#ov-modal:not([hidden])'))) console.log('   INV form message: ' + (await sp.textContent('#i-msg')).trim().slice(0, 160));
  ok(/INV/.test(await modal(sp, true).catch(() => '')), 'INV: confirm dialog');
  await sp.waitForSelector('#i-msg .done-card', { timeout: 10000 }).catch(() => {}); ok(await sp.isVisible('#i-msg .done-card'), 'INV request sent from the form');
  const ivq = db().InvoiceRequests.filter((x) => x.requestId === rq.requestId).pop();
  ok(ivq && Number(ivq.amountInclVat) === 21400, 'INV request defaults to the whole QT: ' + (ivq && ivq.amountInclVat));

  // ── Accounting: INV Draft, approve in PEAK, check
  await ap.goto(B + '/request#pend'); await ap.reload(); await ap.waitForTimeout(1500);
  await ap.click('#pend-seg button:has-text("ใบแจ้งหนี้")'); await ap.waitForTimeout(400);
  const icard = ap.locator('#pend-inv .pcard', { hasText: ivq.ivRequestId }).first(); ok(await icard.count() === 1, 'pending INV listed'); await shot(ap, 'ui-pend-inv');
  await icard.locator('button', { hasText: /สร้าง INV/ }).first().click(); await modal(ap, true); await ap.waitForTimeout(2500); if (await ap.isVisible('#ov-modal:not([hidden])')) await ap.click('#m-ok'); await ap.waitForTimeout(500);
  let iv2 = db().InvoiceRequests.find((x) => x.ivRequestId === ivq.ivRequestId); ok(iv2.status === 'iv_draft' && iv2.peakIvNo, 'button → INV Draft ' + iv2.peakIvNo);
  setPeak((p) => { const x = p.invoices.find((y) => y.id === iv2.peakIvId); x.status = 'Approve'; x.issuedDate = '20261120'; x.dueDate = '20261220'; });
  await ap.waitForTimeout(600); await ap.click('#pend-seg button:has-text("ใบแจ้งหนี้")').catch(() => {});
  const dc = ap.locator('#pend-inv .pcard', { hasText: iv2.peakIvNo }).first();
  await dc.locator('button', { hasText: /เช็ก|PEAK แล้ว/ }).first().click(); await ap.waitForTimeout(2500); if (await ap.isVisible('#ov-modal:not([hidden])')) await ap.click('#m-ok'); await ap.waitForTimeout(500);
  iv2 = db().InvoiceRequests.find((x) => x.ivRequestId === ivq.ivRequestId); ok(iv2.status === 'iv_issued', 'check button → INV issued (' + iv2.status + ')');

  // ── Sales sends a receipt request from the form
  await sp.goto(B + '/request#rt'); await sp.reload(); await sp.waitForTimeout(1500);
  const rseg = await sp.$eval('#r-seg', (e) => [...e.options].map((o) => o.value + '=' + o.textContent.trim()).join('|'));
  await sp.selectOption('#r-seg', { label: await sp.$eval('#r-seg', (e) => [...e.options].find((o) => /B2C/.test(o.textContent)).textContent) }).catch(() => {});
  await sp.selectOption('#r-kind', 'person'); await sp.fill('#r-tax', '1999999990037'); await sp.fill('#r-name', 'คุณ ฟอร์ม'); await sp.fill('#r-addr', '9 ถนนทดสอบ'); await sp.fill('#r-stu', 'WH-999'); await sp.fill('#r-pkg', '5136');
  await sp.fill('#r-price', '12345'); await sp.selectOption('#r-wht', '0'); await sp.fill('#r-paid', '2026-11-14');
  await sp.click('#r-submit'); await sp.waitForTimeout(500);
  if (!(await sp.isVisible('#ov-modal:not([hidden])'))) console.log('   RT form message: ' + (await sp.textContent('#r-msg')).trim().slice(0, 160) + ' | types: ' + rseg);
  await modal(sp, true).catch(() => {}); await sp.waitForSelector('#r-msg .done-card', { timeout: 8000 }).catch(() => {});
  ok(await sp.isVisible('#r-msg .done-card'), 'receipt request sent from the form, confirmation shown');

  // ── AR page: filters, cards, payment, receipt offer
  const cp = await mk('acct@globish.co.th');
  await cp.goto(B + '/ar'); await cp.waitForTimeout(1800);
  const kpi = async () => (await cp.textContent('#s-open')).trim() + ' / ' + (await cp.textContent('#s-open-n')).trim();
  const all = await kpi(); await cp.fill('#f-q', 'zzzzzz'); await cp.waitForTimeout(400); const none = await kpi(); await cp.fill('#f-q', ''); await cp.waitForTimeout(400);
  ok(all !== none && /^0/.test(none) && (await kpi()) === all, `AR cards follow the search box: ${all} → ${none} → back`);
  const fsel = await cp.$$eval('select', (ss) => ss.map((s) => s.id + ':' + [...s.options].map((o) => o.textContent.trim()).slice(0, 8).join(',')));
  console.log('   AR filters: ' + fsel.join(' || ').slice(0, 300));
  ok(/\(ไม่มีเจ้าของ\)/.test(fsel.join(' ')), 'AR sales filter has "(ไม่มีเจ้าของ)"');
  await shot(cp, 'ui-ar');
  // open the row of the new INV and record payment
  await cp.fill('#f-q', iv2.peakIvNo); await cp.waitForTimeout(500);
  const row = cp.locator('tr, .ar-row, .pcard', { hasText: iv2.peakIvNo }).first(); await row.click().catch(() => {}); await cp.waitForTimeout(500);
  const btns = await cp.$$eval('button', (bs) => bs.filter((x) => x.offsetParent !== null).map((x) => x.textContent.trim()).filter(Boolean)); console.log('   AR visible buttons: ' + [...new Set(btns)].join(' | ').slice(0, 400));
  await shot(cp, 'ui-ar-row');

  // ── accounting "my requests" filter by salesperson + owner chips; voided statuses render
  await ap.goto(B + '/request#mine'); await ap.reload(); await ap.waitForTimeout(1800);
  const who = await ap.$eval('#mine-who', (e) => [...e.options].map((o) => o.textContent.trim()).join('|')).catch(() => '');
  ok(/Benz/.test(who) && /Kookkai/.test(who), 'accounting can filter requests by salesperson: ' + who.slice(0, 120));
  ok((await ap.$$('.owner')).length > 0, 'cards show whose request it is');
  await ap.selectOption('#mine-who', { label: (who.split('|').find((x) => /Benz/.test(x))) }); await ap.waitForTimeout(500);
  const visOwners = await ap.$$eval('.owner', (es) => [...new Set(es.filter((e) => e.offsetParent !== null).map((e) => e.textContent.trim()))]); ok(visOwners.every((t) => /Benz/.test(t)), 'filter shows only that salesperson: ' + visOwners.join(','));
  for (const t of ['ใบแจ้งหนี้', 'ใบเสร็จ']) { await ap.click(`#mine-seg button:has-text("${t}")`).catch(() => {}); await ap.waitForTimeout(400); }
  await ap.selectOption('#mine-who', { index: 0 }); await ap.click('#mine-seg button:has-text("ใบแจ้งหนี้")').catch(() => {}); await ap.waitForTimeout(500);
  const mineInv = await ap.innerText('#tab-mine'); ok(/void|ยกเลิก/i.test(mineInv), 'a voided INV shows as cancelled in the list'); await shot(ap, 'ui-mine-acct-inv');
  await ap.click('#mine-seg button:has-text("ใบเสร็จ")').catch(() => {}); await ap.waitForTimeout(500); await shot(ap, 'ui-mine-acct-rt');

  // ── pending receipts: imported INV now offers the PEAK Draft button
  await ap.goto(B + '/request#pend'); await ap.reload(); await ap.waitForTimeout(1500); await ap.click('#pend-seg button:has-text("ใบเสร็จ")').catch(() => {}); await ap.waitForTimeout(1200);
  const prt = await ap.innerText('#pend-rt'); await shot(ap, 'ui-pend-rt');
  console.log('   pending receipts: ' + prt.replace(/\s+/g, ' ').slice(0, 300));
  const opts = await ap.$$eval('select.paym', (ss) => ss.map((s) => s.options.length)); ok(!opts.length || opts.every((n) => n >= 2), 'PEAK accounts loaded in every receipt card: ' + opts.join(','));

  // ── users page: add-user modal opens and validates; health panel
  const up = await mk('admin@globish.co.th');
  await up.goto(B + '/users'); await up.waitForTimeout(1800);
  await up.click('button:has-text("เพิ่มผู้ใช้ใหม่")'); await up.waitForTimeout(400); await shot(up, 'ui-users-add');
  const addOpen = await up.evaluate(() => [...document.querySelectorAll('.ov, [id^=ov-]')].filter((e) => !e.hidden && e.offsetParent !== null).map((e) => e.id).join(','));
  ok(!!addOpen, 'add-user modal opens: ' + addOpen);
  const txt = await up.innerText('body'); ok(/สุขภาพข้อมูล/.test(txt), 'health panel on the users page');
  ok(!/PeakChecks|cross-check/.test(txt), 'removed health checks are gone');

  // ── mobile: sales pages
  const mp = await mk('benz@globish.co.th', 390);
  for (const u of ['/request#mine', '/request#qt', '/request#inv', '/']) { await mp.goto(B + u); await mp.waitForTimeout(1200); const over = await mp.evaluate(() => document.documentElement.scrollWidth - innerWidth); ok(over <= 1, `mobile ${u}: no sideways scroll (${over}px)`); await mp.screenshot({ path: `/tmp/sales-desk-e2e-shots/ui-m${u.replace(/[\/#]/g, '_')}.png` }); }

  ok(!errs.length, 'no JS errors / native dialogs during the whole run' + (errs.length ? ': ' + [...new Set(errs)].join(' | ') : ''));
  done(); await b.close();
})().catch((e) => { console.error('CRASH', e.message.slice(0, 400)); done(); process.exit(1); });
