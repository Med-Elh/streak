/**
 * Dev-only static server. Not part of the app — delete it and nothing breaks.
 *
 *   node serve.js        → http://localhost:5173
 *   node serve.js 8080   → another port
 *
 * Node's built-in modules only, so there is nothing to install. It exists
 * because opening index.html as a file:// URL makes the browser refuse the ES
 * module imports (modules are fetched under CORS rules, and file:// has no
 * origin), which is exactly how the app loads every one of its scripts.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const port = Number(process.argv[2]) || 5173;
const root = __dirname;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

http
  .createServer((req, res) => {
    const pathname = decodeURIComponent(url.parse(req.url).pathname);
    let filePath = path.join(root, pathname === '/' ? 'index.html' : pathname);

    // Never serve anything outside the project directory.
    if (!filePath.startsWith(root)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    fs.stat(filePath, (err, stat) => {
      if (!err && stat.isDirectory()) filePath = path.join(filePath, 'index.html');

      fs.readFile(filePath, (readErr, body) => {
        if (readErr) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(`404 — ${pathname} isn't in this folder.`);
          return;
        }
        res.writeHead(200, {
          'content-type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
          // Always re-read from disk: a refresh should show the edit you just made.
          'cache-control': 'no-store',
        });
        res.end(body);
      });
    });
  })
  .listen(port, () => {
    console.log(`Streak. is serving ${root}`);
    console.log(`  http://localhost:${port}`);
    console.log('  Ctrl+C to stop.');
  });
