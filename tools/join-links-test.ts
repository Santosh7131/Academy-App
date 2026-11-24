// Checks students making their own logins and joining with a group's or course's link: signing up with a password or with
// Google (routes/auth.ts), a tutor's links and what they show to anyone (routes/links.ts), asking to join with one
// (POST /student/join), a tutor letting students in one at a time or all at once, or declining, a new link stopping the old
// one, the account staying the student's own (turned off, removed, a new password, deleting it), and tutors no longer
// making students' logins outside the test database. Google is played by a key made for the run (lib/google.ts,
// useGoogleTestKeys), so it needs no network. The API runs in this process against the dev database. Makes its own tutors,
// tuitions and students and removes them again. Dev only.
// Usage: node tools/join-links-test.ts
import { generateKeyPairSync, randomInt, sign } from 'node:crypto';
import pg from 'pg';

process.loadEnvFile('.env.local');
try { process.loadEnvFile('api/.env.secrets'); } catch {}
// Dev only: a database on this PC (tools/local-stack.mjs), or the dev branch whose host DEV_DATABASE_HOST names.
const devHosts = ['127.0.0.1', 'localhost', process.env.DEV_DATABASE_HOST].filter(Boolean);
const dbHost = (() => { try { return new URL(String(process.env.DATABASE_URL)).hostname; } catch { return ''; } })();
if (process.env.NEON_BRANCH !== 'dev' || !devHosts.includes(dbHost)) throw new Error('This only runs against a dev database.');
process.env.PUSH_DRY_RUN = '1';
const WEB_CLIENT = 'join-test-web.apps.googleusercontent.com';
const ANDROID_CLIENT = 'join-test-android.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_ID = `${WEB_CLIENT},${ANDROID_CLIENT}`;
delete process.env.JOIN_LINK_BASE;

const { default: app } = await import('../api/src/index.ts');
const { useGoogleTestKeys } = await import('../api/src/lib/google.ts');
const { groupClassSql } = await import('../api/src/lib/levels.ts');

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `  -> ${JSON.stringify(detail)}`}`);
}

const MATHS = '00000000-0000-4000-8000-000000000001';
const PASSWORD = 'longenough1';
const tag = `jl${randomInt(1000, 9999)}`;
let phones = 0;
/** Each sign-up from a phone of its own: a phone may make only three logins a day. */
const newPhone = () => ({ 'x-install-id': `${tag}-phone-${++phones}` });

async function send(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.fetch(new Request(`http://test${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-app': 'tuition_app/1.9.0+13',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}
async function api(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await send(method, path, token, body, headers);
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const code = (r: { body: any }) => r.body?.error?.code;
const login = (username: string, secret: string) => api('POST', '/auth/login', undefined, { username, secret });
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const db = new pg.Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
await db.connect();
const n = async (sql: string, args: unknown[]) => Number((await db.query(sql, args)).rows[0].n);

const created = { users: [] as string[], tuitions: [] as string[] };

type Student = { id: string; S: string; username: string; name: string };
async function newStudent(who: string): Promise<Student> {
  const name = `Join ${who}`;
  const r = await api('POST', '/auth/signup-student', undefined, { display_name: name, username: `${tag}.${who}`, password: PASSWORD }, newPhone());
  if (r.status !== 201) throw new Error(`student sign-up failed: ${JSON.stringify(r.body)}`);
  created.users.push(r.body.user.id);
  return { id: r.body.user.id, S: r.body.token, username: `${tag}.${who}`, name };
}

/** A tutor who signs up and opens a tuition with Class 9 and Class 10 Maths. */
async function newTutor(who: string) {
  const su = await api('POST', '/auth/signup-tutor', undefined, { display_name: `Join tutor ${who}`, username: `${tag}.t${who}`, password: PASSWORD }, newPhone());
  if (su.status !== 201) throw new Error(`tutor sign-up failed: ${JSON.stringify(su.body)}`);
  created.users.push(su.body.user.id);
  const T = su.body.token as string;
  const mk = await api('POST', '/auth/tuitions', T, { name: `${tag} Tuition ${who}`, groups: [{ class_level: 9, subject_id: MATHS }, { class_level: 10, subject_id: MATHS }] });
  if (mk.status !== 201) throw new Error(`tuition failed: ${JSON.stringify(mk.body)}`);
  created.tuitions.push(mk.body.tuition.id);
  return { id: su.body.user.id as string, T, tuition: mk.body.tuition.id as string, name: `${tag} Tuition ${who}` };
}

// Google, played by a key made for this run.
const google = generateKeyPairSync('rsa', { modulusLength: 2048 });
useGoogleTestKeys([{ ...google.publicKey.export({ format: 'jwk' }), kid: 'join-test', alg: 'RS256', use: 'sig' } as any]);
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function googleToken(sub: string, name: string | null, aud = WEB_CLIENT) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'RS256', kid: 'join-test', typ: 'JWT' });
  const p = b64({ iss: 'https://accounts.google.com', aud, sub, exp: now + 600, iat: now, ...(name ? { name } : {}), email: `${sub}@example.com` });
  return `${h}.${p}.${sign('RSA-SHA256', Buffer.from(`${h}.${p}`), google.privateKey).toString('base64url')}`;
}

