// Checks questions with five or six options end to end: what a tutor may write, how a student takes and is marked on one, what the results
// page counts, and that an app from before build 13 (which has four slots) is never sent one. It makes its own tutor, students and tests and
// removes them again. No AI is called.
// Usage: node tools/options-test.ts [--env .env.local] [--base http://127.0.0.1:8787]
import { randomInt } from 'node:crypto';
import pg from 'pg';

const args = process.argv.slice(2);
const envFile = args.includes('--env') ? args[args.indexOf('--env') + 1] : '.env.local';
process.loadEnvFile(envFile);
const BASE = (args.includes('--base') ? args[args.indexOf('--base') + 1] : process.env.NEON_FUNCTION_API_BASE_URL ?? '').replace(/\/$/, '');
if (!BASE) throw new Error(`No API base URL (pass --base or set NEON_FUNCTION_API_BASE_URL in ${envFile}).`);
const MATHS = '00000000-0000-4000-8000-000000000001';
const NEW_APP = 'tuition_app/1.9.0+13';
const OLD_APP = 'tuition_app/1.8.2+12';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `  -> ${JSON.stringify(detail).slice(0, 300)}`}`);
}

async function api(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = { 'x-app': NEW_APP }) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json: any = await res.json().catch(() => null);
  return { status: res.status, body: json };
}
const code = (r: { body: any }) => r.body?.error?.code;
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const old = { 'x-app': OLD_APP };
const none = {};

const tag = `opt${randomInt(1000, 9999)}`;
const created = { users: [] as string[], tuitions: [] as string[], questions: [] as string[], tests: [] as string[] };
const db = new pg.Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
await db.connect();

try {
  const su = await api('POST', '/auth/signup-tutor', undefined, { display_name: 'Options Tutor', username: `${tag}.t`, password: 'longenough1' }, { 'x-install-id': `${tag}-t`, 'x-app': NEW_APP });
  check('a tutor signs up', su.status === 201, su.body);
  created.users.push(su.body.user.id);
  const T = su.body.token as string;
  const mk = await api('POST', '/auth/tuitions', T, { name: `${tag} Tuition`, groups: [{ class_level: 9, subject_id: MATHS }] });
  check('and starts a tuition with Class 9', mk.status === 201, mk.body);
  created.tuitions.push(mk.body.tuition.id);

  // ------------------------------------------------------------------ what a tutor may write
  const five = ['one', 'two', 'three', 'four', 'five'];
  const stored = async (id: string) => (await api('GET', `/teacher/questions/${id}`, T)).body?.question;
  const q5 = await api('POST', '/teacher/questions', T, { class_level: 9, text: `${tag} five options?`, options: five, correct_option: 4, subject_id: MATHS });
  created.questions.push(q5.body.id);
  const s5q = await stored(q5.body.id);
  check('a question with five options can be written, the right one the fifth', q5.status === 201 && s5q?.options?.length === 5 && s5q.correct_option === 4, [q5.status, s5q]);
  const q6 = await api('POST', '/teacher/questions', T, { class_level: 9, text: `${tag} six options?`, options: [...five, 'six'], correct_option: 5, subject_id: MATHS });
  created.questions.push(q6.body.id);
  const s6q = await stored(q6.body.id);
  check('and one with six', q6.status === 201 && s6q?.options?.length === 6 && s6q.correct_option === 5, [q6.status, s6q]);
  const q4 = await api('POST', '/teacher/questions', T, { class_level: 9, text: `${tag} four options?`, options: ['a', 'b', 'c', 'd'], correct_option: 2, subject_id: MATHS });
  created.questions.push(q4.body.id);
  const s4q = await stored(q4.body.id);
  check('and one with four, as always', q4.status === 201 && s4q?.options?.length === 4, [q4.status, s4q]);

  const bad = (name: string, over: Record<string, unknown>) =>
    api('POST', '/teacher/questions', T, { class_level: 9, text: `${tag} bad`, options: five, correct_option: 0, subject_id: MATHS, ...over }).then((r) => check(name, r.status === 400, r.body));
  await bad('three options are refused', { options: ['a', 'b', 'c'], correct_option: 0 });
  await bad('seven options are refused', { options: [...five, 'six', 'seven'], correct_option: 0 });
  await bad('an empty option is refused', { options: ['a', 'b', 'c', 'd', ''], correct_option: 0 });
  await bad('a right option past the last one is refused', { options: five, correct_option: 5 });
  await bad('a right option of 6 is refused', { options: [...five, 'six'], correct_option: 6 });
  await bad('the fifth cannot be right in a question of four', { options: ['a', 'b', 'c', 'd'], correct_option: 4 });
  const edit = await api('PATCH', `/teacher/questions/${q5.body.id}`, T, { class_level: 9, text: `${tag} five options, now four?`, options: ['a', 'b', 'c', 'd'], correct_option: 3, subject_id: MATHS });
  const down = await stored(q5.body.id);
  check('a question can be edited down to four', edit.status === 200 && down?.options?.length === 4 && down.correct_option === 3, [edit.status, down]);
  const edit2 = await api('PATCH', `/teacher/questions/${q5.body.id}`, T, { class_level: 9, text: `${tag} five options again?`, options: five, correct_option: 4, subject_id: MATHS });
  const up = await stored(q5.body.id);
  check('and back up to five', edit2.status === 200 && up?.options?.length === 5 && up.correct_option === 4, [edit2.status, up]);

  // ------------------------------------------------------------------ the old app is never sent one
  const list = await api('GET', '/teacher/questions', T);
  check('the new app lists the questions, five options and all', list.status === 200 && JSON.stringify(list.body).includes(`${tag} five options again?`), list.status);
  const listOld = await api('GET', '/teacher/questions', T, undefined, old);
  const oldText = JSON.stringify(listOld.body);
  check('an app from before is listed the questions it can show, not turned away', listOld.status === 200 && oldText.includes(`${tag} four options?`), listOld.status);
  check('without the ones of five and six', !oldText.includes(`${tag} five options again?`) && !oldText.includes(`${tag} six options?`), oldText.length);
  const oneOld = await api('GET', `/teacher/questions/${q5.body.id}`, T, undefined, old);
  check('asked for the one of five by name, it is told to update', oneOld.status === 409 && code(oneOld) === 'needs_newer_app', oneOld.body);
  check('and the sentence says what to do', /newest version/.test(oneOld.body?.error?.message ?? ''), oneOld.body);
  const oneNone = await api('GET', `/teacher/questions/${q6.body.id}`, T, undefined, none);
  check('nor a caller that does not say which app it is', oneNone.status === 409, oneNone.body);
  const oneFour = await api('GET', `/teacher/questions/${q4.body.id}`, T, undefined, old);
  check('a question of four goes to the old app as ever', oneFour.status === 200 && oneFour.body.question?.options?.length === 4, oneFour.body);
  const oldWrite = await api('POST', '/teacher/questions', T, { class_level: 9, text: `${tag} from the old app`, options: ['a', 'b', 'c', 'd'], correct_option: 1, subject_id: MATHS }, old);
  check('the old app can still write a question of four', oldWrite.status === 201, oldWrite.body);
  created.questions.push(oldWrite.body.id);

  // ------------------------------------------------------------------ a test with a question of five and one of four
  const stuA = await api('POST', '/teacher/students', T, { display_name: 'Five A', class_level: 9, username: `${tag}.a`, pin: '1111', subject_ids: [MATHS] });
  check('a student is added', stuA.status === 201, stuA.body);
  created.users.push(stuA.body.student.id);
  const stuB = await api('POST', '/teacher/students', T, { display_name: 'Five B', class_level: 9, username: `${tag}.b`, pin: '2222', subject_ids: [MATHS] });
  created.users.push(stuB.body.student.id);
  const test = await api('POST', '/teacher/tests', T, {
    title: `${tag} test`, class_level: 9, subject_id: MATHS, question_ids: [q5.body.id, q6.body.id, q4.body.id], shuffle: false, assign_all: false, assign_group: true, closes_at: iso(86_400_000),
  });
  check('a test of the three is made', test.status === 201, test.body);
  created.tests.push(test.body.id);
  check('and posted', (await api('POST', `/teacher/tests/${test.body.id}/publish`, T, { published: true })).status === 200);
  const testOld = await api('GET', `/teacher/tests/${test.body.id}`, T, undefined, old);
  check('the old app cannot open the test either, since it holds the five', testOld.status === 409 && code(testOld) === 'needs_newer_app', testOld.body);
  const testNew = await api('GET', `/teacher/tests/${test.body.id}`, T);
  check('the new app opens it', testNew.status === 200, testNew.body);

  const loginA = await api('POST', '/auth/login', undefined, { username: `${tag}.a`, secret: '1111' }, { 'x-app': NEW_APP, 'x-install-id': `${tag}-a` });
  const SA = loginA.body.token as string;
  const start = await api('POST', `/student/tests/${test.body.id}/start`, SA);
  check('a student on the new app starts it', start.status === 200 || start.status === 201, start.body);
  const qs: any[] = start.body?.questions ?? [];
  check('and sees five, six and four options', JSON.stringify(qs.map((x) => x.options.length)) === '[5,6,4]', qs.map((x) => x.options));
  const attempt = start.body?.attempt?.id as string;
  const bad5 = await api('PUT', `/student/attempts/${attempt}/answers`, SA, { answers: [{ question_id: qs[0].id, choice: 5 }] });
  check('a choice past the fifth is refused on a question of five', bad5.status === 400, bad5.body);
  const bad4 = await api('PUT', `/student/attempts/${attempt}/answers`, SA, { answers: [{ question_id: qs[2].id, choice: 4 }] });
  check('and a choice of the fifth on a question of four', bad4.status === 400, bad4.body);
  const huge = await api('PUT', `/student/attempts/${attempt}/answers`, SA, { answers: [{ question_id: qs[0].id, choice: 6 }] });
  check('and a choice of 6 anywhere', huge.status === 400, huge.body);
  const saved = await api('PUT', `/student/attempts/${attempt}/answers`, SA, { answers: [{ question_id: qs[0].id, choice: 4 }, { question_id: qs[1].id, choice: 5 }, { question_id: qs[2].id, choice: 0 }] });
  check('the fifth, the sixth and the first are saved', saved.status === 200, saved.body);
  const resumed = await api('POST', `/student/tests/${test.body.id}/start`, SA);
  check('the student, back on the test, finds the picks where they were', JSON.stringify((resumed.body?.questions ?? []).map((x: any) => x.chosen)) === '[4,5,0]', resumed.body?.questions?.map((x: any) => x.chosen));
  const done = await api('POST', `/student/attempts/${attempt}/submit`, SA, { answers: [] });
  const rv: any[] = done.body?.review ?? [];
  check('handed in: the questions of five and six are marked right, the one of four wrong', done.status === 200 && done.body.attempt.correct === 2 && done.body.attempt.wrong === 1, done.body?.attempt);
  check('and the review shows every option with its right one', JSON.stringify(rv.map((x) => [x.options.length, x.correct, x.chosen])) === '[[5,4,4],[6,5,5],[4,2,0]]', rv.map((x) => [x.options.length, x.correct, x.chosen]));
  const resOld = await api('GET', `/student/attempts/${attempt}/result`, SA, undefined, old);
  check('the result is held back from an old app on the same phone', resOld.status === 409 && code(resOld) === 'needs_newer_app', resOld.body);

  // ------------------------------------------------------------------ the old app on a student's phone
  const loginB = await api('POST', '/auth/login', undefined, { username: `${tag}.b`, secret: '2222' }, { 'x-app': OLD_APP, 'x-install-id': `${tag}-b` });
  check('a student on the old app signs in', loginB.status === 200, loginB.body);
  const SB = loginB.body.token as string;
  const home = await api('GET', '/student/home', SB, undefined, old);
  check('and sees the test in the list', home.status === 200 && home.body?.tests?.some((x: any) => x.id === test.body.id) === true, home.body);
  const startOld = await api('POST', `/student/tests/${test.body.id}/start`, SB, undefined, old);
  check('but cannot start it: a sentence, not a crash', startOld.status === 409 && code(startOld) === 'needs_newer_app', startOld.body);
  const attempts = (await db.query('select count(*) as n from attempts where test_id = $1 and student_id = $2', [test.body.id, stuB.body.student.id])).rows[0].n;
  check('and no attempt was started for them', Number(attempts) === 0, attempts);
  const startNew = await api('POST', `/student/tests/${test.body.id}/start`, SB);
  check('the same student, on the new app, can', startNew.status === 200 || startNew.status === 201, startNew.body);

  // ------------------------------------------------------------------ what the tutor sees afterwards
  const res = await api('GET', `/teacher/tests/${test.body.id}/results`, T);
  const rq: any[] = res.body?.questions ?? [];
  check('the results count the picks of each option, five, six and four of them', res.status === 200 && JSON.stringify(rq.map((x) => x.option_counts.length)) === '[5,6,4]', rq.map((x) => x.option_counts));
  check('the fifth option was picked once and is the right one: 100% of the one who submitted', rq[0]?.option_counts?.[4] === 1 && rq[0]?.correct_option === 4 && rq[0]?.correct_pct === 1, rq[0]);
  check('the one who got the question of four wrong is counted on the first option', rq[2]?.option_counts?.[0] === 1 && rq[2]?.most_picked_wrong === 0, rq[2]);
  const resOldT = await api('GET', `/teacher/tests/${test.body.id}/results`, T, undefined, old);
  check('the old app cannot open those results', resOldT.status === 409 && code(resOldT) === 'needs_newer_app', resOldT.body);

  // ------------------------------------------------------------------ a test of four only is no business of the gate
  const t4 = await api('POST', '/teacher/tests', T, { title: `${tag} four only`, class_level: 9, subject_id: MATHS, question_ids: [q4.body.id], shuffle: true, assign_all: false, assign_group: true, closes_at: iso(86_400_000) });
  created.tests.push(t4.body.id);
  await api('POST', `/teacher/tests/${t4.body.id}/publish`, T, { published: true });
  const r4 = await api('GET', `/teacher/tests/${t4.body.id}/results`, T, undefined, old);
  check('a test of four opens on the old app, as before', r4.status === 200, r4.body);
  const s4 = await api('POST', `/student/tests/${t4.body.id}/start`, SB, undefined, old);
  check('and starts there', s4.status === 200 || s4.status === 201, s4.body);
  const order = (await db.query('select option_orders from attempts where test_id = $1 and student_id = $2', [t4.body.id, stuB.body.student.id])).rows[0]?.option_orders ?? {};
  check('with the four options shuffled among themselves', Object.values(order).every((o: any) => [...o].sort().join() === '0,1,2,3'), order);

  // ------------------------------------------------------------------ shuffling a question of five keeps all five
  const t5s = await api('POST', '/teacher/tests', T, { title: `${tag} shuffled`, class_level: 9, subject_id: MATHS, question_ids: [q5.body.id, q6.body.id], shuffle: true, assign_all: false, assign_group: true, closes_at: iso(86_400_000) });
  created.tests.push(t5s.body.id);
  await api('POST', `/teacher/tests/${t5s.body.id}/publish`, T, { published: true });
  const s5 = await api('POST', `/student/tests/${t5s.body.id}/start`, SB);
  check('a shuffled test with the five and the six starts', s5.status === 200 || s5.status === 201, s5.body);
  const o5 = (await db.query('select option_orders from attempts where test_id = $1 and student_id = $2', [t5s.body.id, stuB.body.student.id])).rows[0]?.option_orders ?? {};
  const lens = Object.values(o5).map((o: any) => [...o].sort().join()).sort();
  check('each shuffle holds every option once', JSON.stringify(lens) === JSON.stringify(['0,1,2,3,4', '0,1,2,3,4,5']), o5);
  const sq: any[] = s5.body?.questions ?? [];
  const pick = sq.find((x) => x.options.length === 5);
  const chooseLast = await api('PUT', `/student/attempts/${s5.body.attempt.id}/answers`, SB, { answers: [{ question_id: pick.id, choice: 4 }] });
  check('and the last slot can be chosen', chooseLast.status === 200, chooseLast.body);
  const savedPick = (await db.query('select chosen_option from answers where attempt_id = $1 and question_id = $2', [s5.body.attempt.id, pick.id])).rows[0]?.chosen_option;
  check('which is saved as the question\'s own option, whichever it was shuffled to', savedPick === o5[pick.id][4], { savedPick, order: o5[pick.id] });
} catch (e) {
  fail++;
  console.log('FAIL  unexpected error:', e);
} finally {
  await db.query('delete from tests where id = any($1::uuid[])', [created.tests]);
  await db.query('delete from questions where id = any($1::uuid[])', [created.questions]);
  await db.query('delete from app_installs where install_id like $1', [`${tag}-%`]);
  await db.query('delete from users where id = any($1::uuid[])', [created.users]);
  await db.query('delete from tuitions where id = any($1::uuid[])', [created.tuitions]);
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed (test data removed)`);
  process.exit(fail ? 1 : 0);
}
