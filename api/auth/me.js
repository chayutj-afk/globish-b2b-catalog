// GET /api/auth/me → { ok, user: { email, name, role } } or 401.
const { sendError } = require('../../lib/session');
const { requireUser } = require('../../lib/users');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.status(200).json({ ok: true, user: await requireUser(req, { allowPending: true }) });
  } catch (e) {
    sendError(res, e);
  }
};
