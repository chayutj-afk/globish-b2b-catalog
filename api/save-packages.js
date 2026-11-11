// Vercel Serverless Function
// ─────────────────────────────────────────────
// Publishes the current package list (from the "จัดการ Package" tab) to
// GitHub as packages.json. Because this repo is connected to Vercel with
// auto-deploy on push, committing the file triggers a new deployment
// automatically — so every visitor sees the update once it finishes
// (usually 30-60 seconds), instead of the change only living inside one
// person's browser tab.
//
// AUTH: requires a Google sign-in session (see lib/session.js) whose email is listed in
// role Accountant / Admin (Users tab, set at /users). The old shared Operation password is gone.
//
// Required Environment Variables (set in Vercel → Project → Settings →
// Environment Variables, NOT in this file):
//   AUTH_SECRET          long random string that signs session cookies
//   GITHUB_TOKEN         Fine-grained GitHub Personal Access Token with
//                        "Contents: Read and write" permission, scoped to
//                        this one repository only.
//   GITHUB_OWNER         e.g. "chayutj-afk"
//   GITHUB_REPO          e.g. "globish-b2b-catalog"
//   GITHUB_BRANCH        optional, defaults to "main"
//
// This file itself contains no secrets and is safe to commit to a public
// repo.

const { checkOrigin, sendError } = require('../lib/session');
const { requireUser } = require('../lib/users');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  try {
    let user;
    try {
      user = await requireUser(req);
      if (!user.catalogOp) throw Object.assign(new Error('เฉพาะผู้ใช้ที่มีสิทธิ์ Operation (ตั้งที่หน้าจัดการสิทธิ์)'), { status: 403 });
      checkOrigin(req);
    } catch (e) {
      sendError(res, e);
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
        message: `Update packages.json via Manage Package tab by ${user.email} (${new Date().toISOString()})`,
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
