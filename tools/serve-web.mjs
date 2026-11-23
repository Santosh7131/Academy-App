// Serves the web app's build (app/build/web) on this computer, to try it in a browser against the local API.
//
//   .\tools\build-web.ps1 -ApiBase http://127.0.0.1:18787 -Local
//   node tools/serve-web.mjs                       # http://127.0.0.1:18790 (PORT=... for another)
//
// The local API lets the page in only when it was started with CORS_ORIGINS naming this address:
//   CORS_ORIGINS=http://127.0.0.1:18790 node tools/dev-serve.mjs
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../app/build/web', import.meta.url));
const port = Number(process.env.PORT ?? 18790);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

if (!fs.existsSync(path.join(root, 'index.html'))) {
  console.error('There is no app/build/web/index.html: build it first with tools/build-web.ps1.');
  process.exit(1);
}

http
  .createServer((req, res) => {
    let p;
    try {
      p = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    } catch {
      return res.writeHead(400).end();
    }
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(root, p);
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      // No caching here: every build replaces the files under the same names.
      res.writeHead(200, {
        'content-type': types[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': st.size,
        'cache-control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  })
  .listen(port, '127.0.0.1', () => console.log(`The web app: http://127.0.0.1:${port}`));
