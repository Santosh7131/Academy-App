// Checks the timetable end to end (routes/timetable.ts, lib/timetable.ts; migration 041): a class's times on its weekdays, added,
// changed and taken off by any tutor of the tuition; what is refused (days, start, length, links that are not plain https, a class
// the tuition does not have, more than ten times for one class); the group's and course's pages list them; a student's Home has
// today's classes, or the next one, for the groups and courses they are in and no others (another class, a subject they do not
// take, another course, a place turned off, another tuition); India's calendar decides the day; removing a group or deleting a
// course takes its times, and renaming the subject keeps them. The API runs in this process against the dev database. Makes its
// own tutors, tuitions and students and removes them again. Dev only. Needs migration 041.
// Usage: node tools/timetable-test.ts
import { randomInt } from 'node:crypto';
import pg from 'pg';
import { addDays, istToday } from '../api/src/lib/attendance.ts';

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
// Imported once the env is loaded: the library opens the database pool when it is first imported.
const { istWeekday, todayAndNext } = await import('../api/src/lib/timetable.ts');
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

const tag = `tt${randomInt(1000, 9999)}`;
const created = { users: [] as string[], tuitions: [] as string[] };
const today = istToday();
const wdToday = istWeekday();
const wdIn = (days: number) => ((wdToday - 1 + days) % 7) + 1;
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];

/** A tutor who signs up and opens a tuition with Class 9 Maths, Class 9 Science and Class 10 Maths. */
async function newTutor(suffix: string) {
  const su = await api('POST', '/auth/signup-tutor', undefined, { display_name: `Timetable ${suffix}`, username: `${tag}.${suffix}`, password: 'longenough1' }, { 'x-install-id': `${tag}-${suffix}` });
  if (su.status !== 201) throw new Error(`sign-up failed: ${JSON.stringify(su.body)}`);
  created.users.push(su.body.user.id);
  const T = su.body.token as string;
  const groups = [{ class_level: 9, subject_id: MATHS }, { class_level: 9, subject_id: SCIENCE }, { class_level: 10, subject_id: MATHS }];
  const mk = await api('POST', '/auth/tuitions', T, { name: `${tag} ${suffix}`, groups });
  if (mk.status !== 201) throw new Error(`tuition failed: ${JSON.stringify(mk.body)}`);
  created.tuitions.push(mk.body.tuition.id);
  return { T, tuition: mk.body.tuition.id as string };
}

/** A student made by the tutor (only the dev database allows that), in class `cls`, taking `subjects`; with their own token. */
async function newStudent(T: string, name: string, cls: number, subjects: string[]) {
  const username = `${tag}.${name.toLowerCase()}`;
  const r = await api('POST', '/teacher/students', T, { display_name: `${tag} ${name}`, class_level: cls, username, pin: '2468', subject_ids: subjects });
  if (r.status !== 201) throw new Error(`student failed: ${JSON.stringify(r.body)}`);
  created.users.push(r.body.student.id);
  const token = (await api('POST', '/auth/login', undefined, { username, secret: '2468' })).body?.token as string;
  return { id: r.body.student.id as string, token };
}

const maths9 = { class_level: 9, subject_id: MATHS };
const science9 = { class_level: 9, subject_id: SCIENCE };
const maths10 = { class_level: 10, subject_id: MATHS };
const LINK = 'https://meet.google.com/abc-defg-hij';
const home = async (token: string) => (await api('GET', '/student/home', token)).body?.classes;
const names = (list: any[] | undefined) => (list ?? []).map((t) => `${t.name} ${t.starts_at}`);

