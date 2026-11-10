// Google OAuth 2.0 (authorization-code flow) without a framework.
// Same OAuth client as License Desk is fine: add this app's redirect URI
//   https://<domain>/api/auth/callback
// to the client in Google Cloud Console.

const { OAuth2Client } = require('google-auth-library');
const { domain } = require('./session');

function baseUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

function client(req) {
  const id = process.env.GOOGLE_CLIENT_ID;
  const sec = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !sec) {
    const e = new Error('Server ยังไม่ได้ตั้งค่า GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET');
    e.status = 500;
    throw e;
  }
  return new OAuth2Client(id, sec, `${baseUrl(req)}/api/auth/callback`);
}

function authUrl(req, state) {
  return client(req).generateAuthUrl({
    scope: ['openid', 'email', 'profile'],
    state,
    hd: domain(),
    prompt: 'select_account',
    access_type: 'online',
  });
}

// Exchanges the code and returns the verified Google profile, or throws.
async function profileFromCode(req, code) {
  const c = client(req);
  const { tokens } = await c.getToken(code);
  if (!tokens.id_token) throw new Error('Google ไม่ได้ส่ง id_token กลับมา');
  const ticket = await c.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_CLIENT_ID });
  return ticket.getPayload();
}

module.exports = { baseUrl, authUrl, profileFromCode };
