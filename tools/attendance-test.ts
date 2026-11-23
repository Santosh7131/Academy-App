// Checks attendance end to end (routes/attendance.ts, lib/attendance.ts; migration 038): a register for a group or a course,
// everyone present but the students marked absent; one register per class per day, which a second tutor updates; a day that has
// not come is refused, and a student not in the class cannot be marked; a student who leaves the class keeps their mark; the
// group's and course's pages say how today stands; a student's page and report, and the student's own Home, sum up their marks;
// a register can be taken away; removing a student from the tuition takes their marks, and deleting a course its registers;
// and another tuition reaches none of it. The API runs in this process against the dev database. Makes its own tutors, tuitions
// and students and removes them again. Dev only. Needs migration 038.
// Usage: node tools/attendance-test.ts
import { randomInt } from 'node:crypto';
import pg from 'pg';
import { addDays, istStart, istToday } from '../api/src/lib/attendance.ts';

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

const db = new pg.Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
await db.connect();
const count = async (sql: string, params: unknown[]) => Number((await db.query(sql, params)).rows[0].n);

const tag = `att${randomInt(1000, 9999)}`;
const created = { users: [] as string[], tuitions: [] as string[] };
const today = istToday();
const yesterday = addDays(today, -1);

/** A tutor who signs up and opens a tuition with Class 9 Maths. */
async function newTutor(suffix: string) {
  const su = await api('POST', '/auth/signup-tutor', undefined, { display_name: `Attendance ${suffix}`, username: `${tag}.${suffix}`, password: 'longenough1' }, { 'x-install-id': `${tag}-${suffix}` });
  if (su.status !== 201) throw new Error(`sign-up failed: ${JSON.stringify(su.body)}`);
  created.users.push(su.body.user.id);
  const T = su.body.token as string;
  const mk = await api('POST', '/auth/tuitions', T, { name: `${tag} ${suffix}`, groups: [{ class_level: 9, subject_id: MATHS }] });
  if (mk.status !== 201) throw new Error(`tuition failed: ${JSON.stringify(mk.body)}`);
  created.tuitions.push(mk.body.tuition.id);
  return { T, tuition: mk.body.tuition.id as string };
}

/** A Class 9 student made by the tutor (only the dev database allows that), taking `subjects`. */
async function newStudent(T: string, name: string, subjects: string[]) {
  const r = await api('POST', '/teacher/students', T, { display_name: `${tag} ${name}`, class_level: 9, username: `${tag}.${name.toLowerCase()}`, pin: '2468', subject_ids: subjects });
  if (r.status !== 201) throw new Error(`student failed: ${JSON.stringify(r.body)}`);
  created.users.push(r.body.student.id);
  return r.body.student.id as string;
}

const GROUP = `class_level=9&subject_id=${MATHS}`;
const group = { class_level: 9, subject_id: MATHS };
const mark = (r: { body: any }, id: string) => r.body?.students?.find((s: any) => s.id === id);

