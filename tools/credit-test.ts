// Checks AI credit end to end (lib/credit.ts, routes/credit.ts): the free start, the price set aside before AI work and charged only
// for what finishes, a page charged once for each picture of it, two jobs at once never spending the same rupees, AI stopping when the
// credit runs out, and adding credit (a tutor's "I have paid", the developer marking it received or declined, or adding it by hand).
// The API runs in this process against the dev database and the local storage (tools/local-stack.mjs); every call to Groq and
// Gemini is answered by a script, so it needs no AI keys. Makes its own tutors and tuitions and removes them again, and puts the
// credit settings back as they were. Dev only.
// Usage: node tools/credit-test.ts
import { randomBytes, randomInt } from 'node:crypto';
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

// ------------------------------------------------------------------------------------------------ the scripted providers
// The writer gives `state.write` questions (or fails when it is null). A page read gives one plain question, or junk when
// `state.page` is 'junk'; `state.slowMs` makes every reply wait, so two requests are under way at once.
const state = { write: 10 as number | null, page: 'ok' as 'ok' | 'junk', slowMs: 0 };
const written = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ text: `Credit question ${i + 1}: what is ${i} + 1?`, work: 'add', options: [`${i}`, `${i + 1}`, `${i + 2}`, `${i + 3}`], answer: `${i + 1}`, difficulty: 'easy' }));
const PAGE = { questions: [{ number: '1', kind: 'mcq', text: 'What is $2 + 2$?', options: ['3', '4', '5', '6'] }], answer_key: [] };

