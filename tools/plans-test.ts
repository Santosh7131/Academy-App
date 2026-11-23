// Checks plans end to end (api/migrations/040_plans.sql, lib/plans.ts, routes/plans.ts): Free, Basic and Pro and the room each has
// for students and tutors, at every place someone is let in or turned on; buying a plan (the owner's "I have paid", the developer
// marking it received or declined, or giving it by hand), where plans are sold, a bigger plan starting today and more of the same
// running on; the plan's AI each month (given once a plan month, never lowering the credit, none once the plan has ended); and a plan
// that ended counting as Free with nothing deleted. The API runs in this process against the dev database; the writer model is
// answered by a script, so it needs no AI keys. Makes its own tutors, students and tuitions and removes them again, and puts the plan
// and credit settings back as they were. Dev only.
// Usage: node tools/plans-test.ts
import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

process.loadEnvFile('.env.local');
try { process.loadEnvFile('api/.env.secrets'); } catch {}
// Dev only: a database on this PC (tools/local-stack.mjs), or the dev branch whose host DEV_DATABASE_HOST names.
const devHosts = ['127.0.0.1', 'localhost', process.env.DEV_DATABASE_HOST].filter(Boolean);
const dbHost = (() => { try { return new URL(String(process.env.DATABASE_URL)).hostname; } catch { return ''; } })();
if (process.env.NEON_BRANCH !== 'dev' || !devHosts.includes(dbHost)) throw new Error('This only runs against a dev database.');
process.env.AI_DAILY_CALLS = '1000000';
process.env.PUSH_DRY_RUN = '1';
process.env.GEMINI_API_KEY ||= 'test-key';
process.env.GROQ_API_KEYS ||= 'test-key-a,test-key-b';
delete process.env.GROQ_VISION_MODELS;
delete process.env.GROQ_WRITE_MODELS;
delete process.env.WHOLE_PAPER_READ;

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `  -> ${JSON.stringify(detail)}`}`);
}

// ------------------------------------------------------------------------------------------------ the scripted writer
// Writes as many questions as asked; `slowMs` makes it wait, so two requests are under way at once.
const state = { slowMs: 0 };
const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('\n') : '';
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const groq = url.startsWith('https://api.groq.com/');
  const gemini = url.startsWith('https://generativelanguage.googleapis.com/');
  if (!groq && !gemini) return realFetch(input, init);
  if (state.slowMs) await new Promise((ok) => setTimeout(ok, state.slowMs));
  const b = JSON.parse(String(init.body));
  const text = groq ? textOf(b.messages[b.messages.length - 1].content) : textOf(b.contents[b.contents.length - 1].parts);
  const n = Number(/Write exactly (\d+)/.exec(text)?.[1] ?? 0);
  const content = n
    ? JSON.stringify({
      name: 'Plan test',
      questions: Array.from({ length: n }, (_, i) => ({ text: `Plan question ${i + 1}: what is ${i} + 2?`, work: 'add', options: [`${i}`, `${i + 1}`, `${i + 2}`, `${i + 3}`], answer: `${i + 2}`, difficulty: 'easy' })),
    })
    : '{}';
  const body = groq
    ? { choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }
    : { candidates: [{ content: { parts: [{ text: content }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 } };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const { default: app } = await import('../api/src/index.ts');
const logins = JSON.parse(readFileSync('tools/out/sample-logins.dev.json', 'utf8'));
const MATHS = '00000000-0000-4000-8000-000000000001';
const PASSWORD = 'longenough1';
const tag = `plan${randomInt(1000, 9999)}`;
let phones = 0;
/** Each sign-up from a phone of its own: a phone may make only three logins a day. */
const newPhone = () => ({ 'x-install-id': `${tag}-phone-${++phones}` });
const WEB = { 'x-os': 'web' };

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
const one = async (sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows[0];
const IST_TODAY = `((now() at time zone 'Asia/Kolkata')::date)`;
const today = (await one(`select ${IST_TODAY}::text as d`)).d as string;
const plusMonths = async (d: string, n: number) => (await one('select ($1::date + make_interval(months => $2))::date::text as d', [d, n])).d as string;
const dayBefore = async (d: string) => (await one('select ($1::date - 1)::text as d', [d])).d as string;
const planRow = (t: string) => one(`select plan, plan_from::text as "from", plan_until::text as until, plan_refilled::text as refilled, credit_paise from tuitions where id = $1`, [t]);
const planLines = async (t: string) => (await db.query(`select amount_paise, balance_paise, label from credit_ledger where tuition_id = $1 and kind = 'plan' order by created_at`, [t])).rows;
const setBalance = (t: string, paise: number) => db.query('update tuitions set credit_paise = $2 where id = $1', [t, paise]);
const status = async (t: string, user: string) => (await one('select status from memberships where tuition_id = $1 and user_id = $2', [t, user]))?.status;
/** A month goes by: the plan's days move a month into the past, as they would be seen a month from now. */
const monthGoesBy = (t: string) =>
  db.query(
    `update tuitions set plan_from = (plan_from - interval '1 month')::date, plan_until = (plan_until - interval '1 month')::date,
            plan_refilled = (plan_refilled - interval '1 month')::date where id = $1`,
    [t],
  );

const created = { users: [] as string[], tuitions: [] as string[], names: [] as string[] };
const settingsBefore = (await db.query(`select key, value from app_settings where key like 'plan\\_%' or key like 'credit\\_%'`)).rows;

/** A tutor who signs up and opens a tuition with Class 9 and Class 10 Maths. */
async function newTutor(suffix: string) {
  const su = await api('POST', '/auth/signup-tutor', undefined, { display_name: `Plan ${suffix}`, username: `${tag}.${suffix}`, password: PASSWORD }, newPhone());
  if (su.status !== 201) throw new Error(`sign-up failed: ${JSON.stringify(su.body)}`);
  created.users.push(su.body.user.id);
  const T = su.body.token as string;
  const name = `${tag} ${suffix}`;
  const mk = await api('POST', '/auth/tuitions', T, { name, groups: [{ class_level: 9, subject_id: MATHS }, { class_level: 10, subject_id: MATHS }] });
  if (mk.status !== 201) throw new Error(`tuition failed: ${JSON.stringify(mk.body)}`);
  created.tuitions.push(mk.body.tuition.id);
  created.names.push(name);
  return { T, tuition: mk.body.tuition.id as string, user: su.body.user.id as string, name };
}
/** A student the tutor makes (dev database only), in Class 9. */
async function tutorMakes(T: string, who: string) {
  const r = await api('POST', '/teacher/students', T, { display_name: `Plan student ${who}`, class_level: 9, username: `${tag}.${who}`, pin: '1234' });
  if (r.body?.student?.id) created.users.push(r.body.student.id);
  return r;
}
/** A student who signs up on their own. */
async function newStudent(who: string) {
  const r = await api('POST', '/auth/signup-student', undefined, { display_name: `Plan student ${who}`, username: `${tag}.${who}`, password: PASSWORD }, newPhone());
  if (r.status !== 201) throw new Error(`student sign-up failed: ${JSON.stringify(r.body)}`);
  created.users.push(r.body.user.id);
  return { id: r.body.user.id as string, S: r.body.token as string };
}
const write = (T: string, count: number) => api('POST', '/teacher/papers/chat', T, { class_level: 9, subject_id: MATHS, request: 'Easy sums', count });

try {
  const devLogin = await api('POST', '/auth/login', undefined, { username: logins.developer.username, secret: logins.developer.password });
  const DEV = devLogin.body?.token as string;
  check('the developer logs in', !!DEV, devLogin.body);
  // Small plans, so a few students fill them; AI at the migration's prices; paying closed and nothing on sale.
  await api('PUT', '/admin/credit/settings', DEV, { page_paise: 240, question_paise: 60, solution_paise: 40, start_paise: 2000, new_clients_ai: true, upi_id: '', upi_name: '' });
  const small = await api('PUT', '/admin/plans/settings', DEV, {
    free_students: 3, free_tutors: 1, basic_students: 5, basic_tutors: 2, basic_ai_month_paise: 30000, basic_price_month_paise: null,
    pro_students: 8, pro_tutors: 3, pro_ai_month_paise: 90000, pro_price_month_paise: null, pay_where: 'both',
  });
  check('the developer sets the plans', small.status === 200 && small.body.settings.free.students === 3 && small.body.settings.basic.price_month_paise === null && small.body.settings.pay_where === 'both', small.body);
  for (const wrong of [{ free_students: 0 }, { basic_tutors: 'x' }, { basic_price_month_paise: 50 }, { pro_ai_month_paise: -1 }, { pay_where: 'shop' }, { pro_price_month_paise: 1.5 }]) {
    const r = await api('PUT', '/admin/plans/settings', DEV, wrong);
    check(`a wrong plan setting is refused: ${JSON.stringify(wrong)}`, r.status === 400, r.body);
  }

  // ---------------------------------------------------------------- Free
  const A = await newTutor('a');
  const p0 = await api('GET', '/teacher/plan', A.T);
  check('a new tuition is on Free', p0.status === 200 && p0.body.plan.name === 'free' && p0.body.plan.lapsed === false && p0.body.plan.until === null, p0.body.plan);
  check('with the owner as its one tutor and no students', p0.body.used?.students === 0 && p0.body.used.tutors === 1, p0.body.used);
  const free0 = p0.body.plans?.find((p: any) => p.name === 'free');
  const basic0 = p0.body.plans?.find((p: any) => p.name === 'basic');
  check('it is told the three plans', p0.body.plans?.length === 3 && free0?.students === 3 && free0.tutors === 1 && free0.ai_start_paise === 2000 && basic0?.ai_month_paise === 30000 && basic0.price_month_paise === null, p0.body.plans);
  check('buying is closed while nothing is on sale', p0.body.pay?.open === false && p0.body.pay.code === null && p0.body.pay.upi_id === null && p0.body.owner === true, p0.body.pay);
  check('it has the free start of AI', p0.body.ai?.balance_paise === 2000, p0.body.ai);
  await setBalance(A.tuition, 100);
  const noSale = await write(A.T, 10);
  check('AI used up before any plan is on sale says they come soon', noSale.status === 402 && code(noSale) === 'no_credit'
    && /Plans with AI every month go on sale soon\./.test(noSale.body.error.message) && JSON.stringify(noSale.body.error.plans_on_sale) === '[]', noSale.body);
  check('and Home knows none is on sale', JSON.stringify((await api('GET', '/teacher/home', A.T)).body?.credit?.plans_on_sale) === '[]');
  await setBalance(A.tuition, 2000);
  check('a tutor cannot see the developer\'s plans', (await api('GET', '/admin/plans', A.T)).status === 403);
  check('credit is no longer sold on its own', code(await api('POST', '/teacher/credit/requests', A.T, { amount_paise: 25000 })) === 'plans_only');
  const creditScreen = await api('GET', '/teacher/credit', A.T);
  check('the credit screen says so, with the plan', creditScreen.body?.topups === false && creditScreen.body.plan?.name === 'free', creditScreen.body);

  // Room for students: a student made, turned on, let in with the code or a link, or made into a course.
  const s1 = await tutorMakes(A.T, 's1');
  const s2 = await tutorMakes(A.T, 's2');
  const s3 = await tutorMakes(A.T, 's3');
  check('Free takes three students', [s1, s2, s3].every((r) => r.status === 201), [s1.body, s2.body, s3.body]);
  const s4 = await tutorMakes(A.T, 's4');
  check('a fourth is refused with 402', s4.status === 402 && code(s4) === 'plan_students_full' && s4.body.error.limit === 3 && s4.body.error.plan === 'free', s4.body);
  check('the refusal says why and what to do', /Free plan has room for 3 students\. Move to a bigger plan/.test(s4.body?.error?.message ?? ''), s4.body?.error?.message);
  check('and nobody is made', Number((await one(`select count(*) as n from users where username = $1`, [`${tag}.s4`])).n) === 0);
  const id1 = s1.body.student.id as string;
  const id3 = s3.body.student.id as string;
  check('turning a student off always works', (await api('POST', `/teacher/students/${id3}/active`, A.T, { active: false })).status === 200);
  const s5 = await tutorMakes(A.T, 's5');
  check('a student turned off takes no room', s5.status === 201, s5.body);
  const back = await api('POST', `/teacher/students/${id3}/active`, A.T, { active: true });
  check('turning one back on waits for room', back.status === 402 && code(back) === 'plan_students_full' && (await status(A.tuition, id3)) === 'off', back.body);
  check('turning on a student who is on takes no more room', (await api('POST', `/teacher/students/${id1}/active`, A.T, { active: true })).status === 200);

  const joinCode = (await api('GET', '/teacher/tuition', A.T)).body?.tuition?.join_code as string;
  const J = await newStudent('j');
  check('a student asks to join with the code', (await api('POST', '/student/join', J.S, { code: joinCode })).status === 201);
  const accJ = await api('POST', `/teacher/join-requests/${J.id}/accept`, A.T, { class_level: 9 });
  check('letting them in waits for room', accJ.status === 402 && code(accJ) === 'plan_students_full' && (await status(A.tuition, J.id)) === 'pending', accJ.body);

  const link9 = (await api('GET', `/teacher/groups/9/${MATHS}/link`, A.T)).body?.link;
  const K = await newStudent('k');
  check('a student asks with the group\'s link', (await api('POST', '/student/join', K.S, { code: link9?.code })).status === 201);
  const reqK = (await api('GET', '/teacher/join-requests', A.T)).body?.link_requests?.find((r: any) => r.student_id === K.id);
  const accK = await api('POST', `/teacher/link-requests/${reqK?.id}/accept`, A.T, {});
  check('letting them in waits for room too', accK.status === 402 && code(accK) === 'plan_students_full' && (await status(A.tuition, K.id)) === 'pending', accK.body);
  check('and their request stays', Number((await one('select count(*) as n from join_requests where id = $1', [reqK?.id])).n) === 1);

  const co = (await api('POST', '/teacher/courses', A.T, { name: `${tag} Course` })).body?.course?.id as string;
  const newcomer = await api('POST', `/teacher/courses/${co}/people/new`, A.T, { display_name: 'Plan newcomer', username: `${tag}.new`, pin: '4321' });
  if (newcomer.body?.student?.id) created.users.push(newcomer.body.student.id);
  check('a new person for a course waits for room', newcomer.status === 402 && code(newcomer) === 'plan_students_full', newcomer.body);
  const coLink = (await api('GET', `/teacher/courses/${co}/link`, A.T)).body?.link;
  const s1Login = await api('POST', '/auth/login', undefined, { username: `${tag}.s1`, secret: '1234' });
  check('a student already in asks for the course', (await api('POST', '/student/join', s1Login.body?.token, { code: coLink?.code })).status === 201, s1Login.body);
  const reqCo = (await api('GET', '/teacher/join-requests', A.T)).body?.link_requests?.find((r: any) => r.student_id === id1);
  const accCo = await api('POST', `/teacher/link-requests/${reqCo?.id}/accept`, A.T, {});
  check('a student already in takes no more room', accCo.status === 200, accCo.body);

  // Room for one more, and two let in at once: one comes in, the other waits.
  check('a student is turned off', (await api('POST', `/teacher/students/${s5.body.student.id}/active`, A.T, { active: false })).status === 200);
  const both = await Promise.all([
    api('POST', `/teacher/join-requests/${J.id}/accept`, A.T, { class_level: 9 }),
    api('POST', `/teacher/link-requests/${reqK.id}/accept`, A.T, {}),
  ]);
  check('two let in at once with room for one: one comes in, one waits', both.map((r) => r.status).sort().join() === '200,402', both.map((r) => [r.status, code(r)]));
  const usedNow = (await api('GET', '/teacher/plan', A.T)).body?.used;
  check('the plan is full, never over', usedNow?.students === 3, usedNow);
  const waitingOne = both[0].status === 402 ? { kind: 'join', id: J.id } : { kind: 'link', id: reqK.id };

  const tutor2 = await api('POST', '/teacher/tutors', A.T, { display_name: 'Plan helper', username: `${tag}.helper`, password: 'longenough2' });
  if (tutor2.body?.tutor?.id) created.users.push(tutor2.body.tutor.id);
  check('Free has room for one tutor', tutor2.status === 402 && code(tutor2) === 'plan_tutors_full' && /room for 1 tutor\./.test(tutor2.body.error.message), tutor2.body);

  // ---------------------------------------------------------------- buying a plan
  const notOnSale = await api('POST', '/teacher/plan/requests', A.T, { plan: 'basic', months: 1 });
  check('a plan with no price is not on sale', notOnSale.status === 409 && code(notOnSale) === 'not_on_sale', notOnSale.body);
  await api('PUT', '/admin/plans/settings', DEV, { basic_price_month_paise: 49900 });
  const noUpi = await api('POST', '/teacher/plan/requests', A.T, { plan: 'basic', months: 1 });
  check('nor while the developer has no UPI id', noUpi.status === 409 && code(noUpi) === 'no_upi', noUpi.body);
  await api('PUT', '/admin/credit/settings', DEV, { upi_id: 'tuitionpay@okbank', upi_name: 'Sample Payee' });
  const p1 = await api('GET', '/teacher/plan', A.T);
  check('with a price and a UPI id, the plan is on sale', p1.body.pay?.open === true && p1.body.pay.here === true && JSON.stringify(p1.body.pay.for_sale) === '["basic"]' && p1.body.pay.upi_id === 'tuitionpay@okbank' && /^CR-[A-HJ-NP-Z2-9]{4}$/.test(p1.body.pay.code), p1.body.pay);
  check('for 1, 3, 6 or 12 months', JSON.stringify(p1.body.pay?.months) === '[1,3,6,12]', p1.body.pay?.months);
  const payCode = p1.body.pay.code as string;
  for (const wrong of [{ plan: 'free', months: 1 }, { plan: 'gold', months: 1 }, { plan: 'basic', months: 2 }, { plan: 'basic', months: '1' }, { plan: 'basic' }]) {
    const r = await api('POST', '/teacher/plan/requests', A.T, wrong);
    check(`a wrong request is refused: ${JSON.stringify(wrong)}`, r.status === 400, r.body);
  }
  check('Pro, with no price, is not on sale', code(await api('POST', '/teacher/plan/requests', A.T, { plan: 'pro', months: 1 })) === 'not_on_sale');

  await api('PUT', '/admin/plans/settings', DEV, { pay_where: 'web' });
  check('sold only on the web: the app is told so', (await api('GET', '/teacher/plan', A.T)).body.pay?.here === false
    && code(await api('POST', '/teacher/plan/requests', A.T, { plan: 'basic', months: 1 })) === 'pay_on_web');
  check('and the web version is told it can buy', (await api('GET', '/teacher/plan', A.T, undefined, WEB)).body.pay?.here === true);
  const r1 = await api('POST', '/teacher/plan/requests', A.T, { plan: 'basic', months: 1 }, WEB);
  check('"I have paid" for Basic, a month, from the web version', r1.status === 201 && r1.body.request.status === 'waiting' && r1.body.request.amount_paise === 49900 && r1.body.request.code === payCode && r1.body.request.upi_id === 'tuitionpay@okbank', r1.body);
  await api('PUT', '/admin/plans/settings', DEV, { pay_where: 'app' });
  check('sold only in the app: the web version is told so', code(await api('POST', '/teacher/plan/requests', A.T, { plan: 'basic', months: 1 }, WEB)) === 'pay_in_app');
  await api('PUT', '/admin/plans/settings', DEV, { pay_where: 'both' });
  const r2 = await api('POST', '/teacher/plan/requests', A.T, { plan: 'basic', months: 3 });
  check('three months cost three times the price', r2.status === 201 && r2.body.request.amount_paise === 149700, r2.body);
  const r3 = await api('POST', '/teacher/plan/requests', A.T, { plan: 'basic', months: 1 });
  const r4 = await api('POST', '/teacher/plan/requests', A.T, { plan: 'basic', months: 1 });
  check('three may wait at once, not four', r3.status === 201 && r4.status === 409 && code(r4) === 'too_many_requests', [r3.body, r4.body]);
  check('the tutor sees them waiting', (await api('GET', '/teacher/plan', A.T)).body.waiting?.length === 3);
  check('the plan does not start before the payment is found', (await planRow(A.tuition)).plan === 'free');

  const queue = await api('GET', '/admin/plans', DEV);
  const mine = queue.body?.waiting?.find((w: any) => w.id === r1.body.request.id);
  check('the developer sees it, with the client, its plan and the code', queue.status === 200 && mine?.client === A.name && mine.client_plan === 'free' && mine.code === payCode && mine.plan === 'basic' && mine.months === 1, mine ?? queue.body);
  check('a tutor cannot mark a payment received', (await api('POST', `/admin/plans/requests/${r1.body.request.id}/receive`, A.T, {})).status === 403);
  const declined = await api('POST', `/admin/plans/requests/${r3.body.request.id}/decline`, DEV, {});
  check('a declined request starts nothing', declined.status === 200 && declined.body.request.status === 'declined' && declined.body.plan === null && (await planRow(A.tuition)).plan === 'free', declined.body);

  const got = await api('POST', `/admin/plans/requests/${r1.body.request.id}/receive`, DEV, { ref: 'UTR 4401' });
  const monthOn = await plusMonths(today, 1);
  check('marked received, Basic starts today for a month', got.status === 200 && got.body.plan?.plan === 'basic' && got.body.plan.from === today && got.body.plan.until === monthOn, got.body);
  const period1 = await one('select * from plan_periods where request_id = $1', [r1.body.request.id]);
  check('its record keeps the payment, the reference and the days', period1?.amount_paise === 49900 && period1.ref === 'UTR 4401' && period1.months === 1 && period1.plan === 'basic', period1);
  const twice = await api('POST', `/admin/plans/requests/${r1.body.request.id}/receive`, DEV, {});
  check('a request is received once', twice.status === 409 && code(twice) === 'already_decided', twice.body);
  check('and cannot be declined after', (await api('POST', `/admin/plans/requests/${r1.body.request.id}/decline`, DEV, {})).status === 409);
  check('a request that is not there is not found', (await api('POST', '/admin/plans/requests/00000000-0000-4000-8000-0000000000dd/receive', DEV, {})).status === 404);
  const pBasicAll = (await api('GET', '/teacher/plan', A.T)).body;
  const pBasic = pBasicAll?.plan;
  check('the tutor sees Basic until the day before it ends', pBasic?.name === 'basic' && pBasic.last_day === (await dayBefore(monthOn)) && pBasic.next_month_on === null, pBasic);
  check('Basic\'s AI for the month tops the credit up to ₹300 at the first look', pBasicAll?.ai?.balance_paise === 30000, pBasicAll?.ai);

  const more = await api('POST', `/admin/plans/requests/${r2.body.request.id}/receive`, DEV, {});
  const fourOn = await plusMonths(today, 4);
  check('three more months of the same plan run on after the first', more.status === 200 && more.body.plan?.from === today && more.body.plan.until === fourOn, more.body);
  const period2 = await one('select period_from::text as "from", period_until::text as until, ref from plan_periods where request_id = $1', [r2.body.request.id]);
  check('and are recorded from the day the first ends, with the code', period2?.from === monthOn && period2.until === fourOn && period2.ref === payCode, period2);
  check('the plan\'s next month is a month from its start', (await api('GET', '/teacher/plan', A.T)).body?.plan?.next_month_on === monthOn);

  // ---------------------------------------------------------------- Basic's room
  const inNow = await api('POST', waitingOne.kind === 'join' ? `/teacher/join-requests/${waitingOne.id}/accept` : `/teacher/link-requests/${waitingOne.id}/accept`, A.T, waitingOne.kind === 'join' ? { class_level: 9 } : {});
  check('on Basic the student waiting comes in', inNow.status === 200, inNow.body);
  const helper = await api('POST', '/teacher/tutors', A.T, { display_name: 'Plan helper', username: `${tag}.helper`, password: 'longenough2' });
  if (helper.body?.tutor?.id) created.users.push(helper.body.tutor.id);
  check('and a second tutor', helper.status === 201, helper.body);
  const third = await api('POST', '/teacher/tutors', A.T, { display_name: 'Plan third', username: `${tag}.third`, password: 'longenough2' });
  if (third.body?.tutor?.id) created.users.push(third.body.tutor.id);
  check('a third tutor is refused on Basic, with a bigger plan to move to', third.status === 402 && code(third) === 'plan_tutors_full' && /Basic plan has room for 2 tutors\. Move to a bigger plan/.test(third.body.error.message), third.body);
  const helperT = (await api('POST', '/auth/login', undefined, { username: `${tag}.helper`, secret: 'longenough2' })).body?.token as string;
  const hp = await api('GET', '/teacher/plan', helperT);
  check('a helper tutor sees the plan, not as its owner', hp.status === 200 && hp.body.plan.name === 'basic' && hp.body.owner === false, hp.body?.owner);
  const hb = await api('POST', '/teacher/plan/requests', helperT, { plan: 'basic', months: 1 });
  check('and cannot buy one', hb.status === 403 && code(hb) === 'owner_only', hb.body);
  const helperId = helper.body.tutor.id as string;
  check('a helper turned off and on again takes back their own room', (await api('POST', `/teacher/tutors/${helperId}/active`, A.T, { active: false })).status === 200
    && (await api('POST', `/teacher/tutors/${helperId}/active`, A.T, { active: true })).status === 200);

  // ---------------------------------------------------------------- the plan's AI each month
  // Pro goes on sale too, so Basic's tutors are offered it.
  await api('PUT', '/admin/plans/settings', DEV, { pro_price_month_paise: 99900 });
  check('Home knows which plans are on sale', JSON.stringify((await api('GET', '/teacher/home', A.T)).body?.credit?.plans_on_sale) === '["basic","pro"]');
  const linesBefore = 0;
  const home = await api('GET', '/teacher/home', A.T);
  check('Home shows it', home.status === 200 && home.body.credit?.balance_paise === 30000, home.body.credit);
  const given = await planLines(A.tuition);
  check('as a line of its own: what it added', given.length === linesBefore + 1 && given.at(-1).amount_paise === 28000 && given.at(-1).balance_paise === 30000 && given.at(-1).label === 'Basic plan', given);
  check('marked given for this plan month', (await planRow(A.tuition)).refilled === today, await planRow(A.tuition));
  await api('GET', '/teacher/plan', A.T);
  await api('GET', '/teacher/credit', A.T);
  check('given once a month, however often it is looked at', (await planLines(A.tuition)).length === linesBefore + 1);
  const w10 = await write(A.T, 10);
  check('AI work spends it', w10.status === 201 && (await planRow(A.tuition)).credit_paise === 29400, [w10.status, w10.body?.error, (await planRow(A.tuition)).credit_paise]);
  const historyLine = (await api('GET', '/teacher/credit/history', A.T)).body?.lines?.find((l: any) => l.kind === 'plan');
  check('the history shows the plan\'s line', historyLine?.amount_paise === 28000 && historyLine.label === 'Basic plan', historyLine);

  await setBalance(A.tuition, 100);
  const shortBasic = await write(A.T, 10);
  const nextOn = (await api('GET', '/teacher/plan', A.T)).body?.plan?.next_month_on;
  check('AI used up on Basic is refused with 402, as before', shortBasic.status === 402 && code(shortBasic) === 'no_credit' && shortBasic.body.error.credit_paise === 100 && shortBasic.body.error.needed_paise === 600, shortBasic.body);
  check('saying when it comes again and that Pro has more', shortBasic.body?.error?.plan === 'basic' && shortBasic.body.error.next_month_on === nextOn && /this month\. Your plan's AI comes again on .+\. Or move to Pro for more\./.test(shortBasic.body.error.message), shortBasic.body?.error);
  check('with no word of adding credit', !/add credit/i.test(shortBasic.body?.error?.message ?? ''));
  await setBalance(A.tuition, 29400);

  await monthGoesBy(A.tuition);
  const w5 = await write(A.T, 5);
  const next = await planLines(A.tuition);
  check('a month later, the first AI work tops it up again, to ₹300', w5.status === 201 && next.length === linesBefore + 2 && next.at(-1).amount_paise === 600 && next.at(-1).balance_paise === 30000, next);
  check('and then spends it', (await planRow(A.tuition)).credit_paise === 29700, (await planRow(A.tuition)).credit_paise);
  check('none of last month\'s is carried over: it is topped up, not added', (await planRow(A.tuition)).credit_paise <= 30000);

  await monthGoesBy(A.tuition);
  await setBalance(A.tuition, 45000);
  const moreThan = await api('GET', '/teacher/home', A.T);
  check('credit above the plan\'s AI is never lowered', moreThan.body.credit?.balance_paise === 45000 && (await planLines(A.tuition)).length === linesBefore + 2, moreThan.body.credit);
  check('and the month counts as given', (await planRow(A.tuition)).refilled === today);

  await monthGoesBy(A.tuition);
  await setBalance(A.tuition, 0);
  state.slowMs = 300;
  const two = await Promise.all([write(A.T, 2), write(A.T, 3)]);
  state.slowMs = 0;
  check('two AI jobs at the start of a month: both run', two.every((r) => r.status === 201), two.map((r) => [r.status, code(r)]));
  check('and the month\'s AI is given once', (await planLines(A.tuition)).length === linesBefore + 3 && (await planRow(A.tuition)).credit_paise === 30000 - 300, [await planLines(A.tuition), (await planRow(A.tuition)).credit_paise]);

  const B = await newTutor('b');
  await setBalance(B.tuition, 100);
  const shortFree = await write(B.T, 10);
  check('AI used up on Free says to move to Basic or Pro', shortFree.status === 402 && code(shortFree) === 'no_credit' && /Move to Basic or Pro for AI every month\./.test(shortFree.body.error.message) && shortFree.body.error.next_month_on === null, shortFree.body);
  const bPlan = (await api('GET', '/teacher/plan', B.T)).body;
  check('another tuition has its own plan, code and requests', bPlan.plan.name === 'free' && bPlan.pay.code !== payCode && bPlan.waiting.length === 0, bPlan);

  // ---------------------------------------------------------------- a plan that ends
  await db.query(`update tuitions set plan_until = ${IST_TODAY} where id = $1`, [A.tuition]);
  await setBalance(A.tuition, 5000);
  const lapsed = (await api('GET', '/teacher/plan', A.T)).body;
  check('a plan past its end counts as Free, and says it ended', lapsed.plan.name === 'free' && lapsed.plan.bought === 'basic' && lapsed.plan.lapsed === true && lapsed.plan.next_month_on === null, lapsed.plan);
  check('nobody is turned off', lapsed.used.students === 4 && lapsed.used.tutors === 2, lapsed.used);
  const afterEnd = await tutorMakes(A.T, 's6');
  check('but nobody more is let in past Free\'s room', afterEnd.status === 402 && code(afterEnd) === 'plan_students_full', afterEnd.body);
  const linesAtEnd = (await planLines(A.tuition)).length;
  await monthGoesBy(A.tuition);
  await db.query(`update tuitions set plan_until = ${IST_TODAY} where id = $1`, [A.tuition]);
  const wEnd = await write(A.T, 2);
  check('the AI left can still be used, and no more is given', wEnd.status === 201 && (await planLines(A.tuition)).length === linesAtEnd && (await planRow(A.tuition)).credit_paise === 4880, [wEnd.status, (await planRow(A.tuition)).credit_paise]);

  // ---------------------------------------------------------------- by hand, a bigger plan, a smaller one
  for (const wrong of [{ plan: 'pro', months: 0, amount_paise: 0 }, { plan: 'pro', months: 25, amount_paise: 0 }, { plan: 'free', months: 1, amount_paise: 0 }, { plan: 'pro', months: 1, amount_paise: -1 }, { plan: 'pro', months: 1 }]) {
    const r = await api('POST', `/admin/clients/${A.tuition}/plan`, DEV, wrong);
    check(`a wrong plan by hand is refused: ${JSON.stringify(wrong)}`, r.status === 400, r.body);
  }
  check('only for a client that exists', (await api('POST', '/admin/clients/00000000-0000-4000-8000-0000000000dd/plan', DEV, { plan: 'basic', months: 1, amount_paise: 0 })).status === 404);
  const handBasic = await api('POST', `/admin/clients/${A.tuition}/plan`, DEV, { plan: 'basic', months: 1, amount_paise: 0, ref: 'given' });
  check('the developer gives Basic by hand: after its end, it starts again today', handBasic.status === 201 && handBasic.body.plan.from === today && handBasic.body.plan.until === monthOn, handBasic.body);
  check('and its AI comes with the next look', (await api('GET', '/teacher/home', A.T)).body.credit?.balance_paise === 30000 && (await planRow(A.tuition)).refilled === today);
  const waitingBasic = await api('POST', '/teacher/plan/requests', A.T, { plan: 'basic', months: 1 });
  await api('PUT', '/admin/plans/settings', DEV, { pro_price_month_paise: 99900 });
  const rPro = await api('POST', '/teacher/plan/requests', A.T, { plan: 'pro', months: 1 });
  check('Pro, with a price, can be bought', rPro.status === 201 && rPro.body.request.amount_paise === 99900, rPro.body);
  const toPro = await api('POST', `/admin/plans/requests/${rPro.body.request.id}/receive`, DEV, {});
  check('a bigger plan starts today', toPro.status === 200 && toPro.body.plan.plan === 'pro' && toPro.body.plan.from === today && toPro.body.plan.until === monthOn, toPro.body);
  check('with its own AI for the month', (await api('GET', '/teacher/home', A.T)).body.credit?.balance_paise === 90000 && (await planLines(A.tuition)).at(-1).label === 'Pro plan');
  const smaller = await api('POST', '/teacher/plan/requests', A.T, { plan: 'basic', months: 1 });
  check('Basic cannot be bought while Pro runs', smaller.status === 409 && code(smaller) === 'smaller_plan', smaller.body);
  const oldBasic = await api('POST', `/admin/plans/requests/${waitingBasic.body.request.id}/receive`, DEV, {});
  check('a Basic payment from before is not received over Pro unasked', oldBasic.status === 409 && code(oldBasic) === 'smaller_plan' && oldBasic.body.error.client_plan === 'pro', oldBasic.body);
  check('and stays waiting', (await one('select status from plan_requests where id = $1', [waitingBasic.body.request.id])).status === 'waiting');
  await setBalance(A.tuition, 100);
  const shortPro = await write(A.T, 10);
  check('AI used up on Pro says only when it comes again', shortPro.status === 402 && /this month\./.test(shortPro.body.error.message) && !/move to/i.test(shortPro.body.error.message), shortPro.body);
  const proRoom = (await api('GET', '/teacher/plan', A.T)).body;
  check('Pro has its own room', proRoom.plans.find((p: any) => p.name === 'pro')?.students === 8 && (await tutorMakes(A.T, 's7')).status === 201, proRoom.plans);
  const replaced = await api('POST', `/admin/plans/requests/${waitingBasic.body.request.id}/receive`, DEV, { replace: true });
  check('received with replace, Basic starts today in Pro\'s place', replaced.status === 200 && replaced.body.plan.plan === 'basic' && (await planRow(A.tuition)).plan === 'basic', replaced.body);

  const clients = await api('GET', '/admin/clients', DEV);
  const row = clients.body?.clients?.find((x: any) => x.id === A.tuition);
  check('the client list shows the plan and its last day', row?.plan === 'basic' && row.plan_last_day === (await dayBefore(monthOn)), row && { plan: row.plan, last: row.plan_last_day });
  const page = await api('GET', `/admin/clients/${A.tuition}/plan`, DEV);
  check('the client\'s plan page lists every stretch given', page.status === 200 && page.body.plan.name === 'basic' && page.body.periods?.length === 5 && page.body.used?.students === 5, page.body);
  const month = (await api('GET', '/admin/plans', DEV)).body;
  check('the developer sees this month\'s plan money and who is on what', month.month?.paid_paise >= 49900 + 149700 + 99900 + 49900 && month.month.given >= 1 && month.clients?.basic >= 1, month.month);
  const ended = await api('DELETE', `/admin/clients/${A.tuition}/plan`, DEV);
  check('the developer ends a plan: Free again, today', ended.status === 200 && ended.body.plan.name === 'free' && ended.body.plan.lapsed === false && (await planRow(A.tuition)).until === null, ended.body);
  check('its credit stays', (await planRow(A.tuition)).credit_paise > 0);

  // A tuition cannot be deleted while a plan payment of its waits: the payment would go with it, unmatched. Once declined, it can.
  const bAsk = await api('POST', '/teacher/plan/requests', B.T, { plan: 'basic', months: 1 });
  const blocked = await api('POST', '/teacher/tuition/delete', B.T, { secret: PASSWORD });
  check('a tuition with a plan payment waiting cannot be deleted', bAsk.status === 201 && blocked.status === 409 && code(blocked) === 'plan_payment_waiting', [bAsk.body, blocked.body]);
  check('and nothing of it went', !!(await one('select 1 as x from tuitions where id = $1', [B.tuition])));
  await api('POST', `/admin/plans/requests/${bAsk.body.request.id}/decline`, DEV, {});
  const deleted = await api('POST', '/teacher/tuition/delete', B.T, { secret: PASSWORD });
  check('once the payment is declined, the tuition can be deleted', deleted.status === 200 && !(await one('select 1 as x from tuitions where id = $1', [B.tuition])), deleted.body);
} catch (e) {
  fail++;
  console.log('FAIL  the run stopped:', e);
} finally {
  // The settings go back as they were, and what this run made goes; a deleted tuition's plan payments keep its name.
  await db.query(`delete from app_settings where key like 'plan\\_%' or key like 'credit\\_%'`);
  for (const s of settingsBefore) await db.query('insert into app_settings (key, value) values ($1, $2::jsonb)', [s.key, JSON.stringify(s.value)]);
  if (created.tuitions.length) {
    await db.query('delete from tuitions where id = any($1::uuid[])', [created.tuitions]);
    const kept = Number((await one('select count(*) as n from plan_periods where tuition_id is null and client_name = any($1::text[])', [created.names])).n);
    check('a deleted tuition\'s plan payments stay on record under its name', kept === 5, kept);
    await db.query('delete from plan_periods where tuition_id is null and client_name = any($1::text[])', [created.names]);
  }
  if (created.users.length) await db.query('delete from users where id = any($1::uuid[])', [created.users]);
  await db.end();
  const { pool } = await import('../api/src/lib/db.ts');
  await pool.end().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