try {
  const A = await newTutor('a');
  const asha = await newStudent(A.T, 'Asha', [MATHS]);
  const ravi = await newStudent(A.T, 'Ravi', [MATHS]);
  const meena = await newStudent(A.T, 'Meena', [MATHS]);
  const noMaths = await newStudent(A.T, 'Kiran', []);

  // ---------------------------------------------------------------- before a register is taken
  check('a class must be named', (await api('GET', '/teacher/attendance', A.T)).status === 400);
  check("a subject the tuition does not teach is not found", (await api('GET', `/teacher/attendance?class_level=9&subject_id=00000000-0000-4000-8000-000000000099`, A.T)).status === 404);
  const first = await api('GET', `/teacher/attendance?${GROUP}`, A.T);
  check("today's register is not taken yet, and it says today in India", first.status === 200 && first.body.register === null && first.body.day === today && first.body.today === today, first.body);
  check('the class is its students who take Maths, unmarked', JSON.stringify(first.body.students.map((s: any) => [s.id, s.present, s.in_class]).sort()) === JSON.stringify([asha, ravi, meena].map((id) => [id, null, true]).sort()), first.body.students);
  check('tomorrow cannot be taken', (await api('GET', `/teacher/attendance?${GROUP}&day=${addDays(today, 1)}`, A.T)).status === 400);
  check('a day written another way is refused', (await api('PUT', '/teacher/attendance', A.T, { ...group, day: '23-11-2026', absent: [] })).status === 400);
  check('a student not in the class cannot be marked', (await api('PUT', '/teacher/attendance', A.T, { ...group, absent: [noMaths] })).status === 400);
  check('the group page says it is not taken', (await api('GET', `/teacher/groups/9/${MATHS}`, A.T)).body?.attendance_today?.taken === false);

  // ---------------------------------------------------------------- taking it
  const took = await api('PUT', '/teacher/attendance', A.T, { ...group, absent: [ravi] });
  check('everyone is present but the one marked absent', took.status === 200 && took.body.present === 2 && took.body.absent.length === 1 && took.body.absent[0].id === ravi && took.body.day === today, took.body);
  const read = await api('GET', `/teacher/attendance?${GROUP}`, A.T);
  check('the register reads back, with who took it', read.body.register?.taken_by === 'Attendance a' && mark(read, asha)?.present === true && mark(read, ravi)?.present === false && mark(read, meena)?.present === true, read.body);
  const page = (await api('GET', `/teacher/groups/9/${MATHS}`, A.T)).body?.attendance_today;
  check("the group page has today's numbers", page?.taken === true && page.present === 2 && page.absent === 1, page);

  // A second tutor of the tuition fixes it: Ravi came after all. It is the same register.
  // Free has room for one tutor (lib/plans.ts): the run's tuition is on Basic for its second, its AI for the month counted as given
  // so its credit is as it was.
  await db.query(`update tuitions set plan = 'basic', plan_from = current_date - 1, plan_until = current_date + 31, plan_refilled = current_date - 1 where id = $1`, [A.tuition]);
  const tu = await api('POST', '/teacher/tutors', A.T, { display_name: 'Attendance helper', username: `${tag}.helper`, password: 'longenough2' });
  if (tu.body?.tutor?.id ?? tu.body?.user?.id) created.users.push(tu.body.tutor?.id ?? tu.body.user?.id);
  const helper = (await api('POST', '/auth/login', undefined, { username: `${tag}.helper`, secret: 'longenough2' })).body?.token as string;
  check('a second tutor logs in', !!helper);
  const fixed = await api('PUT', '/teacher/attendance', helper, { ...group, absent: [] });
  const again = await api('GET', `/teacher/attendance?${GROUP}`, A.T);
  check('a second tutor changes the same register', fixed.status === 200 && fixed.body.present === 3 && mark(again, ravi)?.present === true && again.body.register?.taken_by === 'Attendance helper', [fixed.body, again.body.register]);
  check('there is one register for the class today', (await count(`select count(*) as n from attendance_days where tuition_id = $1 and day = $2`, [A.tuition, today])) === 1);

  // Yesterday's, taken late.
  const late = await api('PUT', '/teacher/attendance', A.T, { ...group, day: yesterday, absent: [asha, meena] });
  check("yesterday's register can be taken today", late.status === 200 && late.body.present === 1 && late.body.day === yesterday, late.body);
  const month = await api('GET', `/teacher/attendance/month?${GROUP}&month=${yesterday.slice(0, 7)}`, A.T);
  const ydays = month.body?.days?.find((d: any) => d.day === yesterday);
  check("the month's list has yesterday with its numbers", month.status === 200 && ydays?.present === 1 && ydays?.absent === 2, month.body);
  check('next month cannot be listed', (await api('GET', `/teacher/attendance/month?${GROUP}&month=${addDays(`${today.slice(0, 7)}-28`, 5).slice(0, 7)}`, A.T)).status === 400);

  // ---------------------------------------------------------------- a student who leaves the class
  await api('PATCH', `/teacher/students/${meena}`, A.T, { subject_ids: [] });
  const left = await api('GET', `/teacher/attendance?${GROUP}&day=${yesterday}`, A.T);
  check('a student who left the class is still on the old register, marked as she was', mark(left, meena)?.in_class === false && mark(left, meena)?.present === false, mark(left, meena));
  const retake = await api('PUT', '/teacher/attendance', A.T, { ...group, day: yesterday, absent: [asha] });
  check('taking the register again leaves her mark alone', retake.status === 200 && (await db.query(`select m.present from attendance_marks m join attendance_days d on d.id = m.day_id where d.tuition_id = $1 and d.day = $2 and m.student_id = $3`, [A.tuition, yesterday, meena])).rows[0]?.present === false);
  check('and she cannot be marked now', (await api('PUT', '/teacher/attendance', A.T, { ...group, absent: [meena] })).status === 400);

  // ---------------------------------------------------------------- a course
  const co = await api('POST', '/teacher/courses', A.T, { name: `${tag} Spoken English` });
  const course = co.body.course.id as string;
  check('an empty course has nobody to mark', (await api('PUT', '/teacher/attendance', A.T, { course_id: course, absent: [] })).status === 400);
  await api('POST', `/teacher/courses/${course}/people`, A.T, { student_ids: [asha, noMaths] });
  const cTook = await api('PUT', '/teacher/attendance', A.T, { course_id: course, absent: [noMaths] });
  check("a course's register is its people", cTook.status === 200 && cTook.body.present === 1 && cTook.body.absent[0]?.id === noMaths, cTook.body);
  check("the course page has today's numbers", (await api('GET', `/teacher/courses/${course}`, A.T)).body?.attendance_today?.present === 1);
  check("the group's register is apart from the course's", (await api('GET', `/teacher/attendance?${GROUP}`, A.T)).body.students.every((s: any) => s.id !== noMaths));

  // ---------------------------------------------------------------- one student summed up
  const ashaPage = (await api('GET', `/teacher/students/${asha}`, A.T)).body?.attendance;
  check("a student's page counts the groups' registers", ashaPage?.classes === 2 && ashaPage.present === 1 && JSON.stringify(ashaPage.absent_days) === JSON.stringify([yesterday]), ashaPage);
  const ashaCourse = (await api('GET', `/teacher/students/${asha}?course=${course}`, A.T)).body?.attendance;
  check("and from a course's page, that course's", ashaCourse?.classes === 1 && ashaCourse.present === 1, ashaCourse);
  const report = (await api('GET', `/teacher/students/${asha}?from=${encodeURIComponent(istStart(yesterday).toISOString())}&to=${encodeURIComponent(istStart(today).toISOString())}`, A.T)).body?.attendance;
  check("a report for parents counts its period's, in India's days", report?.classes === 1 && report.present === 0, report);

  const kiran = (await api('POST', '/auth/login', undefined, { username: `${tag}.kiran`, secret: '2468' })).body?.token as string;
  const home = (await api('GET', '/student/home', kiran)).body?.attendance;
  check("a student's Home has this month's, every class together", home?.classes === 1 && home.present === 0 && home.absent_days?.[0] === today, home);
  check('a student cannot read a register', (await api('GET', `/teacher/attendance?course_id=${course}`, kiran)).status === 403);

  // ---------------------------------------------------------------- taking away
  check("a register taken by mistake can be taken away", (await api('DELETE', `/teacher/attendance?${GROUP}&day=${yesterday}`, A.T)).status === 200);
  check('and then there is none to take away', (await api('DELETE', `/teacher/attendance?${GROUP}&day=${yesterday}`, A.T)).status === 404);
  check("its marks went with it", (await count(`select count(*) as n from attendance_days where tuition_id = $1 and day = $2`, [A.tuition, yesterday])) === 0);

  await api('DELETE', `/teacher/students/${ravi}`, A.T);
  check('removing a student from the tuition takes their marks here', (await count('select count(*) as n from attendance_marks where student_id = $1', [ravi])) === 0);
  await api('DELETE', `/teacher/courses/${course}?with_results=1`, A.T);
  check("deleting a course takes its registers", (await count('select count(*) as n from attendance_days where course_id = $1', [course])) === 0);

  // ---------------------------------------------------------------- renaming the subject
  // Maths is shared by every tuition, so renaming it gives this tuition a subject of its own (lib/subjects.ts); the group's
  // registers move with everything else it kept under Maths.
  const renamed = await api('PATCH', `/teacher/subjects/${MATHS}`, A.T, { name: `${tag} Maths` });
  const ownMaths = renamed.body?.subject?.id as string | undefined;
  const moved = ownMaths ? await api('GET', `/teacher/attendance?class_level=9&subject_id=${ownMaths}`, A.T) : null;
  check("renaming the group's subject keeps its registers", renamed.status === 200 && !!ownMaths && ownMaths !== MATHS && moved?.status === 200 && moved.body.register !== null && mark(moved, asha)?.present === true, [renamed.body, moved?.body?.register]);
  check('and none are left under the old subject', (await count('select count(*) as n from attendance_days where tuition_id = $1 and subject_id = $2', [A.tuition, MATHS])) === 0);

  // ---------------------------------------------------------------- another tuition
  const B = await newTutor('b');
  const bView = await api('GET', `/teacher/attendance?${GROUP}`, B.T);
  check("another tuition's class of the same name has none of these students or registers", bView.status === 200 && bView.body.register === null && bView.body.students.length === 0, bView.body);
  check("and cannot mark them", (await api('PUT', '/teacher/attendance', B.T, { ...group, absent: [asha] })).status === 400);
  check("nor take this tuition's register away", (await api('DELETE', `/teacher/attendance?${GROUP}`, B.T)).status === 404);
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
