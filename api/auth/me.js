// GET /api/auth/me → { ok, user: { email, name, role } } or 401.
const { requireUser, sendError } = require('../../lib/session');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.status(200).json({ ok: true, user: requireUser(req) });
  } catch (e) {
    sendError(res, e);
  }
};
