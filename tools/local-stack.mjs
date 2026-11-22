// A throwaway test database and file store on this PC, in Docker, so the checks that need a database
// run without any cloud account. Their data lives in memory and is gone when they stop.
//
//   node tools/local-stack.mjs up     start them (or reuse them) and write .env.local for the tools
//   node tools/local-stack.mjs down   stop and remove them
//
// The database is Postgres 17. The file store is SeaweedFS speaking the S3 protocol the API uses (the
// MinIO images are no longer published), with a login, so signed upload links are checked as the real
// store checks them. .env.local is git-ignored. It is only ever written when it is missing or was
// written by this tool, so a real branch's settings are never overwritten. Passwords are made fresh and
// never printed; the file store's login sits in tools/out (git-ignored).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PG = { name: 'startup-test-pg', image: 'postgres:17', port: 55432 };
const S3 = { name: 'startup-test-s3', image: 'chrislusf/seaweedfs:4.54', port: 59000 };
const ENV_FILE = '.env.local';
const S3_CONFIG = path.resolve('tools/out/local-stack/s3.json');
const MARK = '# written by tools/local-stack.mjs';

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const running = (name) => {
  try { return docker('inspect', '-f', '{{.State.Running}}', name) === 'true'; } catch { return false; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const secret = () => randomBytes(18).toString('base64url');

function readOwnEnv() {
  if (!fs.existsSync(ENV_FILE)) return null;
  const text = fs.readFileSync(ENV_FILE, 'utf8');
  if (!text.startsWith(MARK)) throw new Error(`${ENV_FILE} was not written by this tool; move it aside first (it may point at a real database)`);
  return Object.fromEntries(text.split('\n').filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

async function up() {
  const own = readOwnEnv();
  const reuse = running(PG.name) && running(S3.name) && own?.PG_PASSWORD && own?.AWS_SECRET_ACCESS_KEY;
  const pgPass = reuse ? own.PG_PASSWORD : secret();
  const s3Pass = reuse ? own.AWS_SECRET_ACCESS_KEY : secret();
  if (!reuse) {
    down(true);
    fs.mkdirSync(path.dirname(S3_CONFIG), { recursive: true });
    fs.writeFileSync(S3_CONFIG, JSON.stringify({ identities: [{ name: 'startup',
      credentials: [{ accessKey: 'startup', secretKey: s3Pass }], actions: ['Admin', 'Read', 'List', 'Tagging', 'Write'] }] }));
    docker('run', '-d', '--name', PG.name, '-p', `127.0.0.1:${PG.port}:5432`, '-e', `POSTGRES_PASSWORD=${pgPass}`,
      '-e', 'POSTGRES_DB=startup', '--tmpfs', '/var/lib/postgresql/data:rw', PG.image);
    docker('run', '-d', '--name', S3.name, '-p', `127.0.0.1:${S3.port}:8333`,
      '--mount', `type=bind,source=${S3_CONFIG},target=/etc/s3.json,readonly`, '--tmpfs', '/data:rw',
      S3.image, 'server', '-s3', '-s3.config=/etc/s3.json', '-dir=/data');
  }
  for (let i = 0; ; i++) {
    try { docker('exec', PG.name, 'pg_isready', '-U', 'postgres', '-d', 'startup'); break; } catch {}
    if (i > 60) throw new Error('the test database did not start');
    await sleep(1000);
  }
  const url = `postgres://postgres:${pgPass}@127.0.0.1:${PG.port}/startup`;
  const env = {
    NEON_BRANCH: 'dev',
    DATABASE_URL: url,
    DATABASE_URL_UNPOOLED: url,
    PG_PASSWORD: pgPass,
    AWS_ENDPOINT_URL_S3: `http://127.0.0.1:${S3.port}`,
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'startup',
    AWS_SECRET_ACCESS_KEY: s3Pass,
    // The SDK stamps signed upload links with a checksum of an empty body; SeaweedFS checks it (BadDigest) where
    // Neon's store does not, so the local stack turns that stamp off. The API code is unchanged.
    AWS_REQUEST_CHECKSUM_CALCULATION: 'WHEN_REQUIRED',
    AWS_RESPONSE_CHECKSUM_VALIDATION: 'WHEN_REQUIRED',
    // Where the check tools find the API: the working tree served by `node tools/dev-serve.mjs`.
    // Not 8787: once Docker is up, Windows reserves a block of ports around it (8739-8838 on this PC).
    NEON_FUNCTION_API_BASE_URL: 'http://127.0.0.1:18787',
  };
  fs.writeFileSync(ENV_FILE, `${MARK}. A test stack on this PC; never a real database.\n` +
    Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  // The API's one bucket; the file store takes a few seconds to answer after it starts.
  const { S3Client, CreateBucketCommand } = await import('@aws-sdk/client-s3');
  const s3 = new S3Client({ endpoint: env.AWS_ENDPOINT_URL_S3, region: env.AWS_REGION, forcePathStyle: true,
    credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY } });
  for (let i = 0; ; i++) {
    try { await s3.send(new CreateBucketCommand({ Bucket: 'uploads' })); break; } catch (e) {
      if (/BucketAlready(OwnedByYou|Exists)/.test(e.name)) break;
      if (i > 60) throw new Error(`the test file store did not start: ${e.name}`);
      await sleep(1000);
    }
  }
  console.log(`test database on 127.0.0.1:${PG.port}, file store on 127.0.0.1:${S3.port}; settings in ${ENV_FILE}`);
}

function down(quiet = false) {
  for (const c of [PG.name, S3.name]) {
    try { docker('rm', '-f', c); if (!quiet) console.log(`removed ${c}`); } catch {}
  }
}

const cmd = process.argv[2];
if (cmd === 'up') await up();
else if (cmd === 'down') down();
else { console.error('usage: node tools/local-stack.mjs up | down'); process.exit(2); }
