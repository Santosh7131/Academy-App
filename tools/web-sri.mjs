// Pins the scripts the web app's page loads from other sites (pdf.js, from jsDelivr) with Subresource Integrity hashes: the browser
// then refuses a copy that differs from the one hashed here, so a changed file on the CDN cannot run in the app.
// tools/build-web.ps1 runs it on release builds:  node tools/web-sri.mjs app/build/web/index.html
//
// pdf.js loads its worker and character maps by itself, which no hash can cover; serving pdf.js from the app's own host would.
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const file = process.argv[2];
if (!file) throw new Error('usage: node tools/web-sri.mjs app/build/web/index.html');
let html = fs.readFileSync(file, 'utf8');
const tags = [...html.matchAll(/<script src="(https:\/\/[^"]+)"([^>]*)><\/script>/g)];
for (const [tag, url, rest] of tags) {
  if (rest.includes('integrity=')) continue;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const hash = 'sha384-' + createHash('sha384').update(Buffer.from(await res.arrayBuffer())).digest('base64');
  html = html.replace(tag, `<script src="${url}"${rest} integrity="${hash}" crossorigin="anonymous"></script>`);
  console.log(`pinned ${url}`);
}
fs.writeFileSync(file, html);
