// Local stand-in for Vercel: runs middleware.js on page requests, serves static files,
// and maps /api/** to the CommonJS handlers with Vercel-style req/res helpers.
// Usage: AUTH_SECRET=... HUB_MODE=mock node test/dev-server.mjs 3939
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import middleware from '../middleware.js';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const port = Number(process.argv[2] || 3939);
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); return res; };
  res.send = (b) => { res.end(b); return res; };

  if (url.pathname.startsWith('/api/')) {
    const file = path.join(root, url.pathname + '.js');
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'no route' });
    let raw = '';
    for await (const c of req) raw += c;
    req.query = Object.fromEntries(url.searchParams);
    try { req.body = raw ? JSON.parse(raw) : undefined; } catch { req.body = raw; }
    req.headers['x-forwarded-proto'] = 'http';
    delete require.cache[file];
    return require(file)(req, res);
  }

  const matcherOk = !/^\/(api\/|signin\.html|favicon\.ico)/.test(url.pathname);
  if (matcherOk) {
    const r = await middleware(new Request(url, { headers: { cookie: req.headers.cookie || '' } }));
    if (r) { res.writeHead(r.status, { Location: r.headers.get('location') }); return res.end(); }
  }
  if (url.pathname === '/catalog') {
    const file = path.join(root, 'api/catalog.js');
    req.headers['x-forwarded-proto'] = 'http';
    delete require.cache[file];
    return require(file)(req, res);
  }
  const REWRITES = { '/': '/home.html', '/request': '/request.html', '/import-contacts': '/import-contacts.html', '/import-wh': '/import-wh.html', '/users': '/users.html' };
  let p = REWRITES[url.pathname] || url.pathname;
  const file = path.join(root, p);
  if (!file.startsWith(root) || !fs.existsSync(file)) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log('dev server on', port));
