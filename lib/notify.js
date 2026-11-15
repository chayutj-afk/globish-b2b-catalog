// Google Chat notifications (incoming webhooks). Failures never break a request.
// Two rooms:
//   main    GCHAT_WEBHOOK_URL          requests and their results (sales + accounting)
//   finance GCHAT_FINANCE_WEBHOOK_URL  new users waiting for activation and system problems.
//           Until that variable is set, finance messages go to the main room.
// configured() → 'missing' | 'invalid' | 'ok'
const OK = /^https:\/\/chat\.googleapis\.com\/v1\/spaces\/[^/]+\/messages\?/;
const urlOf = (room) => {
  const main = String(process.env.GCHAT_WEBHOOK_URL || '').trim();
  const fin = String(process.env.GCHAT_FINANCE_WEBHOOK_URL || '').trim();
  return room === 'finance' && OK.test(fin) ? fin : main;
};
function configured(room) {
  if (room === 'finance') { const f = String(process.env.GCHAT_FINANCE_WEBHOOK_URL || '').trim(); return !f ? 'missing' : OK.test(f) ? 'ok' : 'invalid'; }
  const url = String(process.env.GCHAT_WEBHOOK_URL || '').trim();
  if (!url) return 'missing';
  return OK.test(url) ? 'ok' : 'invalid';
}
async function send(text, { room } = {}) {
  const url = urlOf(room);
  const state = !url ? 'missing' : OK.test(url) ? 'ok' : 'invalid';
  if (state !== 'ok') return { ok: false, state };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      // Only tags made by at() become real mentions: a "<users/…>" typed into a company name or a note stays text.
      body: JSON.stringify({ text: String(text).slice(0, 3500).replace(/<(?=users\/)/gi, '‹').replace(/\u0001(\d+)\u0002/g, '<users/$1>') }),
    });
    if (!res.ok) console.error('Google Chat notify failed', res.status, (await res.text()).slice(0, 300));
    return { ok: res.ok, state, status: res.status };
  } catch (e) {
    console.error('Google Chat notify failed', e);
    return { ok: false, state, error: e.message };
  }
}
async function chat(text, opts) { return (await send(text, opts)).ok; }
const finance = (text) => chat(text, { room: 'finance' });

// "@name" for a person in a Chat message. A webhook can only tag by Google account id (not by email); the
// id is saved in the Users tab the first time the person signs in. Until then (or for someone who left)
// the plain name is written. The person must be a member of the room to get the notification.
async function at(email, name) {
  const e = String(email || '').toLowerCase();
  if (!/@/.test(e)) return name || email || '';
  try {
    const u = (await require('./hub').readTable('Users')).find((x) => String(x.email).toLowerCase() === e);
    if (u && /^\d{6,30}$/.test(String(u.googleId || ''))) return `\u0001${u.googleId}\u0002`;
    return name || (u && u.name) || e;
  } catch { return name || e; }
}

// Short pieces for one-line messages: details stay in the app, the message links there.
const base = () => String(process.env.APP_URL || 'https://globish-sales-desk.vercel.app').replace(/\/+$/, '');
const PAGES = { mine: '/request#mine', pend: '/request#pend', ar: '/ar', users: '/users' };
const link = (page, label = 'เปิดดู') => `<${base()}${PAGES[page] || '/'}|${label}>`;
const co = (name) => { const t = String(name || '').replace(/[<>|\n]/g, ' ').trim(); return t.length > 42 ? t.slice(0, 40) + '…' : t; };
const why = (note) => { const t = String(note || '').replace(/\s+/g, ' ').trim(); return t.length > 140 ? t.slice(0, 138) + '…' : t; };

module.exports = { chat, finance, send, configured, at, link, co, why };
