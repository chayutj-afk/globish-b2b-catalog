// POST /api/auth/logout → clears the session cookie.
const { clearHeader, checkOrigin, sendError } = require('../../lib/session');

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
    checkOrigin(req);
    res.setHeader('Set-Cookie', clearHeader());
    res.status(200).json({ ok: true });
  } catch (e) {
    sendError(res, e);
  }
};