try {
  // ---------------------------------------------------------------- 1. a student signs up
  const s1 = await newStudent('one');
  const again = await api('POST', '/auth/signup-student', undefined, { display_name: 'Someone', username: s1.username, password: PASSWORD }, newPhone());
  check('a taken username is refused', again.status === 409 && code(again) === 'username_taken', again.body);
  const short = await api('POST', '/auth/signup-student', undefined, { display_name: 'Short', username: `${tag}.short`, password: 'short' }, newPhone());
  check('a password under 8 characters is refused', short.status === 400, short.body);
  const mine = await api('GET', '/student/tuitions', s1.S);
  check('a new student is in no tuition yet', mine.status === 200 && mine.body.tuitions.length === 0, mine.body);
  const noHome = await api('GET', '/student/home', s1.S);
  check('and has no home screen until they join one', noHome.status === 409 && code(noHome) === 'no_tuition', noHome.body);
  const asTutor = await api('GET', '/teacher/home', s1.S);
  check('a student login cannot open a tutor screen', asTutor.status === 403, asTutor.body);
  check('the student can log in with their password', (await login(s1.username, PASSWORD)).status === 200);

  // ---------------------------------------------------------------- 2. a group's link
  const A = await newTutor('a');
  const B = await newTutor('b');
  const g9 = await api('GET', `/teacher/groups/9/${MATHS}/link`, A.T);
  const link9 = g9.body?.link;
  check('a tutor gets the group\'s link', g9.status === 200 && /^[A-HJ-NP-Z2-9]{10}$/.test(link9?.code) && link9.code_shown === `${link9.code.slice(0, 5)}-${link9.code.slice(5)}`, g9.body);
  check('the link opens the API\'s join page for its code', typeof link9?.url === 'string' && link9.url.endsWith(`/j/${link9.code}`), link9);
  check('asking again gives the same link', (await api('GET', `/teacher/groups/9/${MATHS}/link`, A.T)).body?.link?.code === link9.code);
  const bLink = await api('GET', `/teacher/groups/9/${MATHS}/link`, B.T);
  check('another tuition\'s same group has a link of its own', bLink.status === 200 && bLink.body.link.code !== link9.code, bLink.body);
  const noGroup = await api('GET', `/teacher/groups/11/${MATHS}/link`, A.T);
  check('a group the tuition does not have has no link', noGroup.status === 404, noGroup.body);

  const preview = await api('GET', `/join/${link9.code}`);
  check('anyone with the link sees what it is for, before they have a login',
    preview.status === 200 && preview.body.link.tuition.name === A.name && preview.body.link.kind === 'group' && preview.body.link.label === '9th Maths' && preview.body.link.joining_open === true,
    preview.body);
  check('and nothing more: no ids', !UUID.test(JSON.stringify(preview.body)), preview.body);
  check('the code works in small letters, with its dash', (await api('GET', `/join/${link9.code_shown.toLowerCase()}`)).status === 200);
  const page = await send('GET', `/j/${link9.code}`);
  const html = await page.text();
  check('the link opens a page that names the tuition and the group', page.status === 200 && html.includes(A.name) && html.includes('9th Maths'), page.status);
  check('the page is never kept or indexed', page.headers.get('cache-control') === 'no-store' && page.headers.get('x-robots-tag') === 'noindex', Object.fromEntries(page.headers));
  const words = (await db.query(`select ${groupClassSql('n', 'null::uuid')} as w from generate_series(1, 12) n order by n`)).rows.map((r) => r.w);
  check('a group\'s class is worded as the app words it (groupName in levels.dart)', words.join(' ') === '1st 2nd 3rd 4th 5th 6th 7th 8th 9th 10th 11th 12th', words);
  check('and offers to open the app at the link', html.includes(`intent://app/join/${link9.code}#Intent;`) && html.includes('package=com.anytutor.app'), html.match(/intent:[^"]*/)?.[0]);

  // ---------------------------------------------------------------- 3. asking with the link
  const ask1 = await api('POST', '/student/join', s1.S, { code: link9.url });
  check('a student asks to join with the whole link', ask1.status === 201 && ask1.body.status === 'pending' && ask1.body.tuition.id === A.tuition && ask1.body.asked.kind === 'group' && ask1.body.asked.label === '9th Maths', ask1.body);
  const ask1b = await api('POST', '/student/join', s1.S, { code: link9.code_shown });
  check('asking again changes nothing', ask1b.status === 200 && ask1b.body.status === 'pending', ask1b.body);
  check('they wait in that tuition', (await api('GET', '/student/tuitions', s1.S)).body.tuitions.some((t: any) => t.id === A.tuition && t.status === 'pending'));
  const reqs = await api('GET', '/teacher/join-requests', A.T);
  const r1 = reqs.body?.link_requests?.find((r: any) => r.student_id === s1.id);
  check('the tutor sees who asked and for what', reqs.status === 200 && r1?.label === '9th Maths' && r1?.kind === 'group' && r1?.place === 'pending' && r1?.display_name === s1.name, reqs.body);
  check('they are not in the list of students who used the tuition\'s code', !reqs.body.requests.some((r: any) => r.id === s1.id), reqs.body.requests);
  check('the other tuition sees nothing of it', !JSON.stringify((await api('GET', '/teacher/join-requests', B.T)).body).includes(s1.id));

  // ---------------------------------------------------------------- 4. the tutor lets them in
  const acc1 = await api('POST', `/teacher/link-requests/${r1.id}/accept`, A.T, {});
  check('the tutor lets the student in', acc1.status === 200, acc1.body);
  const in1 = (await api('GET', '/student/tuitions', s1.S)).body.tuitions.find((t: any) => t.id === A.tuition);
  check('the student is in the tuition, in the group\'s class', in1?.status === 'active' && in1?.class_level === 9, in1);
  check('with the group\'s subject', (await n('select count(*) as n from student_subjects where tuition_id = $1 and student_id = $2 and subject_id = $3', [A.tuition, s1.id, MATHS])) === 1);
  check('and their home screen opens', (await api('GET', '/student/home', s1.S)).status === 200);
  check('the request is gone', (await n('select count(*) as n from join_requests where student_id = $1', [s1.id])) === 0);
  check('letting them in twice finds nothing', (await api('POST', `/teacher/link-requests/${r1.id}/accept`, A.T, {})).status === 404);
  const inAlready = await api('POST', '/student/join', s1.S, { code: link9.code });
  check('a student already in the group is told so', inAlready.status === 409 && code(inAlready) === 'already_member', inAlready.body);

  // ---------------------------------------------------------------- 5. a course's link, for someone already in the tuition
  const co = await api('POST', '/teacher/courses', A.T, { name: `${tag} Crash course` });
  const coLink = await api('GET', `/teacher/courses/${co.body.course.id}/link`, A.T);
  check('a course has a link too', coLink.status === 200 && /^[A-HJ-NP-Z2-9]{10}$/.test(coLink.body.link.code), coLink.body);
  check('it says it is for the course', (await api('GET', `/join/${coLink.body.link.code}`)).body?.link?.label === `${tag} Crash course`);
  const askCo = await api('POST', '/student/join', s1.S, { code: coLink.body.link.code });
  check('a student of the tuition asks for the course, and keeps their place meanwhile', askCo.status === 201 && askCo.body.status === 'active' && askCo.body.asked.kind === 'course', askCo.body);
  const rCo = (await api('GET', '/teacher/join-requests', A.T)).body.link_requests.find((r: any) => r.student_id === s1.id && r.kind === 'course');
  check('the tutor sees they are already in the tuition', rCo?.place === 'active', rCo);
  check('and lets them into the course', (await api('POST', `/teacher/link-requests/${rCo.id}/accept`, A.T, {})).status === 200 &&
    (await n('select count(*) as n from course_members where course_id = $1 and student_id = $2', [co.body.course.id, s1.id])) === 1);
  check('asking for the course again is told they are in it', code(await api('POST', '/student/join', s1.S, { code: coLink.body.link.code })) === 'already_member');

  // ---------------------------------------------------------------- 6. declining
  const s2 = await newStudent('two');
  await api('POST', '/student/join', s2.S, { code: link9.code });
  const r2 = (await api('GET', '/teacher/join-requests', A.T)).body.link_requests.find((r: any) => r.student_id === s2.id);
  const dec = await api('POST', `/teacher/link-requests/${r2.id}/decline`, A.T, {});
  check('the tutor declines a request', dec.status === 200, dec.body);
  check('the student is no longer waiting there', (await api('GET', '/student/tuitions', s2.S)).body.tuitions.length === 0);
  check('declining twice finds nothing', (await api('POST', `/teacher/link-requests/${r2.id}/decline`, A.T, {})).status === 404);
  check('another tuition cannot let in or decline A\'s requests', (await api('POST', `/teacher/link-requests/${r2.id}/accept`, B.T, {})).status === 404);

  // ---------------------------------------------------------------- 7. let all in, and who is left waiting
  const s3 = await newStudent('three');
  const s4 = await newStudent('four');
  await api('POST', '/student/join', s3.S, { code: link9.code });
  await api('POST', '/student/join', s4.S, { code: link9.code });
  const link10 = (await api('GET', `/teacher/groups/10/${MATHS}/link`, A.T)).body.link;
  const ask10 = await api('POST', '/student/join', s1.S, { code: link10.code });
  check('a student in Class 9 may ask for the Class 10 group', ask10.status === 201, ask10.body);
  const all = await api('POST', '/teacher/link-requests/accept-all', A.T, {});
  check('let all in lets in everyone it can', all.status === 200 && all.body.accepted === 2, all.body);
  check('and leaves waiting, with the reason, the student in another class', all.body?.left?.length === 1 && all.body.left[0].name === s1.name && /another class/.test(all.body.left[0].reason), all.body);
  for (const s of [s3, s4]) {
    const t = (await api('GET', '/student/tuitions', s.S)).body.tuitions.find((x: any) => x.id === A.tuition);
    check(`${s.name} is in, in Class 9`, t?.status === 'active' && t?.class_level === 9, t);
  }
  const r10 = (await api('GET', '/teacher/join-requests', A.T)).body.link_requests.find((r: any) => r.student_id === s1.id);
  const one10 = await api('POST', `/teacher/link-requests/${r10.id}/accept`, A.T, {});
  check('letting them in alone says why not', one10.status === 409 && code(one10) === 'other_class', one10.body);
  await api('POST', `/teacher/link-requests/${r10.id}/decline`, A.T, {});
  check('declining that keeps their place in the tuition', (await api('GET', '/student/tuitions', s1.S)).body.tuitions.some((t: any) => t.id === A.tuition && t.status === 'active'));

  // ---------------------------------------------------------------- 8. a new link stops the old one
  const fresh = await api('POST', `/teacher/groups/9/${MATHS}/link/new`, A.T, {});
  check('the tutor makes a new link', fresh.status === 200 && fresh.body.link.code !== link9.code, fresh.body);
  const oldPreview = await api('GET', `/join/${link9.code}`);
  check('the old link shows nothing any more', oldPreview.status === 404 && code(oldPreview) === 'unknown_link', oldPreview.body);
  const oldPage = await send('GET', `/j/${link9.code}`);
  check('its page says it stopped working', oldPage.status === 404 && (await oldPage.text()).includes('stopped working'));
  const s5 = await newStudent('five');
  const oldAsk = await api('POST', '/student/join', s5.S, { code: link9.code });
  check('asking with the old link is refused', oldAsk.status === 404 && code(oldAsk) === 'unknown_link', oldAsk.body);
  check('the new link works', (await api('GET', `/join/${fresh.body.link.code}`)).status === 200);

  // ---------------------------------------------------------------- 9. a tuition closed to new students
  await api('PATCH', '/teacher/tuition', A.T, { join_open: false });
  check('a closed tuition\'s link says so', (await api('GET', `/join/${fresh.body.link.code}`)).body?.link?.joining_open === false);
  const closed = await api('POST', '/student/join', s5.S, { code: fresh.body.link.code });
  check('a new student cannot ask to join it', closed.status === 403 && code(closed) === 'not_joinable', closed.body);
  const co2 = await api('POST', '/teacher/courses', A.T, { name: `${tag} Second course` });
  const co2Link = (await api('GET', `/teacher/courses/${co2.body.course.id}/link`, A.T)).body.link;
  const insider = await api('POST', '/student/join', s1.S, { code: co2Link.code });
  check('a student already in it can still ask for a course', insider.status === 201, insider.body);
  await api('PATCH', '/teacher/tuition', A.T, { join_open: true });

  // ---------------------------------------------------------------- 10. wrong codes are counted
  const s6 = await newStudent('six');
  let last = { status: 0, body: null as any };
  for (let i = 0; i < 8; i++) last = await api('POST', '/student/join', s6.S, { code: 'ZZZZZ-ZZZZ' + 'ABCDEFGH'[i] });
  check('a link that does not exist is refused', last.status === 404 && code(last) === 'unknown_link', last.body);
  const ninth = await api('POST', '/student/join', s6.S, { code: fresh.body.link.code });
  check('after 8 wrong codes in an hour, even a right one waits', ninth.status === 429 && code(ninth) === 'too_many_tries', ninth.body);

  // ---------------------------------------------------------------- 11. tutors no longer make students' logins
  process.env.NEON_BRANCH = 'main';
  const made = await api('POST', '/teacher/students', A.T, { display_name: 'Made By Tutor', class_level: 9, username: `${tag}.made`, pin: '1234', subject_ids: [MATHS] });
  check('outside the test database a tutor cannot make a student\'s login', made.status === 410 && code(made) === 'students_sign_up', made.body);
  const madeCo = await api('POST', `/teacher/courses/${co.body.course.id}/people/new`, A.T, { display_name: 'Made By Tutor', username: `${tag}.made2`, pin: '1234' });
  check('nor a course person\'s', madeCo.status === 410 && code(madeCo) === 'students_sign_up', madeCo.body);
  process.env.NEON_BRANCH = 'dev';
  if (made.body?.student?.id) created.users.push(made.body.student.id);
  if (madeCo.body?.student?.id) created.users.push(madeCo.body.student.id);

  // ---------------------------------------------------------------- 12. the account stays the student's own
  await api('POST', `/teacher/students/${s3.id}/active`, A.T, { active: false });
  const offHome = await api('GET', '/student/home', s3.S);
  check('a student turned off reaches the tuition no more', offHome.status === 409 && code(offHome) === 'no_tuition', offHome.body);
  const offLogin = await login(s3.username, PASSWORD);
  check('but keeps their login, in no tuition', offLogin.status === 200 && offLogin.body.tuitions.length === 0, offLogin.body);
  const removed = await api('DELETE', `/teacher/students/${s4.id}`, A.T);
  const rmLogin = await login(s4.username, PASSWORD);
  check('a student taken out of the tuition keeps their login too', removed.status === 200 && rmLogin.status === 200 && rmLogin.body.tuitions.length === 0, { removed: removed.body, login: rmLogin.body });

  const pw = await api('POST', '/auth/password', s3.S, { current: PASSWORD, next: 'brandnewpass1' });
  check('a student changes their own password', pw.status === 200, pw.body);
  check('the old one stops working and the new one works', (await login(s3.username, PASSWORD)).status === 401 && (await login(s3.username, 'brandnewpass1')).status === 200);
  const wrongPw = await api('POST', '/auth/password', s3.S, { current: 'not-it-at-all', next: 'anotherpass1' });
  check('with a wrong current password nothing changes', wrongPw.status === 400 && code(wrongPw) === 'wrong_password', wrongPw.body);

  const tutorDel = await api('POST', '/auth/delete-account', A.T, { secret: PASSWORD });
  check('a tutor\'s account is not deleted this way', tutorDel.status === 403, tutorDel.body);
  const badDel = await api('POST', '/auth/delete-account', s4.S, { secret: 'not-the-password' });
  check('deleting an account with a wrong password is refused, not as a lost session', badDel.status === 403 && code(badDel) === 'wrong_password', badDel.body);
  check('the wrong password counts as a wrong try', (await n('select failed_count as n from users where id = $1', [s4.id])) === 1);
  const del = await api('POST', '/auth/delete-account', s4.S, { secret: PASSWORD });
  check('a student deletes their own account with their password', del.status === 200, del.body);
  check('it is gone, and its login with it', (await n('select count(*) as n from users where id = $1', [s4.id])) === 0 && (await login(s4.username, PASSWORD)).status === 401);
  const delInTuition = await api('POST', '/auth/delete-account', s3.S, { secret: 'brandnewpass1' });
  check('a student with a place in a tuition can delete their account too', delInTuition.status === 200 && (await n('select count(*) as n from users where id = $1', [s3.id])) === 0, delInTuition.body);
  check('their place goes with it', (await n('select count(*) as n from memberships where user_id = $1', [s3.id])) === 0);

  // ---------------------------------------------------------------- 13. Google
  const cfg = await api('GET', '/auth/config');
  check('the app is told which Google client to sign in with', cfg.status === 200 && cfg.body.google_client_id === WEB_CLIENT, cfg.body);
  const sub = `${Date.now()}${randomInt(100000, 999999)}`;
  const first = await api('POST', '/auth/google', undefined, { id_token: googleToken(sub, 'Priya Nair') }, newPhone());
  check('a Google account with no login is asked whether they are a student or a tutor', first.status === 404 && code(first) === 'no_account', first.body);
  const made1 = await api('POST', '/auth/google', undefined, { id_token: googleToken(sub, 'Priya Nair'), role: 'student' }, newPhone());
  if (made1.body?.user?.id) created.users.push(made1.body.user.id);
  check('it makes a student login, with a username from the name', made1.status === 201 && made1.body.created === true && made1.body.user.role === 'student' && /^priya\.n(\.\d+)?$/.test(made1.body.user.username), made1.body);
  check('and its token works', (await api('GET', '/student/tuitions', made1.body.token)).status === 200);
  const back = await api('POST', '/auth/google', undefined, { id_token: googleToken(sub, 'Priya Nair', ANDROID_CLIENT) }, newPhone());
  check('signing in with Google again finds the same login (from the Android client too)', back.status === 200 && back.body.user.id === made1.body.user.id && back.body.created === undefined, back.body);
  check('only the Google number is kept, not the email', (await n(`select count(*) as n from users where id = $1 and google_sub = $2`, [made1.body.user.id, sub])) === 1);
  check('a Google login has no password anyone knows', (await login(made1.body.user.username, PASSWORD)).status === 401);
  const asks = await api('POST', '/student/join', made1.body.token, { code: fresh.body.link.code });
  check('a Google student asks to join with a link like anyone', asks.status === 201, asks.body);
  const tamil = await api('POST', '/auth/google', undefined, { id_token: googleToken(`${sub}7`, 'கவிதா'), role: 'teacher' }, newPhone());
  if (tamil.body?.user?.id) created.users.push(tamil.body.user.id);
  check('a tutor whose name is in Tamil letters gets a tutor username, and keeps the name', tamil.status === 201 && /^tutor(\.\d+)?$/.test(tamil.body.user.username) && tamil.body.user.display_name === 'கவிதா', tamil.body);
  const wrongAud = await api('POST', '/auth/google', undefined, { id_token: googleToken(sub, 'Priya Nair', 'someone-elses-app') }, newPhone());
  check('a token made for another app is refused', wrongAud.status === 401 && code(wrongAud) === 'google_failed', wrongAud.body);
  const badRole = await api('POST', '/auth/google', undefined, { id_token: googleToken(`${sub}8`, 'X'), role: 'developer' }, newPhone());
  check('nobody can make a developer login with Google', badRole.status === 400 && code(badRole) === 'invalid_role', badRole.body);
  const otherGoogle = await api('POST', '/auth/delete-account', made1.body.token, { id_token: googleToken(`${sub}9`, 'Someone') });
  check('deleting a Google login needs that Google account', otherGoogle.status === 403 && code(otherGoogle) === 'wrong_google', otherGoogle.body);
  const gDel = await api('POST', '/auth/delete-account', made1.body.token, { id_token: googleToken(sub, 'Priya Nair') });
  check('signing in with it again deletes the account', gDel.status === 200 && (await n('select count(*) as n from users where id = $1', [made1.body.user.id])) === 0, gDel.body);
  check('and its request to join went with it', (await n('select count(*) as n from join_requests where student_id = $1', [made1.body.user.id])) === 0);
  process.env.GOOGLE_CLIENT_ID = '';
  const off = await api('POST', '/auth/google', undefined, { id_token: googleToken(sub, 'Priya Nair'), role: 'student' }, newPhone());
  check('with no Google client set, Google sign-in is off', off.status === 403 && code(off) === 'google_off' && (await api('GET', '/auth/config')).body.google_client_id === null, off.body);
  process.env.GOOGLE_CLIENT_ID = `${WEB_CLIENT},${ANDROID_CLIENT}`;
} catch (e) {
  check('the run finished without an error', false, String((e as Error)?.stack ?? e));
} finally {
  process.env.NEON_BRANCH = 'dev';
  await db.query('delete from tests where tuition_id = any($1::uuid[])', [created.tuitions]).catch(() => {});
  await db.query('delete from tuitions where id = any($1::uuid[])', [created.tuitions]).catch(() => {});
  await db.query('delete from users where id = any($1::uuid[])', [created.users]).catch(() => {});
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
