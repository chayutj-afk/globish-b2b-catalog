// Layout audit: every page, every dialog and expandable block, for three roles, desktop + phone.
// Finds: controls squeezed against their neighbour, checkbox / radio rows that don't line up, clipped text.
const { chromium } = require('playwright'); const { sign, B } = require('./lib.cjs');
const detect = () => {
  const vis = (e) => { if (!e || e.offsetParent === null) return false; const s = getComputedStyle(e); if (s.visibility === 'hidden' || s.opacity === '0') return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.closest('details:not([open]) > :not(summary)'); };
  const name = (e) => (e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ').slice(0, 2).join('.') : '')) + ' "' + (e.textContent || e.value || e.placeholder || '').trim().replace(/\s+/g, ' ').slice(0, 28) + '"';
  const out = [];
  // 1. checkbox / radio: stretched boxes, rows whose boxes don't share a left edge
  const boxes = [...document.querySelectorAll('input[type=checkbox],input[type=radio]')].filter(vis);
  for (const b of boxes) { const r = b.getBoundingClientRect(); if (r.width > 26 || r.height > 26) out.push(`BOX stretched ${Math.round(r.width)}x${Math.round(r.height)}: ${name(b.closest('label') || b)}`); }
  const groups = new Map(); for (const b of boxes) { const g = (b.closest('label') || b).parentElement; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(b); }
  for (const [g, bs] of groups) { if (bs.length < 2) continue; const cols = new Map(); bs.forEach((b) => { const r = b.getBoundingClientRect(); const k = Math.round(r.top); cols.set(k, r.left); });
    const lefts = [...new Set(bs.map((b) => Math.round(b.getBoundingClientRect().left)))]; const tops = new Set(bs.map((b) => Math.round(b.getBoundingClientRect().top)));
    if (tops.size === bs.length && lefts.length > 1 && Math.max(...lefts) - Math.min(...lefts) > 2) out.push(`BOX rows not aligned (left edges ${lefts.join('/')}): ${name(g)}`); }
  // 2. a control touching what stands before it on the same line
  const ctl = [...document.querySelectorAll('button,a.btn,select,input:not([type=hidden]):not([type=checkbox]):not([type=radio]),.pill,.chip,.st,.ok,.saved,.err-line,.badge')].filter(vis);
  for (const e of ctl) {
    const r = e.getBoundingClientRect(); let p = e.previousSibling;
    while (p && ((p.nodeType === 3 && !p.textContent.trim()) || (p.nodeType === 1 && !vis(p)) || p.nodeType === 8)) p = p.previousSibling;
    if (!p) continue;
    let pr;
    if (p.nodeType === 3) { const rg = document.createRange(); rg.selectNodeContents(p); const rs = rg.getClientRects(); pr = rs[rs.length - 1]; } else pr = p.getBoundingClientRect();
    if (!pr || pr.width === 0) continue;
    const sameLine = Math.min(pr.bottom, r.bottom) - Math.max(pr.top, r.top) > Math.min(pr.height, r.height) * 0.4;
    const gap = r.left - pr.right;
    const bothCtl = p.nodeType === 1 && /^(BUTTON|SELECT|INPUT|A)$/.test(p.tagName) && /^(BUTTON|SELECT|INPUT|A)$/.test(e.tagName);
    const small = e.matches('.badge') || (p.nodeType === 1 && p.matches && p.matches('.badge'));
    if (sameLine && gap > -2 && gap < (bothCtl ? 4 : 6) && !small && !(e.closest('.seg') || e.closest('#f-state') || e.closest('.od') || e.closest('#q-opp') || e.closest('#i-opp') || e.closest('.rail'))) out.push(`TIGHT ${Math.round(gap)}px: ${p.nodeType === 3 ? 'text "' + p.textContent.trim().slice(-22) + '"' : name(p)} → ${name(e)}`);
  }
  // 3. clipped text in buttons / pills / table heads
  for (const e of [...document.querySelectorAll('button,a.btn,.pill,.chip,th,.st,h1,h2,h3')].filter(vis)) { const s = getComputedStyle(e); if (e.scrollWidth > e.clientWidth + 2 && s.overflow !== 'visible' && s.textOverflow !== 'ellipsis') out.push(`CLIPPED ${e.scrollWidth}>${e.clientWidth}: ${name(e)}`); }
  // 4. a table wider than its box (the last column hidden behind a scroll)
  for (const t of [...document.querySelectorAll('table')].filter(vis)) if (t.scrollWidth > t.parentElement.clientWidth + 2 && innerWidth > 900) out.push(`TABLE ${t.scrollWidth} in ${t.parentElement.clientWidth}: ${name(t).slice(0, 60)}`);
  return [...new Set(out)];
};
(async () => {
  const b = await chromium.launch(); const seen = new Set(); let total = 0;
  const report = (where, list) => { const fresh = list.filter((x) => !seen.has(x)); fresh.forEach((x) => seen.add(x)); if (fresh.length) { total += fresh.length; console.log(where + '\n   ' + fresh.join('\n   ')); } };
  for (const [w, h, tag] of [[1366, 900, 'desktop'], [390, 844, 'phone']]) for (const who of ['admin@globish.co.th', 'acct@globish.co.th', 'benz@globish.co.th', 'col@globish.co.th']) {
    const c = await b.newContext({ viewport: { width: w, height: h } });
    await c.addCookies([{ name: 'gc_session', value: sign({ email: who, name: who.split('@')[0], exp: Date.now() + 3600e3 }), domain: 'localhost', path: '/' }]);
    const p = await c.newPage(); p.setDefaultTimeout(2500); p.on('dialog', (d) => d.dismiss());
    const tag2 = `${tag} · ${who.split('@')[0]}`;
    const state = async (label) => { await p.waitForTimeout(250); report(`${tag2} · ${label}`, await p.evaluate(detect)); };
    const openAll = async () => { await p.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true; })); };
    const closeModal = async () => { await p.evaluate(() => document.querySelectorAll('.ov').forEach((o) => { if (!o.hidden && o.id !== 'ov-load') { const x = o.querySelector('#m-cancel, button'); o.hidden = true; } })); };
    for (const u of ['/', '/request#qt', '/request#inv', '/request#rt', '/request#mine', '/request#pend', '/ar', '/users', '/import-wh', '/catalog']) {
      await p.goto(B + u, { waitUntil: 'load' }).catch(() => {}); await p.waitForTimeout(1300);
      if (await p.evaluate(() => !!window.SHELL_PENDING || /ไม่มีสิทธิ์ใช้หน้านี้/.test(document.body.innerText))) continue;
      await state(u);
      // sub-tabs
      for (const sel of ['#mine-seg button', '#pend-seg button', '#f-state button']) { const n = await p.locator(sel).count(); for (let i = 0; i < n; i++) { if (!(await p.locator(sel).nth(i).isVisible())) continue; await p.locator(sel).nth(i).click().catch(() => {}); await openAll(); await state(`${u} › ${(await p.locator(sel).nth(i).textContent()).trim().slice(0, 18)}`); } }
      if (u === '/request#qt') { for (const t of await p.$$eval('#q-segment option', (os) => os.map((o) => o.value).filter(Boolean))) { await p.selectOption('#q-segment', t); await p.waitForTimeout(300); const n = await p.locator('#q-adders button').count(); for (let i = 0; i < n; i++) await p.locator('#q-adders button').nth(i).click().catch(() => {}); await p.fill('#q-tax', '0105561000017').catch(() => {}); await p.waitForTimeout(900); await openAll(); await state(`${u} › type ${t} with lines + new customer`); await p.evaluate(() => { try { CART = []; saveCart(); renderItems(); } catch {} }); } }
      if (u === '/request#inv') { await p.evaluate(() => { try { addInv(); setInv(0, 'billTo', 'other'); INVS[1].originalDoc = 'yes'; renderInvs(); } catch {} }); await state(`${u} › 2 invoices, other company, original`); }
      if (u === '/request#rt') { for (const k of ['company', 'person']) { await p.selectOption('#r-kind', k).catch(() => {}); for (const ch of ['email', 'post', 'email_post']) { await p.selectOption('#r-ch', ch).catch(() => {}); } await state(`${u} › ${k}`); } }
      if (u === '/ar') { await p.locator('#f-state button', { hasText: 'ทั้งหมด' }).click().catch(() => {}); const rows = p.locator('tbody tr'); if (await rows.count()) { await rows.first().click().catch(() => {}); await state(`${u} › row open`);
          const acts = await p.$$eval('button', (bs) => bs.filter((x) => x.offsetParent !== null && /เปลี่ยนเซล|บันทึกการติดตาม|บันทึกรับเงิน|สถานะเอกสาร/.test(x.textContent)).map((x) => x.textContent.trim()));
          for (const a of acts) { await p.locator('button', { hasText: a }).first().click().catch(() => {}); await p.waitForTimeout(300); await state(`${u} › ${a}`); await p.evaluate(() => { document.querySelectorAll('.ov').forEach((o) => { if (o.id !== 'ov-load') o.hidden = true; }); }); } }
        await p.locator('button', { hasText: 'สรุป' }).first().click().catch(() => {}); await state(`${u} › สรุป`); }
      if (u === '/users') { for (const fn of ['openAdd()', "openUser(USERS.find((x) => !x.fixedAdmin && x.role === 'sales').email)", "openUser(USERS.find((x) => !x.fixedAdmin && x.role === 'collector').email)", "openUser((USERS.find((x) => x.role === 'pending') || USERS.find((x) => !x.fixedAdmin)).email)"]) { await p.evaluate(fn).catch(() => {}); await p.waitForTimeout(400); await state(`${u} › ${fn.slice(0, 40)}`); await p.evaluate(() => { document.querySelectorAll('.ov').forEach((o) => { o.hidden = true; }); }); }
        const cb = p.locator('button', { hasText: 'ตั้งค่า' }).first(); await p.evaluate(() => { const x = [...document.querySelectorAll('button')].find((y) => /ตั้งค่า/.test(y.textContent) && y.closest('.card') && !y.closest('table')); if (x) x.click(); }); await p.waitForTimeout(600); await openAll(); await state(`${u} › กลุ่มจัดประเภท`); await p.evaluate(() => { document.querySelectorAll('.ov').forEach((o) => { o.hidden = true; }); });
        // the "saved" mark next to the settings button
        await p.evaluate(() => { const m = document.querySelector('td.act'); if (m) m.insertAdjacentHTML('afterbegin', '<span class="saved">✓ บันทึกแล้ว</span>'); }); await state(`${u} › after saving`); }
      if (u === '/request#pend' || u === '/request#mine') { await openAll(); await state(`${u} › everything expanded`); }
    }
    await c.close();
  }
  console.log(total ? `\n${total} layout finding(s)` : '\nlayout: nothing found');
  await b.close();
})();
