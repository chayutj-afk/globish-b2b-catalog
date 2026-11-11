// Vercel Routing Middleware (Edge). Every page and static file needs a valid session
// cookie; without one the visitor is sent to /signin.html. API routes check the session
// themselves and answer 401 JSON, so they're excluded here.
//
// verify() mirrors lib/session.js (Node crypto) using Web Crypto; keep them in step.

export const config = {
  matcher: ['/((?!api/|signin\\.html|app\\.css|favicon\\.ico).*)'],
};

const enc = new TextEncoder();

function b64urlToBytes(s) {
  const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function bytesToB64url(bytes) {
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function verifySession(token, secret, domain) {
  if (!token || !secret || token.indexOf('.') < 1) return null;
  const [b64, sig] = token.split('.');
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = bytesToB64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(b64))));
  if (expected.length !== (sig || '').length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  let p;
  try { p = JSON.parse(new TextDecoder().decode(b64urlToBytes(b64))); } catch { return null; }
  if (!p || typeof p.exp !== 'number' || Date.now() > p.exp) return null;
  if (typeof p.email !== 'string' || !p.email.toLowerCase().endsWith('@' + domain)) return null;
  return p;
}

function readCookie(header, name) {
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export default async function middleware(request) {
  const domain = (process.env.ALLOWED_EMAIL_DOMAIN || 'globish.co.th').toLowerCase();
  const token = readCookie(request.headers.get('cookie'), 'gc_session');
  const user = await verifySession(token, process.env.AUTH_SECRET, domain);
  const url = new URL(request.url);
  // The catalog is served through /api/catalog (team check); never the raw file.
  if (/^\/2026B2BStandardCatalog\.html$/i.test(url.pathname)) return Response.redirect(new URL('/catalog' + url.search + url.hash, url), 302);
  if (user) return; // continue to the page
  const next = url.pathname + url.search + url.hash;
  return Response.redirect(new URL('/signin.html?next=' + encodeURIComponent(next), url), 302);
}
