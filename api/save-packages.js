// Vercel Serverless Function
// ─────────────────────────────────────────────
// Publishes the current package list (from the "จัดการ Package" tab) to
// GitHub as packages.json. Because this repo is connected to Vercel with
// auto-deploy on push, committing the file triggers a new deployment
// automatically — so every visitor sees the update once it finishes
// (usually 30-60 seconds), instead of the change only living inside one
// person's browser tab.
//
// AUTH: this endpoint no longer accepts a plaintext password in the
// request body. It requires a short-lived signed token, obtained from
// POST /api/login, sent as "Authorization: Bearer <token>". See login.js
// for how the token is issued and verified — verifyToken() below must stay
// in sync with signToken() there (both are duplicated in each file on
// purpose, so each file can be copy-pasted into GitHub independently
// without needing a shared module path).
//
// Required Environment Variables (set in Vercel → Project → Settings →
// Environment Variables, NOT in this file):
//   AUTH_SECRET          long random string used to verify login tokens —
//                        must be the SAME value set for /api/login.
//   GITHUB_TOKEN         Fine-grained GitHub Personal Access Token with
//                        "Contents: Read and write" permission, scoped to
//                        this one repository only.
//   GITHUB_OWNER         e.g. "chayutj-afk"
//   GITHUB_REPO          e.g. "globish-b2b-catalog"
//   GITHUB_BRANCH        optional, defaults to "main"
//
// This file itself contains no secrets and is safe to commit to a public
// repo.

const crypto = require('crypto');

function verifyToken(token, secret) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [b64, sig] = token.split('.');
  if (!b64 || !sig) return false;
  const expectedSig = crypto.createHmac('sha256', secret).update(b64).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return false;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf-8'));
  } catch {
    return false;
  }
  if (!payload || typeof payload.exp !== 'number' || Date.now() > payload.exp) return false;
  return true;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  try {
    const secret = process.env.AUTH_SECRET;
    if (!secret) {
      res.status(500).json({ ok: false, error: 'Server ยังไม่ได้ตั้งค่า AUTH_SECRET ใน Vercel Environment Variables' });
      return;
    }

    const authHeader = req.headers.authorization || req.headers.Authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    if (!verifyToken(token, secret)) {
      res.status(401).json({ ok: false, error: 'เซสชันหมดอายุ หรือยังไม่ได้ล็อกอิน กรุณาล็อกอินใหม่' });
      return;
    }

    const { packages } = req.body || {};
    if (!Array.isArray(packages) || packages.length === 0) {
      res.status(400).json({ ok: false, error: 'ข้อมูล package ไม่ถูกต้อง หรือว่างเปล่า' });
      return;
    }
    for (const p of packages) {
      if (!p || typeof p.id !== 'string' || typeof p.hero !== 'string') {
        res.status(400).json({ ok: false, error: 'พบแพ็กเกจที่ข้อมูลไม่ครบ (ต้องมีอย่างน้อย id และ hero)' });
        return;
      }
    }

    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH || 'main';
    const ghToken = process.env.GITHUB_TOKEN;
    const path = 'packages.json';

    if (!owner || !repo || !ghToken) {
      res.status(500).json({ ok: false, error: 'Server ยังไม่ได้ตั้งค่า GITHUB_OWNER / GITHUB_REPO / GITHUB_TOKEN ใน Vercel Environment Variables' });
      return;
    }

    const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const ghHeaders = {
      Authorization: `Bearer ${ghToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    // 1) Look up the current file's SHA — GitHub requires this to update an
    //    existing file (prevents accidentally clobbering someone else's
    //    concurrent edit). A 404 here just means the file doesn't exist yet,
    //    which is fine on the very first publish.
    let sha;
    const getRes = await fetch(`${apiBase}?ref=${branch}`, { headers: ghHeaders });
    if (getRes.status === 200) {
      const cur = await getRes.json();
      sha = cur.sha;
    } else if (getRes.status !== 404) {
      const errBody = await getRes.text();
      res.status(502).json({ ok: false, error: `GitHub GET error ${getRes.status}: ${errBody}` });
      return;
    }

    // 2) Commit the new content.
    const content = Buffer.from(JSON.stringify(packages, null, 2) + '\n', 'utf-8').toString('base64');
    const putRes = await fetch(apiBase, {
      method: 'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Update packages.json via Manage Package tab (${new Date().toISOString()})`,
        content,
        branch,
        ...(sha ? { sha } : {}),
      }),
    });

    if (putRes.status !== 200 && putRes.status !== 201) {
      const errBody = await putRes.text();
      res.status(502).json({ ok: false, error: `GitHub PUT error ${putRes.status}: ${errBody}` });
      return;
    }

    const putJson = await putRes.json();
    res.status(200).json({
      ok: true,
      commitUrl: putJson.commit && putJson.commit.html_url,
      count: packages.length,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
};
