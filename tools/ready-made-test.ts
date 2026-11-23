// Checks ready-made questions end to end (routes/ready-made.ts, lib/ready-made.ts, api/src/ready-made): what a group is offered
// (a book for its class and subject, or none), adding a book copies its chapters and questions into the tuition as its own, in the
// book's order and with the answers tools/check-library.ts proved; adding again adds only what is missing and never changes a
// question the tutor changed; a chapter the tuition already has is used as it is; each tuition has its own copy; a subject named
// Mathematics finds the Maths book; a student, a group the tuition does not have and bad input are refused; worked solutions for
// them cost nothing. The API runs in this process against the dev database. Makes its own tutors, tuitions and students and
// removes them again. Dev only.
// Usage: node tools/ready-made-test.ts
import { randomInt } from 'node:crypto';
import pg from 'pg';
import { arrange, books } from '../api/src/ready-made/index.ts';

process.loadEnvFile('.env.local');
try { process.loadEnvFile('api/.env.secrets'); } catch {}
// Dev only: a database on this PC (tools/local-stack.mjs), or the dev branch whose host DEV_DATABASE_HOST names.
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

const db = new pg.Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
await db.connect();
const count = async (sql: string, params: unknown[]) => Number((await db.query(sql, params)).rows[0].n);
const SCIENCE = (await db.query(`select id from subjects where tuition_id is null and name = 'Science'`)).rows[0]?.id as string;

const tag = `rm${randomInt(1000, 9999)}`;
const created = { users: [] as string[], tuitions: [] as string[] };

/** A tutor who signs up and opens a tuition with Class 9 Maths, Class 9 Science and Class 10 Maths. */
async function newTutor(suffix: string) {
  const su = await api('POST', '/auth/signup-tutor', undefined, { display_name: `Ready ${suffix}`, username: `${tag}.${suffix}`, password: 'longenough1' }, { 'x-install-id': `${tag}-${suffix}` });
  if (su.status !== 201) throw new Error(`sign-up failed: ${JSON.stringify(su.body)}`);
  created.users.push(su.body.user.id);
  const T = su.body.token as string;
  const groups = [{ class_level: 9, subject_id: MATHS }, { class_level: 9, subject_id: SCIENCE }, { class_level: 10, subject_id: MATHS }];
  const mk = await api('POST', '/auth/tuitions', T, { name: `${tag} ${suffix}`, groups });
  if (mk.status !== 201) throw new Error(`tuition failed: ${JSON.stringify(mk.body)}`);
  created.tuitions.push(mk.body.tuition.id);
  return { T, tuition: mk.body.tuition.id as string, user: su.body.user.id as string };
}

const book = (cls: number, subject: string) => books.find((b) => b.classLevel === cls && b.subject === subject)!;
const total = (b: (typeof books)[number]) => b.chapters.reduce((n, ch) => n + ch.questions.length, 0);
const offer = async (T: string, cls: number, subject: string) => api('GET', `/teacher/ready-made?class=${cls}&subject=${subject}`, T);
const add = async (T: string, cls: number, subject: string) => api('POST', '/teacher/ready-made', T, { class_level: cls, subject_id: subject });
const readyCount = (tuition: string, cls: number, subject: string) =>
  count(`select count(*)::int as n from questions where tuition_id = $1 and class_level = $2 and subject_id = $3 and source = 'library'`, [tuition, cls, subject]);