function reply(text: string): { status: number; content?: string } {
  if (text.startsWith('Write exactly')) {
    if (state.write === null) return { status: 503 };
    return { status: 200, content: JSON.stringify({ name: 'Credit test', questions: written(state.write) }) };
  }
  if (text.includes('Transcribe every question')) return state.page === 'junk' ? { status: 200, content: 'Sorry, I cannot read that.' } : { status: 200, content: JSON.stringify(PAGE) };
  // Anything else (the paper's details, answers): nothing found, which every caller takes calmly.
  return { status: 200, content: '{}' };
}

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
  const r = reply(text);
  if (r.status !== 200) return new Response(JSON.stringify({ error: { code: r.status, message: 'This model is currently experiencing high demand.' } }), { status: r.status });
  const body = groq
    ? { choices: [{ message: { content: r.content } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }
    : { candidates: [{ content: { parts: [{ text: r.content }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 } };
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

const db = new pg.Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
await db.connect();
const balance = async (tuition: string) => (await db.query('select credit_paise from tuitions where id = $1', [tuition])).rows[0]?.credit_paise as number;
const holds = async (tuition: string) => Number((await db.query('select count(*) as n from credit_holds where tuition_id = $1', [tuition])).rows[0].n);
const setBalance = (tuition: string, paise: number) => db.query('update tuitions set credit_paise = $2 where id = $1', [tuition, paise]);
const lines = async (tuition: string, kind: string) => (await db.query('select * from credit_ledger where tuition_id = $1 and kind = $2 order by created_at', [tuition, kind])).rows;

const tag = `credit${randomInt(1000, 9999)}`;
const created = { users: [] as string[], tuitions: [] as string[] };
const settingsBefore = (await db.query(`select key, value from app_settings where key like 'credit\\_%'`)).rows;

/** A tutor who signs up and opens a tuition with Class 9 Maths. */
async function newTutor(suffix: string) {
  const su = await api('POST', '/auth/signup-tutor', undefined, { display_name: `Credit ${suffix}`, username: `${tag}.${suffix}`, password: 'longenough1' }, { 'x-install-id': `${tag}-${suffix}` });
  if (su.status !== 201) throw new Error(`sign-up failed: ${JSON.stringify(su.body)}`);
  created.users.push(su.body.user.id);
  const T = su.body.token as string;
  const mk = await api('POST', '/auth/tuitions', T, { name: `${tag} ${suffix}`, groups: [{ class_level: 9, subject_id: MATHS }] });
  if (mk.status !== 201) throw new Error(`tuition failed: ${JSON.stringify(mk.body)}`);
  created.tuitions.push(mk.body.tuition.id);
  return { T, tuition: mk.body.tuition.id as string, user: su.body.user.id as string };
}

/** A paper of `pages` pages, each uploaded to storage as a picture of its own. Returns its id and the upload addresses. */
async function newPaper(T: string, pages: number) {
  const p = await api('POST', '/teacher/papers', T, { pages, class_level: 9, subject_id: MATHS });
  if (p.status !== 201) throw new Error(`paper failed: ${JSON.stringify(p.body)}`);
  const urls = p.body.uploads.map((u: any) => u.put_url as string);
  for (let n = 1; n <= pages; n++) await upload(T, p.body.paper.id, n, urls[n - 1]);
  return { id: p.body.paper.id as string, urls };
}
/** Puts a new picture of a page in storage (a few random bytes: the scripted reader never looks) and tells the server. */
async function upload(T: string, paper: string, n: number, url: string) {
  const put = await realFetch(url, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...randomBytes(64)]) });
  if (!put.ok) throw new Error(`upload failed: ${put.status} ${await put.text()}`);
  const done = await api('POST', `/teacher/papers/${paper}/pages/${n}/uploaded`, T);
  if (done.status !== 200) throw new Error(`uploaded failed: ${JSON.stringify(done.body)}`);
}
const read = (T: string, paper: string, n: number) => api('POST', `/teacher/papers/${paper}/pages/${n}/read`, T);
const pageStatus = async (paper: string, n: number) => (await db.query('select ai_status from paper_pages where paper_id = $1 and page_no = $2', [paper, n])).rows[0]?.ai_status;

try {
  const devLogin = await api('POST', '/auth/login', undefined, { username: logins.developer.username, secret: logins.developer.password });
  const DEV = devLogin.body?.token as string;
  check('the developer logs in', !!DEV, devLogin.body);
  // Every run starts from the prices the migration writes, with paying closed.
  const reset = await api('PUT', '/admin/credit/settings', DEV, { page_paise: 240, question_paise: 60, start_paise: 2000, new_clients_ai: true, upi_id: '', upi_name: '' });
  check('the developer sets the prices', reset.status === 200 && reset.body.settings.page_paise === 240, reset.body);

  // ---------------------------------------------------------------- the free start
  const A = await newTutor('a');
  const startA = await api('GET', '/teacher/credit', A.T);
  check('a new tuition starts with ₹20 of credit', startA.status === 200 && startA.body.credit.balance_paise === 2000 && startA.body.credit.free_paise === 2000, startA.body);
  check('it is told the prices', startA.body.prices?.page_paise === 240 && startA.body.prices?.question_paise === 60, startA.body.prices);
  check('paying is closed until the developer gives a UPI id', startA.body.pay?.open === false && startA.body.pay.code === null && startA.body.pay.upi_id === null, startA.body.pay);
  check('the free start is its first line', startA.body.recent?.length === 1 && startA.body.recent[0].kind === 'start' && startA.body.recent[0].amount_paise === 2000, startA.body.recent);
  const homeA = await api('GET', '/teacher/home', A.T);
  check('Home carries the balance and the prices', homeA.status === 200 && homeA.body.credit?.balance_paise === 2000 && homeA.body.credit.page_paise === 240, homeA.body.credit);

  // ---------------------------------------------------------------- Describe it to AI
  state.write = 10;
  const ten = await api('POST', '/teacher/papers/chat', A.T, { class_level: 9, subject_id: MATHS, request: 'Ten easy sums', count: 10 });
  check('ten questions are written', ten.status === 201 && ten.body.questions === 10, ten.body);
  check('they cost ₹6.00', (await balance(A.tuition)) === 1400, await balance(A.tuition));
  const qLine = (await lines(A.tuition, 'questions'))[0];
  check('the line says ten questions, for that paper', qLine?.questions === 10 && qLine.amount_paise === -600 && qLine.balance_paise === 1400 && qLine.paper_id === ten.body.paper.id, qLine);
  check('nothing is left set aside', (await holds(A.tuition)) === 0);

  state.write = 3;
  const fewer = await api('POST', '/teacher/papers/chat', A.T, { class_level: 9, subject_id: MATHS, request: 'Five sums', count: 5 });
  check('a writer that gives three of five is charged for three', fewer.status === 201 && fewer.body.questions === 3 && (await balance(A.tuition)) === 1220, [fewer.body, await balance(A.tuition)]);

  state.write = 2;
  const more = await api('POST', '/teacher/papers/chat', A.T, { class_level: 9, subject_id: MATHS, request: 'Ten easy sums', count: 2, paper_id: ten.body.paper.id });
  check('adding to a paper is charged too', more.status === 201 && more.body.total === 12 && (await balance(A.tuition)) === 1100, [more.body, await balance(A.tuition)]);

  state.write = null;
  const papersBefore = Number((await db.query('select count(*) as n from papers where tuition_id = $1', [A.tuition])).rows[0].n);
  const failed = await api('POST', '/teacher/papers/chat', A.T, { class_level: 9, subject_id: MATHS, request: 'Ten easy sums', count: 10 });
  check('a writer that fails says so', failed.status >= 500 && String(code(failed)).startsWith('ai_'), failed.body);
  check('and costs nothing', (await balance(A.tuition)) === 1100 && (await holds(A.tuition)) === 0, [await balance(A.tuition), await holds(A.tuition)]);

  state.write = 25;
  const short = await api('POST', '/teacher/papers/chat', A.T, { class_level: 9, subject_id: MATHS, request: 'Lots of sums', count: 25 });
  check('asking for more than the credit covers is refused with 402', short.status === 402 && code(short) === 'no_credit', short.body);
  check('the refusal says what is free and what it needs', short.body?.error?.credit_paise === 1100 && short.body.error.needed_paise === 1500 && /₹15\.00/.test(short.body.error.message), short.body);
  const papersAfter = Number((await db.query('select count(*) as n from papers where tuition_id = $1', [A.tuition])).rows[0].n);
  check('no paper is made and nothing is charged', papersAfter === papersBefore && (await balance(A.tuition)) === 1100, [papersBefore, papersAfter]);

  // ---------------------------------------------------------------- reading pages
  state.page = 'ok';
  const P = await newPaper(A.T, 2);
  const r1 = await read(A.T, P.id, 1);
  check('a page is read', r1.status === 200 && r1.body.drafts?.length === 1, r1.body);
  check('it costs ₹2.40', (await balance(A.tuition)) === 860, await balance(A.tuition));
  const again = await read(A.T, P.id, 1);
  check('reading the same picture again is free', again.status === 200 && (await balance(A.tuition)) === 860, [again.status, await balance(A.tuition)]);
  await upload(A.T, P.id, 1, P.urls[0]);
  const swapped = await read(A.T, P.id, 1);
  check('a new picture of the page is a new page', swapped.status === 200 && (await balance(A.tuition)) === 620, [swapped.status, await balance(A.tuition)]);
  const pageLines = await lines(A.tuition, 'page');
  check('each picture has its own line', pageLines.length === 2 && pageLines.every((l) => l.paper_id === P.id && l.page_no === 1 && l.amount_paise === -240) && pageLines[0].picture !== pageLines[1].picture, pageLines);

  state.page = 'junk';
  const unreadable = await read(A.T, P.id, 2);
  check('a page AI cannot read fails', unreadable.status === 502 && code(unreadable) === 'ai_unreadable', unreadable.body);
  check('and costs nothing', (await balance(A.tuition)) === 620 && (await holds(A.tuition)) === 0, [await balance(A.tuition), await holds(A.tuition)]);
  state.page = 'ok';

  await setBalance(A.tuition, 100);
  const broke = await read(A.T, P.id, 2);
  check('with too little credit a page is refused with 402', broke.status === 402 && code(broke) === 'no_credit' && broke.body.error.credit_paise === 100 && broke.body.error.needed_paise === 240, broke.body);
  check('the page is left as it was', (await pageStatus(P.id, 2)) === 'failed', await pageStatus(P.id, 2));

  // Two pages at once with credit for one: the first sets the price aside, so the second is refused instead of both being read.
  await setBalance(A.tuition, 240);
  const P2 = await newPaper(A.T, 2);
  state.slowMs = 400;
  const both = await Promise.all([read(A.T, P2.id, 1), read(A.T, P2.id, 2)]);
  state.slowMs = 0;
  check('two pages at once with credit for one: one is read, one is refused', both.map((r) => r.status).sort().join() === '200,402', both.map((r) => [r.status, code(r)]));
  check('the credit is spent once, never below zero', (await balance(A.tuition)) === 0 && (await holds(A.tuition)) === 0, [await balance(A.tuition), await holds(A.tuition)]);

  // Credit set aside by a request that died stops counting after twenty minutes.
  await setBalance(A.tuition, 500);
  await db.query(`insert into credit_holds (tuition_id, amount_paise, created_at) values ($1, 500, now() - interval '21 minutes')`, [A.tuition]);
  const late = await read(A.T, P2.id, both[0].status === 200 ? 2 : 1);
  check('a hold left behind for twenty minutes does not block', late.status === 200 && (await balance(A.tuition)) === 260, [late.status, await balance(A.tuition)]);
  check('and is cleared away', (await holds(A.tuition)) === 0, await holds(A.tuition));

  // Pages read together (the switch is off unless turned on): the together-read takes every page only when the credit covers them all.
  process.env.WHOLE_PAPER_READ = 'on';
  await setBalance(A.tuition, 300);
  const W1 = await newPaper(A.T, 2);
  const w1 = await read(A.T, W1.id, 1);
  check('with credit for one of two pages, the page is read on its own', w1.status === 200 && (await balance(A.tuition)) === 60, [w1.status, await balance(A.tuition)]);
  check('and the other page is not taken', (await pageStatus(W1.id, 2)) === 'pending' && (await holds(A.tuition)) === 0, [await pageStatus(W1.id, 2), await holds(A.tuition)]);
  await setBalance(A.tuition, 1000);
  const W2 = await newPaper(A.T, 2);
  const w2 = await read(A.T, W2.id, 1);
  const doneW2 = Number((await db.query(`select count(*) as n from paper_pages where paper_id = $1 and ai_status = 'done'`, [W2.id])).rows[0].n);
  check('with credit for both, each page stored is charged once', w2.status === 200 && doneW2 >= 1 && (await balance(A.tuition)) === 1000 - 240 * doneW2, [w2.status, doneW2, await balance(A.tuition)]);
  check('and nothing is left set aside', (await holds(A.tuition)) === 0, await holds(A.tuition));
  delete process.env.WHOLE_PAPER_READ;

  // ---------------------------------------------------------------- the history
  const history = await api('GET', '/teacher/credit/history', A.T);
  const pageGroup = history.body?.lines?.find((l: any) => l.kind === 'page' && l.paper_id === P.id);
  check('the history puts a paper\'s pages read on one day in one line', history.status === 200 && pageGroup?.pages === 2 && pageGroup.amount_paise === -480, pageGroup ?? history.body);
  const qGroup = history.body?.lines?.find((l: any) => l.kind === 'questions' && l.paper_id === ten.body.paper.id);
  check('and the questions written into a paper', qGroup?.questions === 12 && qGroup.amount_paise === -720, qGroup);
  check('a junk time is refused', (await api('GET', '/teacher/credit/history?before=abc', A.T)).status === 400);

  // ---------------------------------------------------------------- adding credit
  // Credit is no longer sold on its own: AI comes with the plans (Santosh, 24 Nov 2026: "Upgrade only"; tools/plans-test.ts). The
  // app's "I have paid" for credit is refused. The requests below are made as the app before plans made them (askForCredit stays in
  // lib/credit.ts for the day top-ups come back), so the developer's side of them is still checked.
  const { askForCredit, requestOut } = await import('../api/src/lib/credit.ts');
  const ask = (amount: number) =>
    askForCredit(A.tuition, A.user, amount).then(
      (r) => ({ status: 201, body: { request: requestOut(r) } as any }),
      (e) => ({ status: (e.status as number) ?? 500, body: { error: { code: e.code, message: e.message } } as any }),
    );
  const refused = await api('POST', '/teacher/credit/requests', A.T, { amount_paise: 25000 });
  check('the app\'s "I have paid" for credit is refused: AI comes with the plans', refused.status === 409 && code(refused) === 'plans_only', refused.body);
  check('the credit screen says credit is not sold on its own', (await api('GET', '/teacher/credit', A.T)).body?.topups === false);
  const closed = await ask(25000);
  check('"I have paid" is refused while paying is closed', closed.status === 409 && code(closed) === 'no_upi', closed.body);
  const badUpi = await api('PUT', '/admin/credit/settings', DEV, { upi_id: 'not a upi id' });
  check('a UPI id that is not one is refused', badUpi.status === 400, badUpi.body);
  for (const wrong of [{ page_paise: -1 }, { page_paise: 1.5 }, { question_paise: 'x' }, { start_paise: 1_000_000 }, { new_clients_ai: 'yes' }, { upi_name: 'x'.repeat(61) }]) {
    const r = await api('PUT', '/admin/credit/settings', DEV, wrong);
    check(`a wrong setting is refused: ${JSON.stringify(wrong).slice(0, 40)}`, r.status === 400, r.body);
  }
  const open = await api('PUT', '/admin/credit/settings', DEV, { upi_id: 'tuitionpay@okbank', upi_name: 'Sample Payee' });
  check('the developer opens paying', open.status === 200 && open.body.settings.upi_id === 'tuitionpay@okbank', open.body);
  const pay = (await api('GET', '/teacher/credit', A.T)).body.pay;
  check('the tutor is shown where to pay and a code', pay.open === true && pay.upi_id === 'tuitionpay@okbank' && pay.upi_name === 'Sample Payee' && /^CR-[A-HJ-NP-Z2-9]{4}$/.test(pay.code), pay);
  check('the code stays the same', (await api('GET', '/teacher/credit', A.T)).body.pay.code === pay.code);
  check('the amounts on offer are ₹100 to ₹1,000', JSON.stringify(pay.amounts_paise) === '[10000,25000,50000,100000]', pay.amounts_paise);
  for (const amount of [25050, 1000, 2_000_000, -100]) {
    const r = await ask(amount);
    check(`an amount of ${amount} paise is refused`, r.status === 400, r.body);
  }
  const before = await balance(A.tuition);
  const asked = await ask(25000);
  check('"I have paid ₹250" waits to be checked', asked.status === 201 && asked.body.request.status === 'waiting' && asked.body.request.code === pay.code && asked.body.request.upi_id === 'tuitionpay@okbank', asked.body);
  check('the credit is not added before it is checked', (await balance(A.tuition)) === before);
  check('the tutor sees it waiting', (await api('GET', '/teacher/credit', A.T)).body.waiting?.some((w: any) => w.id === asked.body.request.id));
  const queue = await api('GET', '/admin/credit', DEV);
  const mine = queue.body?.waiting?.find((w: any) => w.id === asked.body.request.id);
  check('the developer sees it, with the client and the code', queue.status === 200 && mine?.client === `${tag} a` && mine.code === pay.code && mine.amount_paise === 25000, mine ?? queue.body);
  check('a tutor cannot see the developer\'s list', (await api('GET', '/admin/credit', A.T)).status === 403);
  check('a tutor cannot mark a payment received', (await api('POST', `/admin/credit/requests/${asked.body.request.id}/receive`, A.T, {})).status === 403);
  const got = await api('POST', `/admin/credit/requests/${asked.body.request.id}/receive`, DEV, {});
  check('marked received, the credit goes to the client at once', got.status === 200 && got.body.balance_paise === before + 25000 && (await balance(A.tuition)) === before + 25000, got.body);
  const topup = (await lines(A.tuition, 'topup'))[0];
  check('the line keeps the request and the code', topup?.amount_paise === 25000 && topup.request_id === asked.body.request.id && topup.ref === pay.code, topup);
  const twice = await api('POST', `/admin/credit/requests/${asked.body.request.id}/receive`, DEV, {});
  check('a request is received once', twice.status === 409 && code(twice) === 'already_decided' && (await balance(A.tuition)) === before + 25000, twice.body);
  check('and cannot be declined after', (await api('POST', `/admin/credit/requests/${asked.body.request.id}/decline`, DEV, {})).status === 409);
  check('a request that is not there is not found', (await api('POST', '/admin/credit/requests/00000000-0000-4000-8000-0000000000dd/receive', DEV, {})).status === 404);

  const no = await ask(10000);
  const declined = await api('POST', `/admin/credit/requests/${no.body.request.id}/decline`, DEV, {});
  check('a declined request adds nothing', declined.status === 200 && declined.body.request.status === 'declined' && (await balance(A.tuition)) === before + 25000, declined.body);

  const waitingIds: string[] = [];
  for (let i = 0; i < 5; i++) waitingIds.push((await ask(10000)).body.request.id);
  const sixth = await ask(10000);
  check('five requests may wait at once, not six', sixth.status === 409 && code(sixth) === 'too_many_requests', sixth.body);
  for (const id of waitingIds) await api('POST', `/admin/credit/requests/${id}/decline`, DEV, {});

  const hand = await api('POST', `/admin/clients/${A.tuition}/credit`, DEV, { amount_paise: 5000, ref: 'UTR 428100000217' });
  check('the developer adds credit by hand', hand.status === 201 && hand.body.balance_paise === before + 30000, hand.body);
  const byHand = (await lines(A.tuition, 'by_hand'))[0];
  check('with the reference typed', byHand?.ref === 'UTR 428100000217' && byHand.amount_paise === 5000, byHand);
  check('by hand needs an amount', (await api('POST', `/admin/clients/${A.tuition}/credit`, DEV, { ref: 'x' })).status === 400);
  check('and not one over ₹1,00,000', (await api('POST', `/admin/clients/${A.tuition}/credit`, DEV, { amount_paise: 10_000_001 })).status === 400);
  check('and only for a client that exists', (await api('POST', '/admin/clients/00000000-0000-4000-8000-0000000000dd/credit', DEV, { amount_paise: 100 })).status === 404);

  const clients = await api('GET', '/admin/clients', DEV);
  const row = clients.body?.clients?.find((x: any) => x.id === A.tuition);
  check('the client list shows the credit and this month', clients.status === 200 && row?.credit?.balance_paise === before + 30000 && row.credit.added_month_paise === 30000 && row.credit.used_month_paise > 0, row?.credit);
  const one = await api('GET', `/admin/clients/${A.tuition}`, DEV);
  check('the client page shows the lines', one.status === 200 && one.body.credit?.balance_paise === before + 30000 && one.body.credit.lines?.length > 0 && Array.isArray(one.body.credit.waiting), one.body.credit);
  const month = (await api('GET', '/admin/credit', DEV)).body.month;
  check('the developer sees this month\'s credit and what AI was worth', month && month.credit_added_paise >= 30000 && month.credit_used_paise > 0 && month.pages > 0 && month.questions > 0 && typeof month.ai_worth_inr === 'number', month);

  // ---------------------------------------------------------------- another tuition sees only its own
  const B = await newTutor('b');
  const bCredit = await api('GET', '/teacher/credit', B.T);
  check('another tuition has its own balance', bCredit.body.credit.balance_paise === 2000 && bCredit.body.waiting.length === 0, bCredit.body.credit);
  check('and none of the first tuition\'s lines', !JSON.stringify((await api('GET', '/teacher/credit/history', B.T)).body).includes(P.id));
  check('and its own code', bCredit.body.pay.code !== pay.code);

  // ---------------------------------------------------------------- the settings
  await api('PUT', '/admin/credit/settings', DEV, { page_paise: 300 });
  check('a new price is what tutors are told', (await api('GET', '/teacher/credit', B.T)).body.prices.page_paise === 300);
  const PB = await newPaper(B.T, 1);
  await read(B.T, PB.id, 1);
  check('and what a page costs', (await balance(B.tuition)) === 1700, await balance(B.tuition));
  await api('PUT', '/admin/credit/settings', DEV, { new_clients_ai: false });
  const C = await newTutor('c');
  check('while new clients may not use AI, a new tuition starts with nothing', (await balance(C.tuition)) === 0 && (await lines(C.tuition, 'start')).length === 0);
  const cRead = await api('POST', '/teacher/papers/chat', C.T, { class_level: 9, subject_id: MATHS, request: 'Two sums', count: 2 });
  check('and its AI is stopped', cRead.status === 402 && code(cRead) === 'no_credit', cRead.body);
  check('Home still opens for it', (await api('GET', '/teacher/home', C.T)).status === 200);
} catch (e) {
  fail++;
  console.log('FAIL  the run stopped:', e);
} finally {
  delete process.env.WHOLE_PAPER_READ;
  // The settings go back as they were, and what this run made goes.
  await db.query(`delete from app_settings where key like 'credit\\_%'`);
  for (const s of settingsBefore) await db.query('insert into app_settings (key, value) values ($1, $2::jsonb)', [s.key, JSON.stringify(s.value)]);
  if (created.tuitions.length) {
    const pages = (await db.query('select pp.object_key from paper_pages pp join papers p on p.id = pp.paper_id where p.tuition_id = any($1::uuid[])', [created.tuitions])).rows.map((r) => r.object_key);
    if (pages.length) {
      const { deleteObjects } = await import('../api/src/lib/storage.ts');
      await deleteObjects(pages).catch(() => {});
    }
    await db.query('delete from tuitions where id = any($1::uuid[])', [created.tuitions]);
  }
  if (created.users.length) await db.query('delete from users where id = any($1::uuid[])', [created.users]);
  await db.end();
  const { pool } = await import('../api/src/lib/db.ts');
  await pool.end().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
