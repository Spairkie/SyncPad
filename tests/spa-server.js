#!/usr/bin/env node
// Minimal SPA static server for Playwright tests.
// Serves the SyncPad project at /SyncPad/ with SPA fallback to index.html.
// Usage: node tests/spa-server.js [port=5555]
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5555;
const ROOT = path.resolve(__dirname, '..', '..'); // /home/user/ (parent of SyncPad)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt':  'text/plain',
  '.md':   'text/markdown',
};

const SPA_INDEX = path.join(ROOT, 'SyncPad', 'index.html');

http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  const filePath = path.join(ROOT, urlPath);

  const tryServe = (fp) => {
    const ext = path.extname(fp).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    try {
      const data = fs.readFileSync(fp);
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
      return true;
    } catch { return false; }
  };

  // Try exact file, then index.html in dir, then SPA fallback
  if (!tryServe(filePath)) {
    if (!tryServe(path.join(filePath, 'index.html'))) {
      // SPA fallback: serve /SyncPad/index.html for all /SyncPad/* routes
      if (urlPath.startsWith('/SyncPad/') || urlPath === '/SyncPad') {
        tryServe(SPA_INDEX) || (res.writeHead(404), res.end('404'));
      } else {
        res.writeHead(404); res.end('Not Found');
      }
    }
  }
}).listen(PORT, () => console.log(`SPA server listening on http://localhost:${PORT}`));
