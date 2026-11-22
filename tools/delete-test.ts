// Checks deleting a tuition (POST /teacher/tuition/delete): only its owner, only with the owner's password; every row of the tuition
// goes, the tests first so their questions can follow; the people who were in no other tuition lose their accounts and old logins,
// while a student who is also in another tuition keeps the account, that tuition and the results written there; the other tuition
// is untouched; the money that came in stays on record with the tuition's name; and storage is emptied. The API runs in this process
// against the dev database and the local storage (tools/local-stack.mjs). Makes its own tutors and tuitions and removes them again.
// Dev only.
// Usage: node tools/delete-test.ts
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

process.loadEnvFile('.env.local');
try { process.loadEnvFile('api/.env.secrets'); } catch {}
const devHosts = ['127.0.0.1', 'localhost', process.env.DEV_DATABASE_HOST].filter(Boolean);
const dbHost = (() => { try { return new URL(String(process.env.DATABASE_URL)).hostname; } catch { return ''; } })();
if (process.env.NEON_BRANCH !== 'dev' || !devHosts.includes(dbHost)) throw new Error('This only runs against a dev database.');
process.env.PUSH_DRY_RUN = '1';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `  -> ${JSON.stringify(detail)}`}`);
}

const { default: app } = await import('../api/src/index.ts');
const { listObjects, putObject } = await import('../api/src/lib/storage.ts');
const logins = JSON.parse(readFileSync('tools/out/sample-logins.dev.json', 'utf8'));
const MATHS = '00000000-0000-4000-8000-000000000001';

async function api(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.fetch(new Request(`http://test${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-app': 'tuition_app/1.9.0+13',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }));
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const code = (r: { body: any }) => r.body?.error?.code;
const login = (username: string, secret: string) => api('POST', '/auth/login', undefined, { username, secret });
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

const db = new pg.Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
await db.connect();
const n = async (sql: string, args: unknown[]) => Number((await db.query(sql, args)).rows[0].n);

const tag = `del${randomInt(1000, 9999)}`;
const created = { users: [] as string[], tuitions: [] as string[] };
const PASSWORD = 'longenough1';

/** A tutor who signs up and opens a tuition with Class 9 Maths. */
async function newTutor(suffix: string) {
  const su = await api('POST', '/auth/signup-tutor', undefined, { display_name: `Delete ${suffix}`, username: `${tag}.${suffix}`, password: PASSWORD }, { 'x-install-id': `${tag}-${suffix}` });
  if (su.status !== 201) throw new Error(`sign-up failed: ${JSON.stringify(su.body)}`);
  created.users.push(su.body.user.id);
  const T = su.body.token as string;
  const mk = await api('POST', '/auth/tuitions', T, { name: `${tag} ${suffix}`, groups: [{ class_level: 9, subject_id: MATHS }] });
  if (mk.status !== 201) throw new Error(`tuition failed: ${JSON.stringify(mk.body)}`);
  created.tuitions.push(mk.body.tuition.id);
  return { T, user: su.body.user.id as string, tuition: mk.body.tuition.id as string, name: `${tag} ${suffix}` };
}

/** A published Class 9 Maths test of one question in the tuition [T] is for, assigned to the group. */
async function newTest(T: string, label: string) {
  const qn = await api('POST', '/teacher/questions', T, { class_level: 9, text: `${tag} ${label} question: $1+1$?`, options: ['1', '2', '3', '4'], correct_option: 1, subject_id: MATHS });
  if (qn.status !== 201) throw new Error(`question failed: ${JSON.stringify(qn.body)}`);
  const t = await api('POST', '/teacher/tests', T, {
    title: `${tag} ${label} test`, class_level: 9, subject_id: MATHS, question_ids: [qn.body.id], shuffle: false, assign_all: false, assign_group: true, closes_at: iso(86_400_000),
  });
  if (t.status !== 201) throw new Error(`test failed: ${JSON.stringify(t.body)}`);
  await api('POST', `/teacher/tests/${t.body.id}/publish`, T, { published: true });
  return { test: t.body.id as string, question: qn.body.id as string };
}

