// Checks worked solutions written by AI end to end (routes/solutions.ts, lib/solutions.ts, lib/credit.ts; migration 037): a solution
// is kept only when the model's own working reaches the marked answer, and charged only then, at the price set aside; one that
// reaches another answer, needs its figure or names an option by its letter is not kept and costs nothing; a solution that is there
// (the tutor's, or one written while AI worked) is never replaced; the model is never told the marked answer; AI stops when the
// credit runs out; another tuition's tests and questions are out of reach; the tutor editing an AI solution makes it theirs; and a
// student sees it only after handing the test in. The API runs in this process against the dev database; every call to Groq and
// Gemini is answered by a script, so it needs no AI keys. Makes its own tutors, tuitions and student and removes them again, and
// puts the credit settings back as they were. Dev only. Needs migration 037.
// Usage: node tools/solutions-test.ts
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
delete process.env.GROQ_SOLUTION_MODELS;

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `  -> ${JSON.stringify(detail)}`}`);
}

// ------------------------------------------------------------------------------------------------ the scripted model
// Each question's answer is looked up by its text. `down` makes every model busy, `junk` makes the reply no JSON, and `during` runs
// once while the model "works" (to write a solution meanwhile, as another tutor might).
type Said = { steps?: string; answer?: string; figure?: boolean };
const script = new Map<string, Said>();
const state = { calls: 0, prompts: [] as string[], down: false, junk: false, during: null as null | (() => Promise<unknown>) };

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('\n') : '';

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const groq = url.startsWith('https://api.groq.com/');
  const gemini = url.startsWith('https://generativelanguage.googleapis.com/');
  if (!groq && !gemini) return realFetch(input, init);
  state.calls++;
  if (state.down) return new Response(JSON.stringify({ error: { code: 503, message: 'This model is currently experiencing high demand.' } }), { status: 503 });
  const b = JSON.parse(String(init.body));
  const text = groq ? textOf(b.messages[b.messages.length - 1].content) : textOf(b.contents[b.contents.length - 1].parts);
  state.prompts.push(text);
  if (state.during) {
    const run = state.during;
    state.during = null;
    await run();
  }
  const asked = JSON.parse(text.slice(text.indexOf('Questions:\n') + 'Questions:\n'.length)) as { id: string; question: string }[];
  const content = state.junk
    ? 'Sorry, I cannot help with that.'
    : JSON.stringify({ solutions: asked.map((x) => ({ id: x.id, figure: false, steps: '', answer: '', ...script.get(x.question) })) });
  const body = groq
    ? { choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }
    : { candidates: [{ content: { parts: [{ text: content }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 } };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const { default: app } = await import('../api/src/index.ts');
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
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

const db = new pg.Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
await db.connect();
const balance = async (tuition: string) => (await db.query('select credit_paise from tuitions where id = $1', [tuition])).rows[0]?.credit_paise as number;
const holds = async (tuition: string) => Number((await db.query('select count(*) as n from credit_holds where tuition_id = $1', [tuition])).rows[0].n);
const setBalance = (tuition: string, paise: number) => db.query('update tuitions set credit_paise = $2 where id = $1', [tuition, paise]);
const lines = async (tuition: string) => (await db.query(`select * from credit_ledger where tuition_id = $1 and kind = 'solutions' order by created_at`, [tuition])).rows;
const question = async (id: string) => (await db.query('select solution, solution_by_ai from questions where id = $1', [id])).rows[0];

const tag = `sol${randomInt(1000, 9999)}`;
const created = { users: [] as string[], tuitions: [] as string[] };
const settingsBefore = (await db.query(`select key, value from app_settings where key like 'credit\\_%'`)).rows;

/** A tutor who signs up and opens a tuition with Class 9 Maths. */
async function newTutor(suffix: string) {
  const su = await api('POST', '/auth/signup-tutor', undefined, { display_name: `Solutions ${suffix}`, username: `${tag}.${suffix}`, password: 'longenough1' }, { 'x-install-id': `${tag}-${suffix}` });
  if (su.status !== 201) throw new Error(`sign-up failed: ${JSON.stringify(su.body)}`);
  created.users.push(su.body.user.id);
  const T = su.body.token as string;
  const mk = await api('POST', '/auth/tuitions', T, { name: `${tag} ${suffix}`, groups: [{ class_level: 9, subject_id: MATHS }] });
  if (mk.status !== 201) throw new Error(`tuition failed: ${JSON.stringify(mk.body)}`);
  created.tuitions.push(mk.body.tuition.id);
  return { T, tuition: mk.body.tuition.id as string };
}

/** A Class 9 Maths question of the tutor's; the model says `said` when asked about it. */
async function newQuestion(T: string, q: { text: string; options: string[]; correct_option: number; solution?: string }, said?: Said) {
  const text = `${tag} ${q.text}`;
  const r = await api('POST', '/teacher/questions', T, { class_level: 9, subject_id: MATHS, ...q, text });
  if (r.status !== 201) throw new Error(`question failed: ${JSON.stringify(r.body)}`);
  if (said) script.set(text, said);
  return r.body.id as string;
}

const solve = (T: string, test: string, ids: unknown[]) => api('POST', `/teacher/tests/${test}/solutions`, T, { question_ids: ids });
const byId = (r: { body: any }, id: string) => r.body?.solutions?.find((x: any) => x.id === id);

try {
  const devLogin = await api('POST', '/auth/login', undefined, { username: logins.developer.username, secret: logins.developer.password });
  const DEV = devLogin.body?.token as string;
  check('the developer logs in', !!DEV, devLogin.body);
  const reset = await api('PUT', '/admin/credit/settings', DEV, { solution_paise: 40, start_paise: 2000, new_clients_ai: true });
  check('the developer sets the price of a worked solution', reset.status === 200 && reset.body.settings.solution_paise === 40, reset.body);
  check('which is not negative', (await api('PUT', '/admin/credit/settings', DEV, { solution_paise: -1 })).status === 400);
  check('nor more than ₹100', (await api('PUT', '/admin/credit/settings', DEV, { solution_paise: 10001 })).status === 400);

  const A = await newTutor('a');
  const B = await newTutor('b');
  const start = await balance(A.tuition);
  check('a new tuition starts with its free credit', start === 2000, start);
  const prices = (await api('GET', '/teacher/credit', A.T)).body?.prices;
  check('the tutor is told the price of a worked solution', prices?.solution_paise === 40, prices);
  const home = (await api('GET', '/teacher/home', A.T)).body?.credit;
  check('and so is Home', home?.solution_paise === 40, home);

  const steps = '$3x + 5 = 20$\n$3x = 15$\nSo $x = 5$.';
  const right = await newQuestion(A.T, { text: 'If $3x + 5 = 20$, then $x$ is', options: ['3', '5', '15', '25'], correct_option: 1 }, { steps, answer: 'B' });
  // Marked wrong on purpose: AI's working reaches 13, the second option.
  const wrongKey = await newQuestion(A.T, { text: 'The HCF of 26 and 91 is', options: ['7', '13', '26', '91'], correct_option: 0 }, {
    steps: '$26 = 2 \\times 13$ and $91 = 7 \\times 13$\nSo the HCF is 13.', answer: 'B',
  });
  const figure = await newQuestion(A.T, { text: 'In the figure, find the angle x.', options: ['30°', '45°', '60°', '90°'], correct_option: 2 }, { figure: true });
  const letters = await newQuestion(A.T, { text: 'Which of these is prime?', options: ['21', '27', '29', '33'], correct_option: 2 }, {
    steps: '29 has no factors but 1 and itself.\nSo the answer is (c).', answer: 'C',
  });
  const tutors = 'Count on from 2: 3, 4. So 4.';
  const hasOne = await newQuestion(A.T, { text: 'What is $2 + 2$?', options: ['3', '4', '5', '6'], correct_option: 1, solution: tutors }, { steps: 'AI would say 4.', answer: 'B' });
  const race = await newQuestion(A.T, { text: 'What is $9 - 4$?', options: ['4', '5', '6', '13'], correct_option: 1 }, { steps: '$9 - 4 = 5$.\nSo 5.', answer: 'B' });
  const all = [right, wrongKey, figure, letters, hasOne, race];

  // A student of the tuition, made by the tutor (only the dev database allows that), who will write the test.
  const st = await api('POST', '/teacher/students', A.T, { display_name: 'Solutions Student', class_level: 9, username: `${tag}.s`, pin: '2468' });
  check('a student is added', st.status === 201, st.body);
  if (st.body?.student?.id) created.users.push(st.body.student.id);
  const title = `${tag} Unit test`;
  const mk = await api('POST', '/teacher/tests', A.T, {
    title, class_level: 9, subject_id: MATHS, question_ids: all, shuffle: true, assign_all: false, assign_group: false,
    student_ids: [st.body.student.id], closes_at: iso(86_400_000),
  });
  check('a test of the six questions is made', mk.status === 201, mk.body);
  const test = mk.body.id as string;

  // ---------------------------------------------------------------- what may be asked
  check('five questions at once are too many', (await solve(A.T, test, all.slice(0, 5))).status === 400);
  check('none is too few', (await solve(A.T, test, [])).status === 400);
  check('a question id must be an id', (await solve(A.T, test, ['nope'])).status === 400);
  check('the test must be one', (await solve(A.T, 'nope', [right])).status === 400);
  const bTest = await api('POST', '/teacher/tests', B.T, {
    title: `${tag} B's test`, class_level: 9, subject_id: MATHS, question_ids: [await newQuestion(B.T, { text: "B's question", options: ['1', '2', '3', '4'], correct_option: 0 })],
    shuffle: true, assign_all: false, assign_group: true, student_ids: [], closes_at: iso(86_400_000),
  });
  const callsBefore = state.calls;
  const across = await solve(B.T, test, [right]);
  check("another tuition's test is not found", across.status === 404 && code(across) === 'not_found', across.body);
  const mixed = await solve(B.T, bTest.body.id, [right]);
  check("nor is another tuition's question in its own test", mixed.status === 404, mixed.body);
  const notIn = await solve(A.T, test, [right, await newQuestion(A.T, { text: 'Not in the test', options: ['1', '2', '3', '4'], correct_option: 0 })]);
  check('a question not in the test is not found', notIn.status === 404, notIn.body);
  check('and none of those asked AI anything', state.calls === callsBefore, state.calls - callsBefore);
  check('nor touched a question', (await question(right)).solution === null);

  // ---------------------------------------------------------------- four at once
  const first = await solve(A.T, test, [right, wrongKey, figure, letters]);
  check('four questions are answered', first.status === 200 && first.body.solutions.length === 4, first.body);
  check('one AI call answers all four', state.calls === callsBefore + 1, state.calls - callsBefore);
  const prompt = state.prompts.at(-1) ?? '';
  check('the model is never told the marked answers', !/correct/i.test(prompt.slice(prompt.indexOf('Questions:'))), prompt.slice(prompt.indexOf('Questions:')));
  check('a solution reaching the marked answer is written', byId(first, right)?.outcome === 'written' && byId(first, right)?.solution === steps, byId(first, right));
  check('and kept as AI\'s', JSON.stringify(await question(right)) === JSON.stringify({ solution: steps, solution_by_ai: true }), await question(right));
  check('one reaching another answer is not, and says which', JSON.stringify(byId(first, wrongKey)) === JSON.stringify({ id: wrongKey, outcome: 'different', ai_answer: 1 }), byId(first, wrongKey));
  check('one needing its figure is not', byId(first, figure)?.outcome === 'figure', byId(first, figure));
  check('one naming an option by its letter is not', byId(first, letters)?.outcome === 'unusable' && byId(first, letters)?.why === 'names_option', byId(first, letters));
  check('none of those three is kept', (await Promise.all([wrongKey, figure, letters].map(question))).every((x) => x.solution === null && !x.solution_by_ai));
  check('only the one kept is charged', first.body.written === 1 && (await balance(A.tuition)) === start - 40 && first.body.credit_paise === start - 40, [first.body.written, await balance(A.tuition)]);
  const l1 = await lines(A.tuition);
  check('as one line for the test', l1.length === 1 && l1[0].amount_paise === -40 && l1[0].questions === 1 && l1[0].test_id === test && l1[0].label === title, l1);
  check('and nothing stays set aside', (await holds(A.tuition)) === 0);
  const usage = (await db.query(`select count(*)::int as n from ai_usage where tuition_id = $1 and task = 'worked_solutions'`, [A.tuition])).rows[0].n;
  check("the call counts in the tuition's AI use", usage === 1, usage);

  // ---------------------------------------------------------------- never replaced, never charged twice
  const again = await solve(A.T, test, [right, hasOne]);
  check('a question with a solution is left alone', again.status === 200 && again.body.solutions.every((x: any) => x.outcome === 'has_solution'), again.body);
  check('without asking AI', state.calls === callsBefore + 1);
  check("the tutor's own solution stays theirs", JSON.stringify(await question(hasOne)) === JSON.stringify({ solution: tutors, solution_by_ai: false }), await question(hasOne));
  check('and nothing more is charged', (await balance(A.tuition)) === start - 40 && (await lines(A.tuition)).length === 1);

  state.during = () => db.query(`update questions set solution = 'Written by the tutor meanwhile.' where id = $1`, [race]);
  const raced = await solve(A.T, test, [race]);
  check('a solution written while AI worked stays', byId(raced, race)?.outcome === 'has_solution' && (await question(race)).solution === 'Written by the tutor meanwhile.', [raced.body, await question(race)]);
  check('and what AI wrote for it costs nothing', (await balance(A.tuition)) === start - 40 && (await lines(A.tuition)).length === 1 && (await holds(A.tuition)) === 0);

  // ---------------------------------------------------------------- when AI cannot help
  state.junk = true;
  const junk = await solve(A.T, test, [figure]);
  state.junk = false;
  check('a reply that is no JSON keeps nothing', junk.status === 200 && byId(junk, figure)?.outcome === 'unusable' && byId(junk, figure)?.why === 'no_reply', junk.body);
  state.down = true;
  const down = await solve(A.T, test, [figure]);
  state.down = false;
  check('with every model busy it says so', down.status === 503 && code(down) === 'ai_busy', down.body);
  check('and neither of those cost anything or left credit set aside', (await balance(A.tuition)) === start - 40 && (await holds(A.tuition)) === 0);

  await setBalance(A.tuition, 30);
  const calls402 = state.calls;
  const poor = await solve(A.T, test, [figure]);
  check('with less credit than one solution AI stops', poor.status === 402 && code(poor) === 'no_credit' && poor.body.error?.needed_paise === 40, poor.body);
  check('before asking AI anything', state.calls === calls402);
  await setBalance(A.tuition, start - 40);

  // ---------------------------------------------------------------- the tutor fixes the key, at a new price
  await api('PUT', '/admin/credit/settings', DEV, { solution_paise: 25 });
  const q2 = (await api('GET', `/teacher/questions/${wrongKey}`, A.T)).body.question;
  const fixed = await api('PATCH', `/teacher/questions/${wrongKey}`, A.T, { ...q2, correct_option: 1 });
  check('the tutor marks the answer AI reached', fixed.status === 200, fixed.body);
  const second = await solve(A.T, test, [wrongKey]);
  check('then its solution is written', byId(second, wrongKey)?.outcome === 'written', second.body);
  check('at the new price', (await balance(A.tuition)) === start - 65, await balance(A.tuition));
  const history = (await api('GET', '/teacher/credit/history', A.T)).body?.lines ?? [];
  const line = history.find((x: any) => x.kind === 'solutions');
  check("one test's solutions on one day are one line of the history", line?.solutions === 2 && line.amount_paise === -65 && line.label === title && line.test_id === test, history);
  const month = (await api('GET', '/admin/credit', DEV)).body?.month;
  check("the developer's month counts them", month?.solutions >= 2 && 'solution_cost_inr' in month, month);
  const listed = ((await api('GET', '/admin/clients', DEV)).body?.clients ?? []).find((x: any) => x.id === A.tuition)?.credit;
  const opened = (await api('GET', `/admin/clients/${A.tuition}`, DEV)).body?.credit;
  check("and the client's credit used this month, in the list and on its page", listed?.used_month_paise === 65 && opened?.used_month_paise === 65, [listed, opened]);

  // ---------------------------------------------------------------- the tutor's copy
  const page = (await api('GET', `/teacher/tests/${test}`, A.T)).body?.questions ?? [];
  const shown = page.find((x: any) => x.id === right);
  check("the test's page has each solution and whose it is", shown?.solution === steps && shown?.solution_by_ai === true && page.find((x: any) => x.id === hasOne)?.solution_by_ai === false, shown);
  const q1 = (await api('GET', `/teacher/questions/${right}`, A.T)).body.question;
  await api('PATCH', `/teacher/questions/${right}`, A.T, { ...q1, marks: 2 });
  check('saving the question with its solution unchanged keeps it AI\'s', (await question(right)).solution_by_ai === true);
  await api('PATCH', `/teacher/questions/${right}`, A.T, { ...q1, solution: `${steps}\nCheck: $3 \\times 5 + 5 = 20$.` });
  check('changing it makes it the tutor\'s', (await question(right)).solution_by_ai === false);

  // ---------------------------------------------------------------- the student
  await api('POST', `/teacher/tests/${test}/publish`, A.T, { published: true });
  const sl = await api('POST', '/auth/login', undefined, { username: `${tag}.s`, secret: '2468' });
  check('the student logs in', sl.status === 200, sl.body);
  const S = sl.body.token as string;
  const began = await api('POST', `/student/tests/${test}/start`, S);
  check('the student starts the test', began.status === 200 && began.body.questions?.length === 6, began.body);
  check('and is sent no solution while writing it', !/solution/i.test(JSON.stringify(began.body)));
  const handed = await api('POST', `/student/attempts/${began.body.attempt.id}/submit`, S, { answers: [] });
  check('the student hands it in', handed.status === 200, handed.body);
  const result = await api('GET', `/student/attempts/${began.body.attempt.id}/result`, S);
  const review = result.body?.review ?? [];
  check('then sees the solutions', review.find((x: any) => x.id === wrongKey)?.solution?.includes('So the HCF is 13.') && review.find((x: any) => x.id === hasOne)?.solution === tutors, review);
  check('and none where there is none', review.find((x: any) => x.id === figure)?.solution === null, review.find((x: any) => x.id === figure));

  // ---------------------------------------------------------------- a new answer
  const q3 = (await api('GET', `/teacher/questions/${wrongKey}`, A.T)).body.question;
  const rekeyed = await api('PATCH', `/teacher/questions/${wrongKey}`, A.T, { ...q3, correct_option: 2 });
  check("a new answer takes away the solution AI wrote for the old one", rekeyed.status === 200 && JSON.stringify(await question(wrongKey)) === JSON.stringify({ solution: null, solution_by_ai: false }), [rekeyed.body, await question(wrongKey)]);
  const q4 = (await api('GET', `/teacher/questions/${hasOne}`, A.T)).body.question;
  await api('PATCH', `/teacher/questions/${hasOne}`, A.T, { ...q4, correct_option: 2 });
  check("but never the tutor's own", (await question(hasOne)).solution === tutors);

  // ---------------------------------------------------------------- a deleted test
  await api('DELETE', `/teacher/tests/${test}?with_results=1`, A.T);
  const kept = await lines(A.tuition);
  check("a deleted test's lines stay, with its name", kept.length === 2 && kept.every((x) => x.test_id === null && x.label === title), kept);
  const after = (await api('GET', '/teacher/credit/history', A.T)).body?.lines?.find((x: any) => x.kind === 'solutions');
  check('and read as before in the history', after?.solutions === 2 && after.label === title, after);
} catch (e) {
  fail++;
  console.log('FAIL  the run stopped:', e);
} finally {
  // The settings go back as they were, and what this run made goes.
  await db.query(`delete from app_settings where key like 'credit\\_%'`);
  for (const s of settingsBefore) await db.query('insert into app_settings (key, value) values ($1, $2::jsonb)', [s.key, JSON.stringify(s.value)]);
  // The tests first, as the route that deletes a tuition does: a question still in a test cannot go.
  if (created.tuitions.length) await db.query('delete from tests where tuition_id = any($1::uuid[])', [created.tuitions]).catch(() => {});
  if (created.tuitions.length) await db.query('delete from tuitions where id = any($1::uuid[])', [created.tuitions]);
  if (created.users.length) await db.query('delete from users where id = any($1::uuid[])', [created.users]);
  await db.end();
  const { pool } = await import('../api/src/lib/db.ts');
  await pool.end().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