try {
  if (!SCIENCE) throw new Error('No standard Science subject in this database.');

  // ---------------------------------------------------------------- the books the server carries
  const all = books.reduce((n, b) => n + total(b), 0);
  check('the server carries six books of 830 questions', books.length === 6 && all === 830, { books: books.length, all });
  const m9 = book(9, 'Maths');
  const s9 = book(9, 'Science');
  const m10 = book(10, 'Maths');

  const A = await newTutor('a');

  // ---------------------------------------------------------------- what a group is offered
  const o1 = await offer(A.T, 9, MATHS);
  check('9th Maths is offered its book', o1.status === 200 && o1.body.ready?.questions === total(m9) && o1.body.ready?.chapters === m9.chapters.length && o1.body.ready?.added === 0, o1.body);
  check('named for the record', o1.body.ready?.book === m9.book, o1.body.ready?.book);
  const g11 = await api('POST', '/teacher/groups', A.T, { class_level: 11, subject_id: MATHS });
  check('a class with no book is offered none', g11.status === 201 && (await offer(A.T, 11, MATHS)).body?.ready === null);
  check('a group the tuition does not have is not found', (await offer(A.T, 8, MATHS)).status === 404);
  check('the class must be a class', (await offer(A.T, 0, MATHS)).status === 400);
  check('the subject must be an id', (await offer(A.T, 9, 'maths')).status === 400);
  check('a class and subject must be named', (await api('GET', '/teacher/ready-made', A.T)).status === 400);

  // ---------------------------------------------------------------- adding a book
  const a1 = await add(A.T, 9, MATHS);
  check('adding 9th Maths adds every question of its book', a1.status === 200 && a1.body.added === total(m9) && a1.body.ready?.added === total(m9), a1.body);
  check('as the tuition\'s own ready-made questions', (await readyCount(A.tuition, 9, MATHS)) === total(m9));
  const chapters = (await db.query('select name, sort_order from chapters where tuition_id = $1 and class_level = 9 and subject_id = $2 order by sort_order', [A.tuition, MATHS])).rows;
  check("with the book's chapters in its order", chapters.map((c) => c.name).join('|') === m9.chapters.map((c) => c.name).join('|'), chapters.map((c) => c.name));
  const rows = (await db.query(
    `select qq.text, qq.options, qq.correct_option, qq.solution, qq.created_by, qq.difficulty, qq.marks::int as marks, ch.name as chapter
       from questions qq join chapters ch on ch.id = qq.chapter_id where qq.tuition_id = $1 and qq.source = 'library' and qq.class_level = 9`,
    [A.tuition],
  )).rows;
  const byText = new Map(rows.map((r) => [r.text, r]));
  let right = 0;
  for (const ch of m9.chapters) {
    for (const qq of ch.questions) {
      const r = byText.get(qq.text);
      const { options, correct } = arrange(qq);
      if (r && r.chapter === ch.name && r.correct_option === correct && JSON.stringify(r.options) === JSON.stringify(options) && r.solution === qq.solution) right++;
    }
  }
  check('each in its chapter, with the proved answer and its worked solution', right === total(m9), { right, of: total(m9) });
  check('one mark each, at Medium, made by the tutor who added them', rows.every((r) => r.marks === 1 && r.difficulty === 'medium' && r.created_by === A.user));

  // ---------------------------------------------------------------- the question picker lists them
  const picker = await api('GET', `/teacher/questions?class=9&subject=${MATHS}`, A.T);
  const listed = (picker.body?.questions ?? []).filter((x: any) => x.source === 'library');
  check('the picker lists them as ready-made', picker.status === 200 && listed.length === total(m9), listed.length);
  const first = m9.chapters[0];
  check("in the book's order", listed[0]?.text === first.questions[0].text && listed[1]?.text === first.questions[1].text && listed[first.questions.length]?.text === m9.chapters[1].questions[0].text,
    listed.slice(0, 2).map((x: any) => x.text));

  // ---------------------------------------------------------------- adding again
  const a2 = await add(A.T, 9, MATHS);
  check('adding again adds nothing', a2.status === 200 && a2.body.added === 0 && (await readyCount(A.tuition, 9, MATHS)) === total(m9), a2.body);
  const one = listed[3];
  const patched = await api('PATCH', `/teacher/questions/${one.id}`, A.T, { ...one, marks: Number(one.marks), solution: 'The tutor wrote this one.' });
  const gone = listed[4];
  const del = await api('DELETE', `/teacher/questions/${gone.id}`, A.T);
  check('a ready-made question can be changed and deleted like any other', patched.status === 200 && del.status === 200, [patched.status, patched.body, del.status]);
  check('the offer counts what is left', (await offer(A.T, 9, MATHS)).body?.ready?.added === total(m9) - 1);
  const a3 = await add(A.T, 9, MATHS);
  const kept = (await db.query('select solution from questions where id = $1', [one.id])).rows[0]?.solution;
  check('adding again brings back only the deleted one', a3.body?.added === 1 && (await readyCount(A.tuition, 9, MATHS)) === total(m9), a3.body);
  check("and leaves the tutor's change as it is", kept === 'The tutor wrote this one.', kept);

  // ---------------------------------------------------------------- a chapter the tuition already has
  const mine = await db.query(
    `insert into chapters (tuition_id, class_level, subject_id, name, sort_order) values ($1, 10, $2, $3, 40) returning id`,
    [A.tuition, MATHS, m10.chapters[0].name],
  );
  const a4 = await add(A.T, 10, MATHS);
  const ch10 = await count('select count(*)::int as n from chapters where tuition_id = $1 and class_level = 10 and subject_id = $2 and name = $3', [A.tuition, MATHS, m10.chapters[0].name]);
  const inMine = await count(`select count(*)::int as n from questions where chapter_id = $1 and source = 'library'`, [mine.rows[0].id]);
  const order = (await db.query('select sort_order from chapters where id = $1', [mine.rows[0].id])).rows[0].sort_order;
  check('10th Maths is added too', a4.status === 200 && a4.body.added === total(m10), a4.body);
  check('into the chapter of that name the tuition already had, left in its place', ch10 === 1 && inMine === m10.chapters[0].questions.length && order === 40, { ch10, inMine, order });
  check('9th Science gets its own book', (await add(A.T, 9, SCIENCE)).body?.added === total(s9) && (await readyCount(A.tuition, 9, SCIENCE)) === total(s9));
  check('a class with no book cannot be added', code(await add(A.T, 11, MATHS)) === 'no_ready_made');
  check('nor a group the tuition does not have', (await add(A.T, 8, MATHS)).status === 404);
  check('a body must name the class', (await api('POST', '/teacher/ready-made', A.T, { subject_id: MATHS })).status === 400);

  // ---------------------------------------------------------------- worked solutions for them cost nothing
  const pick = listed.slice(0, 2).map((x: any) => x.id);
  const mk = await api('POST', '/teacher/tests', A.T, {
    title: `${tag} Ready-made test`, class_level: 9, subject_id: MATHS, question_ids: pick, shuffle: true, assign_all: false, assign_group: true,
  });
  check('a test is made of ready-made questions', mk.status === 201, mk.body);
  const before = await count(`select count(*)::int as n from credit_ledger where tuition_id = $1`, [A.tuition]);
  const sol = await api('POST', `/teacher/tests/${mk.body?.id}/solutions`, A.T, { question_ids: pick });
  const after = await count(`select count(*)::int as n from credit_ledger where tuition_id = $1`, [A.tuition]);
  check('asking AI for their worked solutions writes none and charges nothing', sol.status === 200 && sol.body.solutions.every((x: any) => x.outcome === 'has_solution') && after === before, [sol.status, sol.body, before, after]);

  // ---------------------------------------------------------------- each tuition has its own copy
  const B = await newTutor('b');
  check("another tuition starts with none of them", (await offer(B.T, 9, MATHS)).body?.ready?.added === 0);
  const b1 = await add(B.T, 9, MATHS);
  const shared = await count(
    `select count(*)::int as n from questions a join questions b on a.text = b.text and a.id <> b.id
      where a.tuition_id = $1 and b.tuition_id = $2 and a.source = 'library' and b.source = 'library' and a.library_key = b.library_key`,
    [A.tuition, B.tuition],
  );
  check('and gets its own copies when it adds the book', b1.body?.added === total(m9) && shared === 0 && (await readyCount(A.tuition, 9, MATHS)) === total(m9), { added: b1.body?.added, shared });
  const bPicker = await api('GET', `/teacher/questions?class=9&subject=${MATHS}`, B.T);
  check("its picker lists only its own", (bPicker.body?.questions ?? []).every((x: any) => !listed.some((y: any) => y.id === x.id)));

  // ---------------------------------------------------------------- a subject named Mathematics finds the Maths book
  const own = await api('POST', '/teacher/subjects', B.T, { name: 'Mathematics' });
  const g8 = own.status === 201 ? await api('POST', '/teacher/groups', B.T, { class_level: 8, subject_id: own.body.subject?.id ?? own.body.id }) : own;
  const o8 = await offer(B.T, 8, own.body?.subject?.id ?? own.body?.id);
  check('a subject of its own named Mathematics is offered the Maths book', own.status === 201 && g8.status === 201 && o8.body?.ready?.questions === total(book(8, 'Maths')), [own.status, own.body, g8.status, o8.body]);

  // ---------------------------------------------------------------- only tutors
  const st = await api('POST', '/teacher/students', A.T, { display_name: `${tag} Student`, class_level: 9, username: `${tag}.s`, pin: '2468', subject_ids: [MATHS] });
  if (st.body?.student?.id) created.users.push(st.body.student.id);
  const sToken = (await api('POST', '/auth/login', undefined, { username: `${tag}.s`, secret: '2468' })).body?.token as string;
  check('a student cannot see the offer', (await offer(sToken, 9, MATHS)).status === 403);
  check('nor add a book', (await add(sToken, 9, MATHS)).status === 403);
  check('nor can someone signed out', (await offer('', 9, MATHS)).status === 401);
} catch (e) {
  fail++;
  console.log(`FAIL  the run stopped: ${(e as Error).stack ?? e}`);
} finally {
  // What this run made goes: the tests first, as the route that deletes a tuition does.
  if (created.tuitions.length) await db.query('delete from tests where tuition_id = any($1::uuid[])', [created.tuitions]).catch(() => {});
  if (created.tuitions.length) await db.query('delete from tuitions where id = any($1::uuid[])', [created.tuitions]);
  if (created.users.length) await db.query('delete from users where id = any($1::uuid[])', [created.users]);
  await db.query('delete from users where username like $1', [`${tag}.%`]);
  const left = await count(`select count(*)::int as n from questions where library_key like 'ready:%' and tuition_id = any($1::uuid[])`, [created.tuitions]);
  if (left) console.log(`NOTE  ${left} ready-made questions were left behind`);
  await db.end();
  const { pool } = await import('../api/src/lib/db.ts');
  await pool.end().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
