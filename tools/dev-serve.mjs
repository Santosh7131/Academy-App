// Serves the working-tree API over plain HTTP on 127.0.0.1 only, against a dev database (one on this PC from
// tools/local-stack.mjs, or the dev branch DEV_DATABASE_HOST names), with any AI keys from api/.env.secrets, and pushes in
// dry run.
// Usage: node tools/dev-serve.mjs [port]   then   node tools/<suite>.ts --base http://127.0.0.1:18787
// The port is 18787 unless given: a debug build of either app looks for http://10.0.2.2:18787, which is this PC as the
// Android emulator sees it.
import fs from 'node:fs';
import http from 'node:http';
import { Readable } from 'node:stream';
import { parseEnv } from 'node:util';

process.loadEnvFile('.env.local');
try { process.loadEnvFile('api/.env.secrets'); } catch {}
// api/.env.dev-keys (git-ignored), when present, holds dev's own AI keys, so tests never spend live's allowance.
let whose = 'from api/.env.secrets';
try {
  const own = parseEnv(fs.readFileSync('api/.env.dev-keys', 'utf8'));
  if (own.GEMINI_API_KEY) process.env.GEMINI_API_KEY = own.GEMINI_API_KEY;
  if (own.GROQ_API_KEYS) process.env.GROQ_API_KEYS = own.GROQ_API_KEYS;
  whose = "dev's own";
} catch {}
// Dev only: a database on this PC (tools/local-stack.mjs), or the dev branch whose host DEV_DATABASE_HOST names.
const devHosts = ['127.0.0.1', 'localhost', process.env.DEV_DATABASE_HOST].filter(Boolean);
for (const k of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED']) {
  let host = '';
  try { host = new URL(String(process.env[k])).hostname; } catch {}
  if (process.env.NEON_BRANCH !== 'dev' || !devHosts.includes(host)) throw new Error(`${k} is not a dev database: refusing to start`);
}
process.env.PUSH_DRY_RUN = '1';

const { default: app } = await import('../api/src/index.ts');
const port = Number(process.argv[2] ?? 18787);

const server = http.createServer(async (req, res) => {
  try {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const request = new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: 'half' });
    const response = await app.fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).pipe(res);
    else res.end();
  } catch (e) {
    console.error('bridge error:', e);
    if (!res.headersSent) res.writeHead(500);
    res.end('bridge error');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`dev api (working tree) on http://127.0.0.1:${port}; AI keys: ${(process.env.GROQ_API_KEYS ?? '').split(',').filter(Boolean).length} Groq, Gemini ${process.env.GEMINI_API_KEY ? 'set' : 'not set'} (${whose}); pushes in dry run`));
