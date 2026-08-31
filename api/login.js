// Vercel Serverless Function
// ─────────────────────────────────────────────
// POST { password } → { token, exp } on success.
//
// Replaces the old client-side-only password check (a plaintext string
// compared inside the page's JavaScript, visible to anyone who opens
// view-source). The password now lives ONLY as a server-side Environment
// Variable and is never sent to the browser in any form — the client sends
// what it was typed, this function checks it against OPERATION_PASSWORD on
// the server, and on success issues a short-lived signed token instead of
// echoing the password back. The page stores that token (not the
// password) and sends it as "Authorization: Bearer <token>" to
// /api/save-packages. A leaked token is only useful until it expires
// (8 hours) — a leaked hardcoded password would have worked forever.
//
// The token is a small HMAC-signed payload — no external JWT library
// needed, just Node's built-in crypto module:
//   base64url(JSON {exp}) + "." + HMAC-SHA256(that, AUTH_SECRET)
// verifyToken() in save-packages.js re-derives the signature and checks
// both the signature and the expiry before trusting the token.
//
// Required Environment Variables (Vercel → Project → Settings →
// Environment Variables):
//   OPERATION_PASSWORD   the shared password Operations types in to log in
//   AUTH_SECRET          a long random string used to sign tokens — must
//                        NOT be the same value as OPERATION_PASSWORD.
//                        Generate one with, e.g.: openssl rand -hex 32

const crypto = require('crypto');

const TOKEN_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

function signToken(payload, secret) {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  const expected = process.env.OPERATION_PASSWORD;
  const secret = process.env.AUTH_SECRET;
  if (!expected || !secret) {
    res.status(500).json({ ok: false, error: 'Server ยังไม่ได้ตั้งค่า OPERATION_PASSWORD / AUTH_SECRET ใน Vercel Environment Variables' });
    return;
  }

  const { password } = req.body || {};
  const a = Buffer.from(String(password || ''));
  const b = Buffer.from(String(expected));
  // timingSafeEqual requires equal-length buffers. Comparing lengths first
  // is itself technically timing-observable, but only leaks the length of
  // the correct password, not its content — an acceptable tradeoff here to
  // avoid throwing on a mismatched-length guess.
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!match) {
    res.status(401).json({ ok: false, error: 'รหัสผ่านไม่ถูกต้อง' });
    return;
  }

  const exp = Date.now() + TOKEN_TTL_MS;
  const token = signToken({ exp }, secret);
  res.status(200).json({ ok: true, token, exp });
};