try {
  if (!SCIENCE) throw new Error('No standard Science subject in this database.');

  // ---------------------------------------------------------------- India's day, worked out on the server
  check("India's Tuesday ends at 6:30 pm in London", istWeekday(new Date('2026-11-24T18:29:00Z')) === 2 && istWeekday(new Date('2026-11-24T18:31:00Z')) === 3);
  check('Sunday is 7', istWeekday(new Date('2026-11-29T06:00:00Z')) === 7);
  const sample = [
    { id: 'a', weekdays: [2], starts_at: '16:00', minutes: 60, join_url: null, note: null },
    { id: 'b', weekdays: [2, 4], starts_at: '09:00', minutes: 60, join_url: null, note: null },
    { id: 'c', weekdays: [6], starts_at: '07:00', minutes: 60, join_url: null, note: null },
  ];
  const tue = todayAndNext(sample, new Date('2026-11-24T05:00:00Z'));
  check("a Tuesday's classes, earliest first, and Thursday's next", JSON.stringify(tue.today.map((t) => t.id)) === '["b","a"]' && tue.next?.id === 'b' && tue.next.day === '2026-11-26', tue);
  const fri = todayAndNext(sample, new Date('2026-11-27T05:00:00Z'));
  check('a day with none says the next, days ahead', fri.today.length === 0 && fri.next?.id === 'c' && fri.next.day === '2026-11-28', fri);
  check('a week with no times has no next', todayAndNext([], new Date()).next === null);

  // ---------------------------------------------------------------- the tuition and its people
  const A = await newTutor('a');
  const asha = await newStudent(A.T, 'Asha', 9, [MATHS, SCIENCE]);
  const ravi = await newStudent(A.T, 'Ravi', 9, [MATHS]);
  const kiran = await newStudent(A.T, 'Kiran', 9, []);
  const dev = await newStudent(A.T, 'Dev', 10, [MATHS]);
  const mohan = await newStudent(A.T, 'Mohan', 9, [MATHS]);

  // ---------------------------------------------------------------- what is refused
  const good = { ...maths9, weekdays: EVERY_DAY, starts_at: '16:30', minutes: 60, join_url: LINK };
  check('a class must be named', (await api('POST', '/teacher/class-times', A.T, { weekdays: [1], starts_at: '16:30', minutes: 60 })).status === 400);
  const noGroup = await api('POST', '/teacher/class-times', A.T, { ...good, class_level: 12 });
  check('a class the tuition has no group for is not found', [400, 404].includes(noGroup.status), noGroup.body);
  for (const [what, wrong] of [
    ['no days', { weekdays: [] }], ['day 0', { weekdays: [0] }], ['day 8', { weekdays: [8] }], ['a day as text', { weekdays: ['1'] }],
    ['days left out', { weekdays: undefined }], ['25:00', { starts_at: '25:00' }], ['4:30', { starts_at: '4:30' }],
    ['16:30:00', { starts_at: '16:30:00' }], ['a number for the start', { starts_at: 1630 }], ['5 minutes', { minutes: 5 }],
    ['7 hours', { minutes: 420 }], ['minutes as words', { minutes: 'an hour' }], ['a note too long', { note: 'n'.repeat(81) }],
  ] as const) {
    const r = await api('POST', '/teacher/class-times', A.T, { ...good, ...wrong });
    check(`a wrong time is refused: ${what}`, r.status === 400, r.body);
  }
  for (const url of [
    'http://meet.google.com/abc-defg-hij', 'javascript:alert(1)', 'data:text/html,hello', 'meet.google.com/abc-defg-hij',
    'https://user:secret@meet.google.com/abc', 'https://localhost/class', 'https://meet.google.com/a b',
    `https://meet.google.com/${'a'.repeat(500)}`, 'https://.example.com/x', 'ftp://zoom.us/j/1',
  ]) {
    const r = await api('POST', '/teacher/class-times', A.T, { ...good, join_url: url });
    check(`a link that is not a plain https one is refused: ${url.slice(0, 40)}`, r.status === 400, r.body);
  }
  check('nothing was saved by the refusals', (await count('select count(*) as n from class_times where tuition_id = $1', [A.tuition])) === 0);

  // ---------------------------------------------------------------- adding, listing, changing
  const t1 = await api('POST', '/teacher/class-times', A.T, { ...good, weekdays: [7, 1, 2, 3, 4, 5, 6, 1], join_url: 'https://Meet.Google.com/abc-defg-hij' });
  check('a time is added, its days in order and once each, its link as the browser would write it',
    t1.status === 201 && JSON.stringify(t1.body.time.weekdays) === JSON.stringify(EVERY_DAY) && t1.body.time.starts_at === '16:30' && t1.body.time.minutes === 60
      && t1.body.time.join_url === LINK && t1.body.time.note === null, t1.body);
  const t2 = await api('POST', '/teacher/class-times', A.T, { ...science9, weekdays: EVERY_DAY, starts_at: '15:00', minutes: 45, join_url: 'https://zoom.us/j/123456789?pwd=abc', note: 'Bring the lab book' });
  check('a time without a link, or with a note, is fine', t2.status === 201 && t2.body.time.note === 'Bring the lab book', t2.body);
  const t3 = await api('POST', '/teacher/class-times', A.T, { ...maths10, weekdays: EVERY_DAY, starts_at: '18:00', minutes: 90 });
  check('another class gets its own', t3.status === 201 && t3.body.time.join_url === null, t3.body);
  const co = await api('POST', '/teacher/courses', A.T, { name: `${tag} Olympiad` });
  const course = co.body.course.id as string;
  await api('POST', `/teacher/courses/${course}/people`, A.T, { student_ids: [asha.id, kiran.id] });
  const t4 = await api('POST', '/teacher/class-times', A.T, { course_id: course, weekdays: [wdIn(2)], starts_at: '07:00', minutes: 60, join_url: 'https://meet.jit.si/olympiad-batch' });
  check('a course gets times too', t4.status === 201, t4.body);

  const listed = await api('GET', `/teacher/class-times?class_level=9&subject_id=${MATHS}`, A.T);
  check("a class's times are listed", listed.status === 200 && listed.body.times.length === 1 && listed.body.times[0].id === t1.body.time.id, listed.body);
  const groupPage = (await api('GET', `/teacher/groups/9/${MATHS}`, A.T)).body;
  check("the group's page has its times", groupPage?.times?.length === 1 && groupPage.times[0].join_url === LINK, groupPage?.times);
  const coursePage = (await api('GET', `/teacher/courses/${course}`, A.T)).body;
  check("the course's page has its times", coursePage?.times?.length === 1 && coursePage.times[0].starts_at === '07:00', coursePage?.times);

  const moved = await api('PUT', `/teacher/class-times/${t1.body.time.id}`, A.T, { weekdays: EVERY_DAY, starts_at: '17:00', minutes: 60, join_url: '' });
  check('a time is changed, and a blank link is no link', moved.status === 200 && moved.body.time.starts_at === '17:00' && moved.body.time.join_url === null, moved.body);
  const back = await api('PUT', `/teacher/class-times/${t1.body.time.id}`, A.T, { weekdays: EVERY_DAY, starts_at: '17:00', minutes: 60, join_url: LINK });
  check('and its link put back', back.status === 200 && back.body.time.join_url === LINK, back.body);
  check('a change is checked as an addition is', (await api('PUT', `/teacher/class-times/${t1.body.time.id}`, A.T, { weekdays: EVERY_DAY, starts_at: '17:00', minutes: 60, join_url: 'http://x.example' })).status === 400);
  check('a time that is not there is not found', (await api('PUT', '/teacher/class-times/00000000-0000-4000-8000-0000000000ee', A.T, { weekdays: [1], starts_at: '10:00', minutes: 30 })).status === 404);

  // A second tutor of the tuition keeps the timetable too. Free has room for one tutor (lib/plans.ts): the run's tuition is on
  // Basic for its second, its AI for the month counted as given so its credit is as it was.
  await db.query(`update tuitions set plan = 'basic', plan_from = current_date - 1, plan_until = current_date + 31, plan_refilled = current_date - 1 where id = $1`, [A.tuition]);
  const tu = await api('POST', '/teacher/tutors', A.T, { display_name: 'Timetable helper', username: `${tag}.helper`, password: 'longenough2' });
  if (tu.body?.tutor?.id ?? tu.body?.user?.id) created.users.push(tu.body.tutor?.id ?? tu.body.user?.id);
  const helper = (await api('POST', '/auth/login', undefined, { username: `${tag}.helper`, secret: 'longenough2' })).body?.token as string;
  const byHelper = await api('PUT', `/teacher/class-times/${t3.body.time.id}`, helper, { weekdays: EVERY_DAY, starts_at: '18:30', minutes: 90 });
  check('a second tutor changes the timetable too', !!helper && byHelper.status === 200 && byHelper.body.time.starts_at === '18:30', byHelper.body);

  // ---------------------------------------------------------------- what each student sees
  const ashaHome = await home(asha.token);
  check("a student's Home has today's classes of every group they are in, earliest first, by subject",
    JSON.stringify(names(ashaHome?.today)) === JSON.stringify(['Science 15:00', 'Maths 17:00']) && ashaHome.today[1].join_url === LINK && ashaHome.today[0].kind === 'group', ashaHome);
  check('and the next class, tomorrow', ashaHome?.next?.day === addDays(today, 1) && ashaHome.next.name === 'Science', ashaHome?.next);
  const raviHome = await home(ravi.token);
  check('a student who does not take Science never sees its times', JSON.stringify(names(raviHome?.today)) === JSON.stringify(['Maths 17:00']), raviHome);
  const kiranHome = await home(kiran.token);
  check("a student in a course alone has nothing today, and the course's next class", kiranHome?.today?.length === 0 && kiranHome.next?.kind === 'course'
    && kiranHome.next.name === `${tag} Olympiad` && kiranHome.next.day === addDays(today, 2) && kiranHome.next.join_url === 'https://meet.jit.si/olympiad-batch', kiranHome);
  const devHome = await home(dev.token);
  check("another class's student sees only their own class's times", JSON.stringify(names(devHome?.today)) === JSON.stringify(['Maths 18:30']), devHome);
  await api('POST', `/teacher/students/${mohan.id}/active`, A.T, { active: false });
  const off = await api('GET', '/student/home', mohan.token);
  check('a student whose place is turned off sees none', off.status !== 200 || (off.body?.classes?.today?.length === 0 && off.body.classes.next === null), off.body?.classes ?? off.status);
  check('a student cannot read or change the timetable', (await api('GET', `/teacher/class-times?class_level=9&subject_id=${MATHS}`, asha.token)).status === 403
    && (await api('DELETE', `/teacher/class-times/${t1.body.time.id}`, asha.token)).status === 403);

  // ---------------------------------------------------------------- ten at most, and a removed group
  const g11 = await api('POST', '/teacher/groups', A.T, { class_level: 11, subject_id: MATHS });
  check('an empty group is added for the cap', g11.status === 201, g11.body);
  let added = 0;
  for (let i = 0; i < 10; i++) {
    const r = await api('POST', '/teacher/class-times', A.T, { class_level: 11, subject_id: MATHS, weekdays: [(i % 7) + 1], starts_at: `${String(8 + i).padStart(2, '0')}:00`, minutes: 30 });
    if (r.status === 201) added++;
  }
  const eleventh = await api('POST', '/teacher/class-times', A.T, { class_level: 11, subject_id: MATHS, weekdays: [1], starts_at: '20:00', minutes: 30 });
  check('a class takes ten times, not eleven', added === 10 && eleventh.status === 409 && code(eleventh) === 'too_many_times', eleventh.body);
  const g11Row = (await db.query('select id from groups where tuition_id = $1 and class_level = 11 and subject_id = $2', [A.tuition, MATHS])).rows[0]?.id;
  const gone = await api('DELETE', `/teacher/groups/11/${MATHS}`, A.T);
  check("removing a group takes its times", gone.status === 200 && (await count('select count(*) as n from class_times where group_id = $1', [g11Row])) === 0, gone.body);

  // ---------------------------------------------------------------- another tuition
  const B = await newTutor('b');
  const bList = await api('GET', `/teacher/class-times?class_level=9&subject_id=${MATHS}`, B.T);
  check("another tuition's class of the same name has none of these times", bList.status === 200 && bList.body.times.length === 0, bList.body);
  check('and cannot change one', (await api('PUT', `/teacher/class-times/${t1.body.time.id}`, B.T, { weekdays: [1], starts_at: '10:00', minutes: 30 })).status === 404);
  check('nor take one off', (await api('DELETE', `/teacher/class-times/${t1.body.time.id}`, B.T)).status === 404);
  check("nor add one to this tuition's course", (await api('POST', '/teacher/class-times', B.T, { course_id: course, weekdays: [1], starts_at: '10:00', minutes: 30 })).status === 404);
  const bStudent = await newStudent(B.T, 'Bina', 9, [MATHS]);
  const bHome = await home(bStudent.token);
  check("another tuition's student sees none of these", bHome?.today?.length === 0 && bHome.next === null, bHome);

  // ---------------------------------------------------------------- taking off, a course deleted, a subject renamed
  const off2 = await api('DELETE', `/teacher/class-times/${t2.body.time.id}`, A.T);
  check('a time is taken off', off2.status === 200 && JSON.stringify(names((await home(asha.token))?.today)) === JSON.stringify(['Maths 17:00']));
  check('and then there is none to take off', (await api('DELETE', `/teacher/class-times/${t2.body.time.id}`, A.T)).status === 404);
  await api('DELETE', `/teacher/courses/${course}?with_results=1`, A.T);
  check("deleting a course takes its times", (await count('select count(*) as n from class_times where course_id = $1', [course])) === 0);
  check('and its students no longer see them', (await home(kiran.token))?.next === null);
  // Maths is shared by every tuition, so renaming it gives this tuition a subject of its own (lib/subjects.ts); its groups change in
  // place, so their times stay.
  const renamed = await api('PATCH', `/teacher/subjects/${MATHS}`, A.T, { name: `${tag} Maths` });
  const ownMaths = renamed.body?.subject?.id as string | undefined;
  const kept = ownMaths ? await api('GET', `/teacher/class-times?class_level=9&subject_id=${ownMaths}`, A.T) : null;
  check("renaming the group's subject keeps its times", renamed.status === 200 && !!ownMaths && ownMaths !== MATHS && kept?.status === 200 && kept.body.times.length === 1, [renamed.body, kept?.body]);
  check('and its students see them under the new name', JSON.stringify(names((await home(ravi.token))?.today)) === JSON.stringify([`${tag} Maths 17:00`]));
} catch (e) {
  fail++;
  console.log('FAIL  the run stopped:', e);
} finally {
  // What this run made goes: the tests first, as the route that deletes a tuition does.
  if (created.tuitions.length) await db.query('delete from tests where tuition_id = any($1::uuid[])', [created.tuitions]).catch(() => {});
  if (created.tuitions.length) await db.query('delete from tuitions where id = any($1::uuid[])', [created.tuitions]);
  if (created.users.length) await db.query('delete from users where id = any($1::uuid[])', [created.users]);
  await db.query('delete from users where username like $1', [`${tag}.%`]);
  await db.end();
  const { pool } = await import('../api/src/lib/db.ts');
  await pool.end().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
