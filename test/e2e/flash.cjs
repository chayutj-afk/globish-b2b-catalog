// The tab in the URL must be the one on screen from the first paint (no flash of the QT form).
const { chromium } = require('playwright'); const { sign, B, ok, done } = require('./lib.cjs');
(async () => {
  const b = await chromium.launch(); const c = await b.newContext({ viewport: { width: 1366, height: 900 } });
  await c.addCookies([{ name: 'gc_session', value: sign({ email: 'acct@globish.co.th', name: 'acct', exp: Date.now() + 3600e3 }), domain: 'localhost', path: '/' }]);
  // Hold the slow calls so the "before data arrives" state can be looked at.
  await c.route(/packages\.json|\/api\//, async (r) => { await new Promise((x) => setTimeout(x, 1500)); r.continue(); });
  for (const t of ['mine', 'pend', 'inv', 'rt', 'qt']) {
    const p = await c.newPage(); await p.goto(B + '/request#' + t, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(300);
    const s = await p.evaluate(() => ({ vis: [...document.querySelectorAll('section.tab')].filter((e) => e.offsetParent !== null).map((e) => e.id).join(','), title: document.getElementById('page-title').textContent, nav: [...document.querySelectorAll('#rail a.ri.on')].map((a) => a.id).join(',') }));
    ok(s.vis === 'tab-' + t && s.nav === 'nav-' + t, `#${t} before data loads: shows ${s.vis}, title "${s.title}", menu ${s.nav}`);
    await p.reload({ waitUntil: 'domcontentloaded' }); await p.waitForTimeout(300);
    ok(await p.evaluate((t) => [...document.querySelectorAll('section.tab')].filter((e) => e.offsetParent !== null).map((e) => e.id).join(',') === 'tab-' + t, t), `#${t} after refresh: same tab`);
    await p.waitForTimeout(2500); ok(await p.evaluate((t) => [...document.querySelectorAll('section.tab')].filter((e) => e.offsetParent !== null).map((e) => e.id).join(',') === 'tab-' + t, t), `#${t} after everything loaded: still that tab`);
    await p.close();
  }
  done(); await b.close();
})();
