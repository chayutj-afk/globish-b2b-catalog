// GET /api/auth/google?next=/path → redirect to Google sign-in (company accounts only).
const crypto = require('crypto');
const { STATE_COOKIE, cookieHeader, sendError } = require('../../lib/session');
const { authUrl } = require('../../lib/oauth');

function safeNext(v) {
  const s = String(v || '/');
  if (!s.startsWith('/') || s.startsWith('//')) return '/';
  // The catalog is never the landing page: a sign-in that started there (an old bookmark from when the site
  // was only the catalog, or a session that ended on that tab) opens the home page.
  if (/^\/(catalog|2026B2BStandardCatalog\.html)([/?#]|$)/i.test(s)) return '/';
  return s.slice(0, 200);
}

module.exports = async function handler(req, res) {
  try {
    const nonce = crypto.randomBytes(16).toString('base64url');
    const next = safeNext(req.query && req.query.next);
    const state = `${nonce}.${Buffer.from(next).toString('base64url')}`;
    res.setHeader('Set-Cookie', cookieHeader(STATE_COOKIE, nonce, 600));
    res.setHeader('Cache-Control', 'no-store');
    res.writeHead(302, { Location: authUrl(req, state) });
    res.end();
  } catch (e) {
    sendError(res, e);
  }
};
