// Every inline handler in the pages (onclick="fn(…)") must name a function the page defines.
// A button whose function was dropped by an edit does nothing when pressed, with no error on screen.
const test = require('node:test'); const assert = require('node:assert'); const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..');
const shared = ['shell.js'].filter((f) => fs.existsSync(path.join(root, f))).map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
for (const f of fs.readdirSync(root).filter((x) => x.endsWith('.html'))) {
  test(`inline handlers exist: ${f}`, () => {
    const s = fs.readFileSync(path.join(root, f), 'utf8') + '\n' + shared;
    const names = new Set([...s.matchAll(/\bon(?:click|change|input|submit|keydown|keyup|blur|focus)=\\?["']\s*(?:return\s+)?([A-Za-z_][\w]*)\(/g)].map((m) => m[1]));
    const missing = [...names].filter((n) => !['if', 'event', 'alert', 'confirm', 'history', 'location', 'window', 'document'].includes(n)
      && !new RegExp(`function\\s+${n}\\b|(?:const|let|var)\\s+${n}\\b|window\\.${n}\\s*=`).test(s));
    assert.deepStrictEqual(missing, []);
  });
}
