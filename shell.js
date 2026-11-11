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
    mine: '<path d="M3 7h6l2 2h10v10H3z"/>',
    pend: '<path d="M20 6 9 17l-5-5"/>',
    ar: '<path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.4 3.3-5.5 6.5-5.5s5.9 2.1 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.8c1.7.8 2.8 2.6 3 5.2"/>',
    contacts: '<path d="M4 4h16v16H4z"/><circle cx="12" cy="10" r="3"/><path d="M7 18c.8-2.2 2.7-3.5 5-3.5s4.2 1.3 5 3.5"/>',
    wh: '<path d="M12 3 3 7.5v9L12 21l9-4.5v-9z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
    out: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
  };
  const svg = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${I[k]}</svg>`;
  const page = document.body.dataset.page || '';
  const onReq = page === 'request';
  // id = nav-* on the request page so its tab code can mark the active one.
  const items = [
    { k: 'home', href: '/', label: 'หน้าแรก' },
    { k: 'catalog', href: '/catalog', label: 'Catalog', gate: 'catalog' },
    { sep: 1 },
    { k: 'qt', href: '/request#qt', label: 'ขอ QT', id: 'nav-qt' },
    { k: 'inv', href: '/request#inv', label: 'ขอ INV', id: 'nav-inv' },
    { k: 'mine', href: '/request#mine', label: 'คำขอของฉัน', id: 'nav-mine' },
    { k: 'pend', href: '/request#pend', label: 'รออนุมัติ', id: 'nav-pend', gate: 'op', badge: 'pend-count' },
    { k: 'ar', href: '/ar', label: 'ติดตามหนี้', gate: 'op' },
    { sep: 1, gate: 'op' },
    { k: 'users', href: '/users', label: 'ผู้ใช้', gate: 'admin' },
    { k: 'contacts', href: '/import-contacts', label: 'ลูกค้า PEAK', gate: 'op' },
    { k: 'wh', href: '/import-wh', label: 'แพ็กเกจ WH', gate: 'op' },
  ];
  const rail = document.getElementById('rail');
  if (rail) {
    rail.setAttribute('aria-label', 'เมนู');
    rail.innerHTML = '<a class="logo" href="/" title="Globish Sales Desk">G</a>' + items.map((it) => {
      if (it.sep) return `<div class="sep" ${it.gate ? `data-gate="${it.gate}" hidden` : ''}></div>`;
      const on = (it.k === page) || (onReq && it.k === 'qt' && !location.hash);
      return `<a class="ri${on ? ' on' : ''}" href="${it.href}" ${it.id ? `id="${it.id}"` : ''} ${it.gate ? `data-gate="${it.gate}" hidden` : ''}>${svg(it.k)}<span>${it.label}</span>${it.badge ? `<span class="badge" id="${it.badge}" hidden></span>` : ''}</a>`;
    }).join('');
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
  // who is signed in → show gated items
  window.SHELL_ME = fetch('/api/auth/me', { cache: 'no-store' }).then((r) => {
    if (r.status === 401) { location.href = '/signin.html?next=' + encodeURIComponent(location.pathname + location.hash); return null; }
    return r.json();
  }).then((d) => {
    const u = d && d.user;
    if (!u) return null;
    const me = document.getElementById('me'); if (me) me.textContent = u.email;
    const ok = { op: u.role === 'op', admin: !!u.admin, catalog: u.catalog !== false };
    document.querySelectorAll('[data-gate]').forEach((el) => { el.hidden = !ok[el.dataset.gate]; });
    return u;
  }).catch(() => null);
})();
