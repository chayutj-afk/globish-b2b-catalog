// Shared shell for Sales Desk pages (Whitehouse-style icon rail + top bar + light/dark theme).
// Page markup: <div class="app"><nav class="rail" id="rail"></nav><div class="main">
//   <header class="top"><h1 id="page-title">…</h1><div class="top-r" id="top-r"></div></header><main>…</main></div></div>
// <body data-page="home|request|users|contacts|wh">. Exposes window.SHELL_ME (Promise of the signed-in user).
(function () {
  const I = {
    home: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
    catalog: '<path d="M4 5h16v14H4z"/><path d="M4 9h16M9 9v10"/>',
    qt: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',
    inv: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
    rt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="m9 11 2 2 4-4"/>',
    mine: '<path d="M3 7h6l2 2h10v10H3z"/>',
    pend: '<path d="M20 6 9 17l-5-5"/>',
    ar: '<path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.4 3.3-5.5 6.5-5.5s5.9 2.1 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.8c1.7.8 2.8 2.6 3 5.2"/>',
    contacts: '<path d="M4 4h16v16H4z"/><circle cx="12" cy="10" r="3"/><path d="M7 18c.8-2.2 2.7-3.5 5-3.5s4.2 1.3 5 3.5"/>',
    wh: '<path d="M12 3 3 7.5v9L12 21l9-4.5v-9z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
    out: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
    more: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  };
  const svg = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${I[k]}</svg>`;
  const page = document.body.dataset.page || '';
  const onReq = page === 'request';
  // id = nav-* on the request page so its tab code can mark the active one.
  const items = [
    { k: 'home', href: '/', label: 'หน้าแรก' },
    { k: 'catalog', href: '/catalog', label: 'Catalog', gate: 'catalog' },
    { sep: 1 },
    { k: 'qt', href: '/request#qt', label: 'ขอ QT', id: 'nav-qt', gate: 'request' },
    { k: 'inv', href: '/request#inv', label: 'ขอ INV', id: 'nav-inv', gate: 'request' },
    { k: 'rt', href: '/request#rt', label: 'ขอใบเสร็จ', id: 'nav-rt', gate: 'request' },
    { k: 'mine', href: '/request#mine', label: 'คำขอของฉัน', id: 'nav-mine', gate: 'mine' },
    { k: 'pend', href: '/request#pend', label: 'รออนุมัติ', id: 'nav-pend', gate: 'approve', badge: 'pend-count' },
    { k: 'ar', href: '/ar', label: 'ติดตามหนี้', gate: 'ar_view', badge: 'ar-pay-n' },
    { sep: 1, gate: 'tools' },
    { k: 'users', href: '/users', label: 'ผู้ใช้', gate: 'users' },
    { k: 'wh', href: '/import-wh', label: 'แพ็กเกจ WH', gate: 'import' },
  ];
  const rail = document.getElementById('rail');
  if (rail) {
    rail.setAttribute('aria-label', 'เมนู');
    rail.innerHTML = '<a class="logo" href="/" title="Globish Sales Desk">G</a>' + items.map((it) => {
      if (it.sep) return `<div class="sep" ${it.gate ? `data-gate="${it.gate}" hidden` : ''}></div>`;
      const on = (it.k === page) || (onReq && (location.hash ? it.href === '/request' + location.hash : it.k === 'qt'));
      return `<a class="ri${on ? ' on' : ''}" href="${onReq && it.k === 'catalog' ? '/catalog?return=request' : it.href}" ${onReq && it.k === 'catalog' ? 'data-keep="1"' : ''} ${it.id ? `id="${it.id}"` : ''} ${it.gate ? `data-gate="${it.gate}" hidden` : ''}>${svg(it.k)}<span>${it.label}</span>${it.badge ? `<span class="badge" id="${it.badge}" hidden></span>` : ''}</a>`;
    }).join('') + `<a class="ri m-only" href="#" id="m-more" aria-expanded="false">${svg('more')}<span>เมนู</span></a>`;
    // Phone: the bottom bar keeps 4 main items for the person's role; the rest open from "เมนู".
    const more = document.getElementById('m-more');
    more.addEventListener('click', (e) => { e.preventDefault(); const o = rail.classList.toggle('open'); more.setAttribute('aria-expanded', String(o)); });
    rail.addEventListener('click', (e) => { if (e.target.closest('a.ri') && e.target.closest('a.ri') !== more) { rail.classList.remove('open'); more.setAttribute('aria-expanded', 'false'); } });
    if (onReq) rail.querySelectorAll('a.ri[id^="nav-"]').forEach((a) => a.addEventListener('click', (e) => {
      if (typeof window.go === 'function') { e.preventDefault(); window.go(a.id.slice(4)); }
    }));
  }
  // theme
  const root = document.documentElement;
  const setTheme = (t) => { root.dataset.theme = t; try { localStorage.setItem('gsd_theme', t); } catch (e) {} paintToggle(); };
  const top = document.getElementById('top-r');
  function paintToggle() { const b = document.getElementById('theme-btn'); if (b) { const dark = root.dataset.theme === 'dark'; b.innerHTML = svg(dark ? 'sun' : 'moon'); b.title = dark ? 'โหมดสว่าง' : 'โหมดมืด'; } }
  if (top) {
    top.innerHTML = `<span id="me"></span><button class="icon-btn" id="theme-btn" type="button"></button><button class="icon-btn" type="button" title="ออกจากระบบ" id="out-btn">${svg('out')}</button>`;
    document.getElementById('theme-btn').onclick = () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark');
    document.getElementById('out-btn').onclick = async () => { try { await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' } }); } catch (e) {} location.href = '/signin.html'; };
    paintToggle();
  }
  window.refreshPayBadge = () => fetch('/api/invoice-requests?view=payments&count=1', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((d) => {
    const b = document.getElementById('ar-pay-n'); if (!b || !d) return;
    b.textContent = d.open || ''; b.hidden = !d.open; b.title = d.open ? `เซลแจ้งว่าลูกค้าจ่ายแล้ว รอตรวจ ${d.open} รายการ` : '';
  }).catch(() => {});
  // who is signed in → show gated items
  window.SHELL_ME = fetch('/api/auth/me', { cache: 'no-store' }).then((r) => {
    if (r.status === 401) { location.href = '/signin.html?next=' + encodeURIComponent(location.pathname + location.hash); return null; }
    return r.json();
  }).then((d) => {
    const u = d && d.user;
    if (!u) return null;
    const me = document.getElementById('me'); if (me) me.textContent = u.email;
    // data-gate = a permission name (see lib/users.js PERMS); a few combined gates below.
    const P = new Set(u.perms || []);
    const extra = { op: P.has('approve'), admin: P.has('users'), mine: P.has('request') || P.has('team_view'), tools: P.has('users') || P.has('import'), tools2: P.has('users') || P.has('import') || P.has('approve') || P.has('ar_view') };
    document.querySelectorAll('[data-gate]').forEach((el) => { const g = el.dataset.gate; el.hidden = !(g in extra ? extra[g] : P.has(g)); });
    const main = P.has('approve') ? ['home', 'pend', 'ar', 'mine'] : P.has('ar_view') && !P.has('request') ? ['home', 'ar', 'catalog', 'mine'] : ['home', 'qt', 'inv', 'mine'];
    document.querySelectorAll('#rail a.ri:not(#m-more)').forEach((a) => {
      const k = (a.getAttribute('href') || '').replace(/^\/request#/, '').replace(/^\/$/, 'home').replace(/^\/(catalog).*/, '$1').replace(/^\//, '');
      a.classList.toggle('m-more', !main.includes(k));
    });
    const mm = document.getElementById('m-more'); if (mm) mm.classList.toggle('on', !!document.querySelector('#rail a.ri.on.m-more'));
    // A page only some roles may use: show one clear message instead of a half-empty page.
    const need = document.body.dataset.need;
    if (need && !P.has(need)) { const m = document.querySelector('main'); if (m) m.innerHTML = '<div class="card" style="margin-top:16px"><h2>ไม่มีสิทธิ์ใช้หน้านี้</h2><p class="hint" style="margin:6px 0 0">ถ้าต้องใช้ ขอสิทธิ์จากผู้ดูแลระบบ (หน้า จัดการสิทธิ์ผู้ใช้) · <a href="/">กลับหน้าแรก</a></p></div>'; }
    // Payment notices from Sales waiting for accounting / collector: count on the "ติดตามหนี้" menu.
    if (P.has('ar') || P.has('approve')) window.refreshPayBadge();
    return u;
  }).catch(() => null);
})();
