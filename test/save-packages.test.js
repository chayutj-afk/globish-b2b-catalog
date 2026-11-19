const test = require('node:test');
const assert = require('node:assert');
const { commitFile } = require('../api/save-packages');

test('save-packages: commitFile sends the current SHA and pretty JSON to the GitHub contents API', async () => {
  const calls = [];
  const orig = global.fetch;
  global.fetch = async (url, opt = {}) => {
    calls.push({ url, opt });
    if (!opt.method) return { status: 200, json: async () => ({ sha: 'abc123' }) };
    return { status: 200, json: async () => ({ commit: { html_url: 'https://github.com/x/y/commit/1' } }) };
  };
  try {
    const r = await commitFile({ owner: 'o', repo: 'r', branch: 'main', ghToken: 't', path: 'catalog-config.json', data: { hiddenTypes: ['VPA'] }, message: 'm' });
    assert.deepStrictEqual(r, { ok: true, commitUrl: 'https://github.com/x/y/commit/1' });
    assert.strictEqual(calls[0].url, 'https://api.github.com/repos/o/r/contents/catalog-config.json?ref=main');
    const body = JSON.parse(calls[1].opt.body);
    assert.strictEqual(body.sha, 'abc123');
    assert.strictEqual(Buffer.from(body.content, 'base64').toString(), '{\n  "hiddenTypes": [\n    "VPA"\n  ]\n}\n');
  } finally { global.fetch = orig; }
});

test('save-packages: a missing file is created (no SHA); a GitHub error is reported, not thrown', async () => {
  const orig = global.fetch;
  let put;
  global.fetch = async (url, opt = {}) => (!opt.method ? { status: 404, text: async () => '' } : (put = JSON.parse(opt.body), { status: 201, json: async () => ({}) }));
  try {
    const r = await commitFile({ owner: 'o', repo: 'r', branch: 'main', ghToken: 't', path: 'catalog-config.json', data: { hiddenTypes: [] }, message: 'm' });
    assert.strictEqual(r.ok, true); assert.strictEqual(put.sha, undefined);
    global.fetch = async () => ({ status: 403, text: async () => 'forbidden' });
    const bad = await commitFile({ owner: 'o', repo: 'r', branch: 'main', ghToken: 't', path: 'x.json', data: {}, message: 'm' });
    assert.deepStrictEqual(bad, { ok: false, error: 'GitHub GET error 403: forbidden' });
  } finally { global.fetch = orig; }
});
