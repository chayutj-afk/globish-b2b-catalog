// Vercel Serverless Function
// ─────────────────────────────────────────────
// Publishes the current package list (and catalog-config.json: product types hidden from Sales) (from the "จัดการ Package" tab) to
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

    const body = req.body || {};
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH || 'main';
    const ghToken = process.env.GITHUB_TOKEN;
    if (!owner || !repo || !ghToken) {
      res.status(500).json({ ok: false, error: 'Server ยังไม่ได้ตั้งค่า GITHUB_OWNER / GITHUB_REPO / GITHUB_TOKEN ใน Vercel Environment Variables' });
      return;
    }
    const commit = (path, data, message) => commitFile({ owner, repo, branch, ghToken, path, data, message });

    // Which product types the Sales calculator / catalog table show (Manage tab → "👁️ ประเภทสินค้าที่แสดงในหน้าเซล").
    if (body.catalogConfig) {
      const hidden = body.catalogConfig.hiddenTypes;
      if (!Array.isArray(hidden) || hidden.length > 50 || hidden.some((t) => typeof t !== 'string' || !t.trim() || t.length > 80)) {
        res.status(400).json({ ok: false, error: 'รายการประเภทสินค้าที่ซ่อนไม่ถูกต้อง' });
        return;
      }
      const hiddenTypes = [...new Set(hidden.map((t) => t.trim()))];
      const r = await commit('catalog-config.json', { hiddenTypes },
        `Catalog: product types hidden from Sales = [${hiddenTypes.join(', ') || 'none'}] by ${user.email}`);
      if (!r.ok) { res.status(502).json({ ok: false, error: r.error }); return; }
      res.status(200).json({ ok: true, commitUrl: r.commitUrl, hiddenTypes });
      return;
    }

    const { packages } = body;
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
    const r = await commit('packages.json', packages,
      `Update packages.json via Manage Package tab by ${user.email} (${new Date().toISOString()})`);
    if (!r.ok) { res.status(502).json({ ok: false, error: r.error }); return; }
    res.status(200).json({ ok: true, commitUrl: r.commitUrl, count: packages.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
};

// Commit one JSON file to the repo through the GitHub contents API (Vercel redeploys on push).
// The current SHA is required to update an existing file; a 404 just means it doesn't exist yet.
async function commitFile({ owner, repo, branch, ghToken, path, data, message }) {
  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const ghHeaders = { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  let sha;
  const getRes = await fetch(`${apiBase}?ref=${branch}`, { headers: ghHeaders });
  if (getRes.status === 200) sha = (await getRes.json()).sha;
  else if (getRes.status !== 404) return { ok: false, error: `GitHub GET error ${getRes.status}: ${await getRes.text()}` };
  const content = Buffer.from(JSON.stringify(data, null, 2) + '\n', 'utf-8').toString('base64');
  const putRes = await fetch(apiBase, {
    method: 'PUT',
    headers: { ...ghHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content, branch, ...(sha ? { sha } : {}) }),
  });
  if (putRes.status !== 200 && putRes.status !== 201) return { ok: false, error: `GitHub PUT error ${putRes.status}: ${await putRes.text()}` };
  const putJson = await putRes.json();
  return { ok: true, commitUrl: putJson.commit && putJson.commit.html_url };
}

module.exports.commitFile = commitFile;
