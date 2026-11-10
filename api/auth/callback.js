// GET /api/auth/callback?code&state → verify the Google account, set the session cookie.
const { STATE_COOKIE, parseCookies, domain, domainOk, issue, clearHeader } = require('../../lib/session');
const { profileFromCode } = require('../../lib/oauth');
const users = require('../../lib/users');

function back(res, path, cookies) {
  res.setHeader('Set-Cookie', cookies);
  res.setHeader('Cache-Control', 'no-store');
  res.writeHead(302, { Location: path });
  res.end();
}

module.exports = async function handler(req, res) {
  const clearState = clearHeader(STATE_COOKIE);
  try {
    const { code, state, error } = req.query || {};
    if (error) return back(res, '/signin.html?error=denied', [clearState]);
    const [nonce, nextB64] = String(state || '').split('.');
    const expected = parseCookies(req)[STATE_COOKIE];
    if (!code || !nonce || !expected || nonce !== expected) {
      return back(res, '/signin.html?error=state', [clearState]);
    }
    const p = await profileFromCode(req, String(code));
    if (!p || !p.email || p.email_verified === false || !domainOk(p.email) ||
        (p.hd && String(p.hd).toLowerCase() !== domain())) {
      return back(res, '/signin.html?error=domain', [clearState]);
    }
    let next = '/';
    try { next = Buffer.from(nextB64 || '', 'base64url').toString('utf8') || '/'; } catch { next = '/'; }
    if (!next.startsWith('/') || next.startsWith('//')) next = '/';
    const { header } = issue(p.email, p.name);
    await users.touch(p.email, p.name); // record the sign-in (new users start as Sales)
    return back(res, next, [clearState, header]);
  } catch (e) {
    console.error(e);
    return back(res, '/signin.html?error=callback', [clearState]);
  }
};