/** The student [S] writes and hands in [test], in the tuition [tuition]. Returns the attempt. */
async function write(S: string, tuition: string, t: { test: string; question: string }) {
  const started = await api('POST', `/student/tests/${t.test}/start`, S, undefined, { 'x-tuition': tuition });
  if (started.status !== 200 && started.status !== 201) throw new Error(`start failed: ${JSON.stringify(started.body)}`);
  const id = started.body.attempt.id as string;
  const done = await api('POST', `/student/attempts/${id}/submit`, S, { answers: [{ question_id: t.question, choice: 1 }] }, { 'x-tuition': tuition });
  if (done.status !== 200) throw new Error(`submit failed: ${JSON.stringify(done.body)}`);
  return id;
}

try {
  const devLogin = await login(logins.developer.username, logins.developer.password);
  const DEV = devLogin.body?.token as string;
  check('the developer logs in', !!DEV, devLogin.body);

  // ---------------------------------------------------------------- two tuitions, and people in them
  const A = await newTutor('a');
  const B = await newTutor('b');
  const addStudent = async (T: string, who: string) => {
    const r = await api('POST', '/teacher/students', T, { display_name: `Delete ${who}`, class_level: 9, username: `${tag}.${who}`, pin: '1357', subject_ids: [MATHS] });
    if (r.status !== 201) throw new Error(`student failed: ${JSON.stringify(r.body)}`);
    created.users.push(r.body.student.id);
    return r.body.student.id as string;
  };
  const only = await addStudent(A.T, 'only');
  const both = await addStudent(A.T, 'both');
  const S_ONLY = (await login(`${tag}.only`, '1357')).body.token as string;
  const S_BOTH = (await login(`${tag}.both`, '1357')).body.token as string;
  const joinB = (await db.query('select join_code from tuitions where id = $1', [B.tuition])).rows[0].join_code as string;
  const asked = await api('POST', '/student/join', S_BOTH, { code: joinB });
  const let_in = await api('POST', `/teacher/join-requests/${both}/accept`, B.T, { class_level: 9, subject_ids: [MATHS] });
  check('a student of A joins B as well', asked.status === 201 && let_in.status === 200, { asked: asked.body, let_in: let_in.body });

  // A student whose only link to A is a request to join it that is still waiting: made by B, asked to join A, then let go by B.
  const asker = await addStudent(B.T, 'asker');
  await db.query(`insert into memberships (tuition_id, user_id, role, status, class_level) values ($1, $2, 'student', 'pending', 9)`, [A.tuition, asker]);
  await db.query('delete from memberships where tuition_id = $1 and user_id = $2', [B.tuition, asker]);

  // A tutor who is in A without owning it, as a second tutor would be.
  const su = await api('POST', '/auth/signup-tutor', undefined, { display_name: 'Delete helper', username: `${tag}.helper`, password: PASSWORD }, { 'x-install-id': `${tag}-helper` });
  created.users.push(su.body.user.id);
  const helper = su.body.user.id as string;
  await db.query(`insert into memberships (tuition_id, user_id, role, status) values ($1, $2, 'tutor', 'active')`, [A.tuition, helper]);
  const HELPER = (await login(`${tag}.helper`, PASSWORD)).body.token as string;

  // Work in both: a test written by both students in A, and by the shared student in B.
  const testA = await newTest(A.T, 'A');
  const testB = await newTest(B.T, 'B');
  await write(S_ONLY, A.tuition, testA);
  await write(S_BOTH, A.tuition, testA);
  const attemptB = await write(S_BOTH, B.tuition, testB);

  // A paper with a page in storage, a question picture and a Library file under A's own prefixes.
  const paper = await api('POST', '/teacher/papers', A.T, { pages: 1, class_level: 9, subject_id: MATHS });
  const put = await fetch(paper.body.uploads[0].put_url, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...randomBytes(64)]) });
  await api('POST', `/teacher/papers/${paper.body.paper.id}/pages/1/uploaded`, A.T);
  const picture = `questions/${A.tuition}/${randomUUID()}.jpg`;
  const shelfFile = `library/${A.tuition}/${randomUUID()}.pdf`;
  await putObject(picture, Buffer.from('picture'), 'image/jpeg');
  await putObject(shelfFile, Buffer.from('%PDF-1.4'), 'application/pdf');
  const pageKey = `papers/${paper.body.paper.id}/`;
  check('A has a page, a picture and a Library file in storage', put.ok && (await listObjects(pageKey)).length === 1 && (await listObjects(`questions/${A.tuition}/`)).length === 1 && (await listObjects(`library/${A.tuition}/`)).length === 1);
  const pictureB = `questions/${B.tuition}/${randomUUID()}.jpg`;
  await putObject(pictureB, Buffer.from('picture'), 'image/jpeg');

  // Money in: the developer adds ₹50 by hand to A. A also has its free start, which is not money that came in.
  const byHand = await api('POST', `/admin/clients/${A.tuition}/credit`, DEV, { amount_paise: 5000, ref: `${tag}-ref` });
  check('the developer adds credit to A by hand', byHand.status === 201, byHand.body);

  const countB = async () => ({
    tests: await n('select count(*) as n from tests where tuition_id = $1', [B.tuition]),
    questions: await n('select count(*) as n from questions where tuition_id = $1', [B.tuition]),
    members: await n(`select count(*) as n from memberships where tuition_id = $1`, [B.tuition]),
    attempts: await n('select count(*) as n from attempts a join tests t on t.id = a.test_id where t.tuition_id = $1', [B.tuition]),
    ledger: await n('select count(*) as n from credit_ledger where tuition_id = $1', [B.tuition]),
  });
  const bBefore = await countB();

  // ---------------------------------------------------------------- who may delete it
  const del = (token: string | undefined, body: unknown, tuition = A.tuition) => api('POST', '/teacher/tuition/delete', token, body, { 'x-tuition': tuition });
  const anon = await del(undefined, { secret: PASSWORD });
  check('without a login it is refused', anon.status === 401, anon.body);
  const asStudent = await del(S_ONLY, { secret: '1357' });
  check('a student cannot delete the tuition', asStudent.status === 403, asStudent.body);
  const asHelper = await del(HELPER, { secret: PASSWORD });
  check('a tutor who does not own it cannot delete it', asHelper.status === 403 && code(asHelper) === 'not_owner', asHelper.body);
  const asB = await del(B.T, { secret: PASSWORD });
  check('the owner of another tuition cannot delete it', asB.status === 403 && code(asB) !== 'wrong_password', asB.body);
  const noSecret = await del(A.T, {});
  check('without the password it is refused', noSecret.status === 400, noSecret.body);
  const wrong = await del(A.T, { secret: 'not-the-password' });
  check('with a wrong password it is refused, and not as a lost session', wrong.status === 403 && code(wrong) === 'wrong_password', wrong.body);
  check('the wrong password counts as a wrong try', (await n('select failed_count as n from users where id = $1', [A.user])) === 1);
  check('nothing was deleted yet', (await n('select count(*) as n from tuitions where id = $1', [A.tuition])) === 1);

  // ---------------------------------------------------------------- the owner deletes it
  const ok = await del(A.T, { secret: PASSWORD });
  check('the owner deletes the tuition with their password', ok.status === 200 && ok.body.ok === true, ok.body);
  check('the owner is told their account went too', ok.body?.account_deleted === true && ok.body?.accounts_deleted === 3, ok.body);
  check('the tuition is gone', (await n('select count(*) as n from tuitions where id = $1', [A.tuition])) === 0);
  for (const [table, sql] of [
    ['tests', 'select count(*) as n from tests where tuition_id = $1'],
    ['questions', 'select count(*) as n from questions where tuition_id = $1'],
    ['papers', 'select count(*) as n from papers where tuition_id = $1'],
    ['groups', 'select count(*) as n from groups where tuition_id = $1'],
    ['memberships', 'select count(*) as n from memberships where tuition_id = $1'],
    ['attempts', `select count(*) as n from attempts where test_id = '${testA.test}'`],
  ] as const) {
    check(`none of its ${table} are left`, (await n(sql, sql.includes('$1') ? [A.tuition] : [])) === 0);
  }
  check('the owner, the helper and the student who was only there lose their accounts',
    (await n('select count(*) as n from users where id = any($1::uuid[])', [[A.user, helper, only]])) === 0);
  check('the student who is also in B keeps the account', (await n('select count(*) as n from users where id = $1', [both])) === 1);
  check('someone who had only asked to join keeps their account', (await n('select count(*) as n from users where id = $1', [asker])) === 1);
  check('and their place in B', (await n(`select count(*) as n from memberships where user_id = $1 and tuition_id = $2 and status = 'active'`, [both, B.tuition])) === 1);
  check('and the result they wrote in B', (await n('select count(*) as n from attempts where id = $1', [attemptB])) === 1);
  check('B is untouched', JSON.stringify(await countB()) === JSON.stringify(bBefore), { before: bBefore, after: await countB() });

  const gone = await api('GET', '/teacher/home', A.T);
  check('the owner\'s old login stops working', gone.status === 401, gone.body);
  check('so does the deleted student\'s', (await api('GET', '/student/home', S_ONLY)).status === 401);
  const stillB = await api('GET', '/student/home', S_BOTH, undefined, { 'x-tuition': B.tuition });
  check('the student in B still uses B', stillB.status === 200, stillB.body);
  check('B\'s owner still works', (await api('GET', '/teacher/home', B.T)).status === 200);

  // The money that came in stays on record, under the tuition's name; the free start goes.
  const kept = (await db.query(`select kind, amount_paise, client_name, tuition_id from credit_ledger where ref = $1`, [`${tag}-ref`])).rows;
  check('the credit added by hand stays on record with the tuition\'s name', kept.length === 1 && kept[0].kind === 'by_hand' && kept[0].amount_paise === 5000 && kept[0].client_name === A.name && kept[0].tuition_id === null, kept);
  check('no other line of its credit is left', (await n(`select count(*) as n from credit_ledger where tuition_id is null and client_name = $1 and kind not in ('topup', 'by_hand')`, [A.name])) === 0);

  check('its paper pages are gone from storage', (await listObjects(pageKey)).length === 0);
  check('its question pictures are gone', (await listObjects(`questions/${A.tuition}/`)).length === 0);
  check('its Library files are gone', (await listObjects(`library/${A.tuition}/`)).length === 0);
  check('B\'s pictures are still there', (await listObjects(`questions/${B.tuition}/`)).length === 1);

  const clients = await api('GET', '/admin/clients', DEV);
  check('the developer no longer sees it among the clients', clients.status === 200 && !clients.body.clients.some((c: any) => c.id === A.tuition), clients.status);
  const again = await login(`${tag}.a`, PASSWORD);
  check('the owner cannot log in any more', again.status === 401, again.body);

  // The owner of a tuition who is also a tutor in another keeps the account when they delete their own.
  const C = await newTutor('c');
  await db.query(`insert into memberships (tuition_id, user_id, role, status) values ($1, $2, 'tutor', 'active')`, [B.tuition, C.user]);
  const cGone = await del(C.T, { secret: PASSWORD }, C.tuition);
  check('an owner who also tutors elsewhere deletes their tuition and keeps the account', cGone.status === 200 && cGone.body.account_deleted === false && (await n('select count(*) as n from users where id = $1', [C.user])) === 1, cGone.body);
  check('and still tutors in the other tuition', (await api('GET', '/teacher/home', C.T, undefined, { 'x-tuition': B.tuition })).status === 200);
} catch (e) {
  check('the run finished without an error', false, String((e as Error)?.stack ?? e));
} finally {
  // Whatever is left of the test data: the tests first, as the route does.
  await db.query('delete from tests where tuition_id = any($1::uuid[])', [created.tuitions]).catch(() => {});
  await db.query('delete from tuitions where id = any($1::uuid[])', [created.tuitions]).catch(() => {});
  await db.query('delete from users where id = any($1::uuid[])', [created.users]).catch(() => {});
  await db.query(`delete from credit_ledger where tuition_id is null and client_name like $1`, [`${tag} %`]).catch(() => {});
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
