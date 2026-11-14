const { chromium } = require('playwright'); const { sign, B } = require('./lib.cjs');
(async () => {
  const b = await chromium.launch(); let bad = 0;
  const pages = ['/', '/request#qt', '/request#inv', '/request#rt', '/request#edit', '/request#mine', '/request#pend', '/ar', '/users', '/import-wh', '/catalog'];
  const allow = { 'bee@globish.co.th': ['/ar', '/users', '/import-wh', '/request#pend'], 'benz@globish.co.th': ['/ar', '/users', '/import-wh', '/catalog', '/request#pend'], 'lead@globish.co.th': ['/users', '/import-wh', '/request#pend'], 'col@globish.co.th': ['/users', '/import-wh', '/catalog', '/request#qt', '/request#inv', '/request#rt', '/request#edit', '/request#mine', '/request#pend'], 'oper@globish.co.th': ['/ar', '/users', '/request#pend'], 'acct@globish.co.th': ['/users'], 'admin@globish.co.th': [] };
  for (const [w, h, tag] of [[1366, 900, 'd'], [390, 844, 'm']]) for (const theme of tag === 'd' ? ['light', 'dark'] : ['light']) for (const who of Object.keys(allow)) {
    const c = await b.newContext({ viewport: { width: w, height: h } });
    await c.addCookies([{ name: 'gc_session', value: sign({ email: who, name: who.split('@')[0], exp: Date.now() + 3600e3 }), domain: 'localhost', path: '/' }]);
    await c.addInitScript((t) => { try { localStorage.setItem('gsd_theme', t); } catch {} }, theme);
    for (const u of pages) {
      const p = await c.newPage(); const errs = [];
      p.on('pageerror', (e) => errs.push('JS ' + e.message));
      p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('CON ' + m.text().slice(0, 160)); });
      p.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 400 && !(allow[who].includes(u) && [403].includes(r.status())) && !(r.status() === 403 && /view=(payments|ar|health|pay-methods)|\/api\/users/.test(r.url()))) errs.push(`API ${r.status()} ${r.url().replace(B, '')}`); });
      await p.goto(B + u, { waitUntil: 'load' }).catch((e) => errs.push('NAV ' + e.message.slice(0, 100)));
      await p.waitForTimeout(1600);
      const info = await p.evaluate(() => {
        const vis = (e) => e.offsetParent !== null && getComputedStyle(e).visibility !== 'hidden';
        const over = document.documentElement.scrollWidth - window.innerWidth;
        const wide = over > 2 ? [...document.querySelectorAll('body *')].filter((e) => vis(e) && e.getBoundingClientRect().right > window.innerWidth + 2).slice(0, 3).map((e) => e.tagName + '.' + String(e.className).slice(0, 30) + '#' + e.id) : [];
        const txt = document.body.innerText;
        return { over, wide, xss: !!window.__xss, undef: (txt.match(/\bundefined\b|\bNaN\b|\[object Object\]|\bnull\b/g) || []).slice(0, 5), stuck: /กำลังโหลด…/.test(txt) && !/select/i.test(''), len: txt.length, path: location.pathname + location.hash };
      });
      const stuckLoading = await p.evaluate(() => [...document.querySelectorAll('.empty, .loading, td, p, div')].filter((e) => e.children.length === 0 && /^กำลังโหลด/.test(e.textContent.trim()) && e.offsetParent !== null && !e.closest('details:not([open])')).length);
      const prob = [];
      if (info.over > 2) prob.push('overflow ' + info.over + 'px ' + info.wide.join(','));
      if (info.xss) prob.push('XSS EXECUTED');
      if (info.undef.length) prob.push('text shows: ' + info.undef.join(','));
      if (stuckLoading) prob.push('still "กำลังโหลด" x' + stuckLoading);
      if (info.len < 40) prob.push('page nearly empty');
      prob.push(...new Set(errs));
      if (prob.length) { bad++; console.log(`${tag}/${theme} ${who.split('@')[0]} ${u} → ${info.path}\n   ` + prob.join('\n   ')); await p.screenshot({ path: `/tmp/sales-desk-e2e-shots/bad-${tag}-${who.split('@')[0]}-${u.replace(/[\/#]/g, '_')}.png` }); }
      await p.close();
    }
    await c.close();
  }
  console.log(bad ? `${bad} page(s) with problems` : 'crawl: no problems on any page / role / size');
  await b.close();
})();
