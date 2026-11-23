// Checks the AI answer checks end to end with scripted models, so each way they can go right or wrong happens on cue: two models that
// agree, split, doubt or find two right options; a model that is down, rate-limited, or answers with junk; the writer's own answer;
// and the second opinion that fills in what the first two could not. The API runs in this process against the dev database; every call
// to Groq and Gemini is answered by a script (nothing leaves the machine), so it needs no AI keys and spends no quota.
// Makes its own paper and removes it again. Dev only.
// Usage: node tools/answers-test.ts
import { readFileSync } from 'node:fs';
import pg from 'pg';

process.loadEnvFile('.env.local');
// No AI keys are needed (every call is scripted), so the secrets file is optional.
try { process.loadEnvFile('api/.env.secrets'); } catch {}
// Dev only: a database on this PC (tools/local-stack.mjs), or the dev branch whose host DEV_DATABASE_HOST names.
const devHosts = ['127.0.0.1', 'localhost', process.env.DEV_DATABASE_HOST].filter(Boolean);
const dbHost = (() => { try { return new URL(String(process.env.DATABASE_URL)).hostname; } catch { return ''; } })();
if (process.env.NEON_BRANCH !== 'dev' || !devHosts.includes(dbHost)) throw new Error('This only runs against a dev database.');
process.env.AI_DAILY_CALLS = '1000000';
process.env.PUSH_DRY_RUN = '1';
// The models are named here whatever the machine's own settings say, and Gemini is "configured" so its models are in the chains.
process.env.GEMINI_API_KEY ||= 'test-key';
process.env.GROQ_API_KEYS ||= 'test-key-a,test-key-b';
delete process.env.GROQ_SOLVE_MODELS;
delete process.env.GROQ_CHECK_MODELS;
delete process.env.GROQ_TIEBREAK_MODELS;
delete process.env.GROQ_WRITE_MODELS;

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `  -> ${JSON.stringify(detail)}`}`);
}

// ------------------------------------------------------------------------------------------------ the scripted providers
// A question's text carries what each model says about it, in square brackets: [120b=B 20b=B g35=C]. A letter (or letters) is the
// list of options that model finds correct, "-" is "none is correct", "skip" leaves the question out of its reply. "fig" says it needs
// its figure (and so finds none correct); "wB" says its words are enough and B is correct. Without either it says nothing of a figure.
const SHORT: Record<string, string> = {
  'openai/gpt-oss-120b': '120b', 'openai/gpt-oss-20b': '20b', 'gemini-3.5-flash': 'g35', 'gemini-3.6-flash': 'g36',
  'gemini-3.1-flash-lite': 'gl', 'gemini-3.5-flash-lite': 'gl35', 'qwen/qwen3.8-27b': 'qw',
};
type Down = 'ok' | 'rate' | 'junk' | 'overloaded';
const state = { down: {} as Record<string, Down>, calls: [] as { model: string; ids: string[]; task: 'check' | 'write' }[], written: [] as unknown[] };
const reset = () => { state.down = {}; state.calls = []; };

const says = (text: string, who: string): string | undefined => new RegExp(`\\[[^\\]]*\\b${who}=([A-D]+|-|skip|fig|w[A-D]+)(?=[\\s\\]])[^\\]]*\\]`).exec(text)?.[1];
const letters = (v: string): string[] => (v === '-' ? [] : v.split(''));

function reply(model: string, userText: string): { status: number; body: unknown; headers?: Record<string, string> } {
  const short = SHORT[model] ?? model;
  const mode = state.down[short] ?? 'ok';
  if (mode === 'rate' || mode === 'overloaded') state.calls.push({ model, ids: [], task: 'check' });
  if (mode === 'rate') return { status: 429, body: { error: { message: 'rate limit reached' } }, headers: { 'retry-after': '2' } };
  if (mode === 'overloaded') return { status: 503, body: { error: { code: 503, message: 'This model is currently experiencing high demand.' } } };
  let content: string;
  if (userText.startsWith('Write exactly')) {
    state.calls.push({ model, ids: [], task: 'write' });
    content = JSON.stringify({ name: 'Scripted test', questions: state.written });
  } else if (mode === 'junk') {
    state.calls.push({ model, ids: [], task: 'check' });
    content = 'Sorry, I cannot help with that.';
  } else {
    const qs: { id: string; question: string }[] = JSON.parse(userText.slice(userText.indexOf('Questions:\n') + 'Questions:\n'.length));
    state.calls.push({ model, ids: qs.map((x) => x.id), task: 'check' });
    const answers = qs.flatMap((x) => {
      const v = says(x.question, short);
      if (v === undefined || v === 'skip') return [];
      if (v === 'fig') return [{ id: x.id, figure: true, correct: [], confidence: 0.97 }];
      if (v.startsWith('w')) return [{ id: x.id, figure: false, correct: letters(v.slice(1)), confidence: 0.97 }];
      return [{ id: x.id, correct: letters(v), confidence: 0.97 }];
    });
    content = JSON.stringify({ answers });
  }
  return { status: 200, body: { __content: content } };
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const json = (r: { status: number; body: any; headers?: Record<string, string> }, shape: 'groq' | 'gemini') => {
    const body = r.body && '__content' in r.body
      ? shape === 'groq'
        ? { choices: [{ message: { content: r.body.__content } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }
        : { candidates: [{ content: { parts: [{ text: r.body.__content }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 } }
      : r.body;
    return new Response(JSON.stringify(body), { status: r.status, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } });
  };
  if (url.startsWith('https://api.groq.com/')) {
    const b = JSON.parse(String(init.body));
    return json(reply(b.model, b.messages[b.messages.length - 1].content), 'groq');
  }
  if (url.startsWith('https://generativelanguage.googleapis.com/')) {
    const model = /models\/([^:]+):/.exec(url)![1];
    const b = JSON.parse(String(init.body));
    return json(reply(model, b.contents[b.contents.length - 1].parts[0].text), 'gemini');
  }
  return realFetch(input, init);
}) as typeof fetch;

const { default: app } = await import('../api/src/index.ts');
const logins = JSON.parse(readFileSync('tools/out/sample-logins.dev.json', 'utf8'));
const MATHS = '00000000-0000-4000-8000-000000000001';

async function api(method: string, path: string, token?: string, body?: unknown) {
  const res = await app.fetch(new Request(`http://test${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-app': 'tuition_app/1.7.0+9', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }));
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
await db.connect();
const login = await api('POST', '/auth/login', undefined, { username: logins.teacher.username, secret: logins.teacher.password });
const T = login.body?.token as string;
check('the tutor logs in', !!T, login.body);

/** The questions a scripted writer gives; the options are A to D, and `writer` is the option it says is right (or a word that is none). */
function scripted(items: { tag: string; writer: number | string }[]) {
  state.written = items.map((it, i) => {
    const options = [`opt ${i}a`, `opt ${i}b`, `opt ${i}c`, `opt ${i}d`];
    return { text: `Question ${i + 1} ${it.tag}`, options, answer: typeof it.writer === 'number' ? options[it.writer] : it.writer };
  });
}

const papers: string[] = [];
async function makePaper(items: { tag: string; writer: number | string }[]) {
  scripted(items);
  // The writer is never "down" in these scenarios: only the checks are being tried.
  const down = state.down;
  state.down = {};
  const made = await api('POST', '/teacher/papers/chat', T, { class_level: 9, subject_id: MATHS, request: 'Scripted questions', count: items.length });
  state.down = down;
  if (made.status !== 201) throw new Error(`could not make the paper: ${made.status} ${JSON.stringify(made.body)}`);
  papers.push(made.body.paper.id);
  return made.body.paper.id as string;
}
/** Makes a paper AI wrote look like an uploaded one: its questions are somebody's own, so a split is worth a stronger model's time. */
const asUploaded = (P: string) => db.query(`update papers set category = 'Unit test' where id = $1`, [P]);
const read = async (P: string) => {
  const d = (await api('GET', `/teacher/papers/${P}`, T)).body;
  return new Map<number, any>(d.drafts.map((x: any) => [Number(/Question (\d+)/.exec(x.text)![1]), x]));
};
/** Runs the answers (as the app does, until nothing is left) and then the second opinions. */
async function check_paper(P: string, { second = true } = {}) {
  let last: any;
  for (let i = 0; i < 6; i++) {
    last = await api('POST', `/teacher/papers/${P}/answers`, T);
    if (last.status !== 200 || last.body.tried === 0) break;
  }
  let sec: any = null;
  if (second) {
    for (let i = 0; i < 6; i++) {
      sec = await api('POST', `/teacher/papers/${P}/second-opinion`, T);
      if (sec.status !== 200 || sec.body.tried === 0) break;
    }
  }
  return { last, sec };
}

try {
  // ---------------------------------------------------------------- what two models say
  {
    reset();
    const P = await makePaper([
      { tag: '[120b=B gl=B]', writer: 1 },
      { tag: '[120b=B gl=BD]', writer: 1 },
      { tag: '[120b=B gl=-]', writer: 1 },
      { tag: '[120b=- gl=-]', writer: 1 },
      { tag: '[120b=A gl=A]', writer: 2 },
      { tag: '[120b=C gl=C]', writer: 'not an option at all' },
      { tag: '[120b=D gl=D]', writer: 3 },
      { tag: '[120b=B gl=C g35=C]', writer: 2 },
    ]);
    const r = await check_paper(P, { second: false });
    const d = await read(P);
    check('/answers answers', r.last.status === 200, r.last);
    check('two models of different families that choose the same option mark it, and say so', d.get(1).correct_option === 1 && d.get(1).answer_source === 'ai' && d.get(1).ai_note === null && d.get(1).ai_votes === null, d.get(1));
    check('one that found two right options blocks the mark', d.get(2).correct_option === null && d.get(2).ai_note === 'disagree' && d.get(2).answer_checked === true && d.get(2).ai_votes === null, d.get(2));
    check('one that found none, against one that chose: not marked, "unsure"', d.get(3).correct_option === null && d.get(3).ai_note === 'unsure' && d.get(3).ai_votes === null, d.get(3));
    check('both finding none is a misprint', d.get(4).correct_option === null && d.get(4).ai_note === 'no_option', d.get(4));
    check('marked against what the writer meant: marked, flagged, and the card shows who chose what', d.get(5).correct_option === 0 && d.get(5).ai_note === 'writer_differs' && d.get(5).ai_picks?.writer === 2 && d.get(5).ai_picks?.solver === 0, d.get(5));
    check('a question whose writer had no answer of its own is never marked', d.get(6).correct_option === null && d.get(6).ai_note === 'unsure', d.get(6));
    check('and the rest of that batch is marked as usual', d.get(7).correct_option === 3 && d.get(7).ai_note === null, d.get(7));
    check('a question AI wrote that the two split on is not sent to a stronger model: the writer replaces it', d.get(8).correct_option === null && d.get(8).ai_note === 'disagree' && d.get(8).ai_votes === null && d.get(8).answer_checked === true, d.get(8));
    const asked = state.calls.filter((c) => c.task === 'check');
    check('both models are asked once for each batch of six (and the last two questions)', asked.length === 4 && asked.slice(0, 2).every((c) => c.ids.length === 6) && asked.slice(2).every((c) => c.ids.length === 2), asked);
    check('and they are the solver and the checker, not the stronger ones', new Set(asked.map((c) => c.model)).size === 2 && asked.every((c) => ['openai/gpt-oss-120b', 'gemini-3.1-flash-lite'].includes(c.model)), asked);
  }

  // ---------------------------------------------------------------- they split: a stronger model decides
  {
    reset();
    const P = await makePaper([
      { tag: '[120b=B gl=C g35=C]', writer: 2 },
      { tag: '[120b=B gl=C g35=B]', writer: 1 },
      { tag: '[120b=B gl=C g35=A]', writer: 1 },
      { tag: '[120b=B gl=C g35=- g36=- qw=-]', writer: 1 },
      { tag: '[120b=B gl=C g35=skip g36=C]', writer: 2 },
    ]);
    await asUploaded(P);
    const first = await api('POST', `/teacher/papers/${P}/answers`, T);
    check('the answers step marks nothing the models split on, and says how many wait', first.status === 200 && first.body.by_ai === 0 && first.body.second === 5, first.body);
    let d = await read(P);
    check('they wait, with what each said kept', [1, 2, 3, 4, 5].every((n) => d.get(n).ai_votes?.solver && d.get(n).ai_votes?.checker && d.get(n).correct_option === null), d.get(1));
    const sec = await check_paper(P);
    d = await read(P);
    check('a stronger model that sides with one of them settles it', d.get(1).correct_option === 2 && d.get(1).ai_votes === null && d.get(1).ai_note === null, d.get(1));
    check('whichever it sides with', d.get(2).correct_option === 1 && d.get(2).ai_note === null, d.get(2));
    check('three different answers settle nothing', d.get(3).correct_option === null && d.get(3).ai_note === 'disagree' && d.get(3).ai_votes === null, d.get(3));
    check('a stronger model that doubts keeps it from being marked', d.get(4).correct_option === null && d.get(4).ai_note === 'disagree', d.get(4));
    check('a stronger model that leaves a question out is followed by the next one, for that question only', d.get(5).correct_option === 2, d.get(5));
    const g36 = state.calls.filter((c) => c.model === 'gemini-3.6-flash' && c.task === 'check');
    check('and only that question went to it', g36.length === 1 && g36[0].ids.length === 1, g36);
    check('/second-opinion says what it did', sec.sec.status === 200 && sec.sec.body.left === 0, sec.sec);
  }

  // ---------------------------------------------------------------- one of the first two is down
  {
    reset();
    state.down['120b'] = 'rate';
    const P = await makePaper([{ tag: '[20b=B gl=B]', writer: 1 }, { tag: '[20b=A gl=C]', writer: 0 }]);
    await asUploaded(P);
    const r = await api('POST', `/teacher/papers/${P}/answers`, T);
    let d = await read(P);
    check('the solver is out of allowance: the smaller model of its family stands in, in the same call', r.status === 200 && d.get(1).correct_option === 1 && d.get(1).ai_votes === null, [r.body, d.get(1)]);
    check('and what it splits on with the checker waits for a stronger model, as it would have', d.get(2).correct_option === null && d.get(2).ai_votes?.solver?.by === 'openai/gpt-oss-20b', d.get(2));

    reset();
    state.down['gl'] = 'overloaded';
    const P2 = await makePaper([{ tag: '[120b=B qw=B]', writer: 1 }]);
    await api('POST', `/teacher/papers/${P2}/answers`, T);
    d = await read(P2);
    check('the checker is down: Qwen stands in for it in the same call, and is another family', d.get(1).correct_option === 1 && d.get(1).ai_note === null, d.get(1));

    reset();
    state.down['gl'] = 'overloaded';
    state.down['gl35'] = 'overloaded';
    state.down['qw'] = 'rate';
    const P3 = await makePaper([{ tag: '[120b=B g35=B]', writer: 1 }, { tag: '[120b=B g35=C]', writer: 1 }, { tag: '[120b=A g35=A]', writer: 0 }]);
    await asUploaded(P3);
    const r3 = await api('POST', `/teacher/papers/${P3}/answers`, T);
    check('the checker and its stand-in are down: the call still succeeds, with what the solver said', r3.status === 200 && r3.body.tried === 3 && r3.body.by_ai === 0 && r3.body.second === 3, r3.body);
    d = await read(P3);
    check('and each question keeps that opinion, waiting for another family', [1, 2, 3].every((n) => d.get(n).ai_votes?.solver && !d.get(n).ai_votes?.checker && d.get(n).answer_checked === true && d.get(n).correct_option === null), d.get(1));
    state.calls = [];
    await check_paper(P3);
    d = await read(P3);
    const order = state.calls.filter((c) => c.task === 'check').map((c) => SHORT[c.model]);
    check('the missing check is asked again first, and when its models are still down a stronger one fills in', order[0] === 'gl' && order.includes('qw') && order.includes('g35'), order);
    check('the stronger model, with the one that was heard, marks what they agree on', d.get(1).correct_option === 1 && d.get(3).correct_option === 0, [d.get(1).correct_option, d.get(3).correct_option]);
    check('and when they disagree it stays with the tutor, not "not checked"', d.get(2).correct_option === null && d.get(2).ai_note === 'disagree' && d.get(2).ai_votes === null, d.get(2));
  }

  // ---------------------------------------------------------------- nobody could be asked
  {
    reset();
    state.down['120b'] = 'rate';
    state.down['20b'] = 'rate';
    state.down['gl'] = 'rate';
    state.down['gl35'] = 'rate';
    state.down['qw'] = 'rate';
    const P = await makePaper([{ tag: '[120b=B gl=B]', writer: 1 }, { tag: '[120b=B gl=B]', writer: 1 }]);
    const r = await api('POST', `/teacher/papers/${P}/answers`, T);
    check('everyone down: AI is busy, and the app is told to wait', r.status === 503 && r.body.error.code === 'ai_busy', r);
    let d = await read(P);
    check('the questions are given back, untouched, for the next call', [1, 2].every((n) => d.get(n).answer_checked === false && d.get(n).ai_votes === null && d.get(n).correct_option === null), d.get(1));
    state.down = {};
    const again = await check_paper(P);
    d = await read(P);
    check('and when the models are back they are checked as if nothing happened', again.last.status === 200 && d.get(1).correct_option === 1 && d.get(2).correct_option === 1, [d.get(1), again]);

    reset();
    state.down['120b'] = 'junk';
    state.down['20b'] = 'junk';
    const P2 = await makePaper([{ tag: '[120b=B gl=B g35=B]', writer: 1 }]);
    const j = await api('POST', `/teacher/papers/${P2}/answers`, T);
    d = await read(P2);
    check('models that answer with junk count as down: the checker is kept, waiting', j.status === 200 && d.get(1).ai_votes?.checker && !d.get(1).ai_votes?.solver && d.get(1).correct_option === null, d.get(1));
    state.down = {};
    await check_paper(P2);
    d = await read(P2);
    check('and when they are back the question is finished', d.get(1).correct_option === 1, d.get(1));
  }

  // ---------------------------------------------------------------- a question that could not be checked at all
  {
    reset();
    const P = await makePaper([{ tag: '[120b=B gl=B]', writer: 1 }, { tag: '[gl=B]', writer: 1 }]);
    // The solver answers the first and skips the second; the checker and the stronger models are all down.
    state.down['gl'] = 'overloaded';
    state.down['gl35'] = 'overloaded';
    state.down['qw'] = 'rate';
    state.down['g35'] = 'rate';
    state.down['g36'] = 'rate';
    await check_paper(P);
    let d = await read(P);
    check('a question whose checks cannot be made, twice, is "not checked", with the one opinion kept for the tutor', d.get(1).correct_option === null && d.get(1).ai_note === 'unchecked' && d.get(1).answer_checked === true && d.get(1).ai_votes === null && d.get(1).ai_picks?.solver === 1, d.get(1));
    check('a question nobody said anything about is "not checked" too, after two tries', d.get(2).correct_option === null && d.get(2).ai_note === 'unchecked', d.get(2));
    const replaced = await api('POST', `/teacher/papers/${P}/replace`, T);
    check('and it is never replaced for that: it says nothing about the question', replaced.status === 200 && replaced.body.replaced === 0, replaced.body);
    const idle = await api('POST', `/teacher/papers/${P}/answers`, T);
    check('it is not asked again at once', idle.status === 200 && idle.body.tried === 0, idle.body);

    // A few minutes later, with the models back, the paper is opened and the question is looked at from the start.
    await db.query(`update paper_drafts set answer_claimed_at = now() - interval '5 minutes' where paper_id = $1`, [P]);
    state.down = {};
    const later = await check_paper(P);
    d = await read(P);
    check('a few minutes later it is looked at again, from the start', later.last.status === 200 && d.get(1).correct_option === 1 && d.get(1).ai_note === null && d.get(1).answer_source === 'ai', d.get(1));
  }

  // ---------------------------------------------------------------- one family is never enough
  {
    reset();
    state.down['gl'] = 'overloaded';
    state.down['gl35'] = 'overloaded';
    state.down['qw'] = 'overloaded';
    state.down['g35'] = 'overloaded';
    state.down['g36'] = 'overloaded';
    const P = await makePaper([{ tag: '[120b=B 20b=B]', writer: 1 }]);
    await check_paper(P);
    const d = await read(P);
    check("the solver and its own family's stand-in never settle a question between them", d.get(1).correct_option === null && d.get(1).ai_note === 'unchecked', d.get(1));
  }

  // ---------------------------------------------------------------- a model that leaves questions out
  {
    reset();
    const P = await makePaper([
      { tag: '[120b=B 20b=B gl=skip qw=B]', writer: 1 },
      { tag: '[120b=C gl=C]', writer: 2 },
      { tag: '[120b=skip 20b=skip gl=skip qw=skip]', writer: 1 },
    ]);
    await api('POST', `/teacher/papers/${P}/answers`, T);
    let d = await read(P);
    check('a question one model skipped is asked of the next one in its chain, and marked', d.get(1).correct_option === 1, d.get(1));
    check('one all of them skipped is asked again, not given up on', d.get(3).answer_checked === false && d.get(3).correct_option === null, d.get(3));
    await api('POST', `/teacher/papers/${P}/answers`, T);
    d = await read(P);
    check('and after the second try it could not be checked', d.get(3).answer_checked === true && d.get(3).correct_option === null && d.get(3).ai_note === 'unchecked', d.get(3));
  }

  // ---------------------------------------------------------------- whether a question needs its figure: the solver's word decides
  {
    reset();
    const P = await makePaper([
      { tag: '[120b=fig gl=-]', writer: 1 },
      { tag: '[120b=fig gl=B]', writer: 1 },
      { tag: '[120b=wB gl=B]', writer: 1 },
      { tag: '[120b=wC gl=fig]', writer: 2 },
      { tag: '[120b=fig gl=fig]', writer: 1 },
      { tag: '[120b=fig gl=-]', writer: 1 },
      { tag: '[120b=wB gl=B]', writer: 1 },
      { tag: '[120b=fig gl=-]', writer: 1 },
      { tag: '[120b=wB gl=B]', writer: 1 },
    ]);
    await asUploaded(P);
    const d0 = await read(P);
    const wire = 'Due to heavy storm, an electric wire got bent in a mathematical shape. The shape of the bent wire is represented by the following graph.';
    const box = { page: 1, box: [0.1, 0.1, 0.5, 0.3] };
    // 1 and 2 share one passage and its graph; the reader boxed the graph for 1 only and flagged neither. 3 it flagged though its
    // words are enough. 5 the tutor said needs no figure. 6 needs one and is not of 1's group.
    await db.query(`update paper_drafts set figure_box = $2::jsonb, text = $3 || E'\\n\\n' || text where id = $1`, [d0.get(1).id, JSON.stringify(box), wire]);
    await db.query(`update paper_drafts set text = $2 || E'\\n\\n' || text where id = $1`, [d0.get(2).id, wire]);
    await db.query('update paper_drafts set needs_diagram = true where id = $1', [d0.get(3).id]);
    await db.query(`update paper_drafts set figure_by = 'tutor' where id = $1`, [d0.get(5).id]);
    // 7 and 8 are held as unclear (the reader filled in a symbol) and flagged: 7's words are enough, 8 needs its figure. 9 the tutor
    // reworded (it is hers), without a word about its figure: the checks still say whether it needs one.
    await db.query(`update paper_drafts set needs_diagram = true, answer_checked = true, ai_note = 'unclear' where id = any($1::uuid[])`, [[d0.get(7).id, d0.get(8).id]]);
    await db.query('update paper_drafts set needs_diagram = true, edited = true where id = $1', [d0.get(9).id]);
    await check_paper(P, { second: false });
    const d = await read(P);
    const held = (x: any) => x.needs_diagram === true && x.answer_checked === true && x.correct_option === null && x.ai_votes === null && x.ai_note === null;
    check('the solver says it needs its figure: it is held for the tutor, with its figure asked for', held(d.get(1)), d.get(1));
    check('one of its group that the reader gave no box takes the group\'s box',
      held(d.get(2)) && d.get(2).figure_box?.page === 1 && JSON.stringify(d.get(2).figure_box?.box) === JSON.stringify(box.box), d.get(2));
    check('one not of a group gets no box of another question', held(d.get(6)) && d.get(6).figure_box === null, d.get(6));
    check('the solver says its words are enough: the reader\'s flag goes and it is marked', d.get(3).needs_diagram === false && d.get(3).correct_option === 1, d.get(3));
    check('only the checker needs a figure: not held, but not marked either', d.get(4).needs_diagram === false && d.get(4).correct_option === null && d.get(4).ai_note === 'unsure', d.get(4));
    check('the tutor said it needs no figure: the checks never undo that', d.get(5).needs_diagram === false && d.get(5).correct_option === null, d.get(5));
    check('a question held as unclear whose words are enough loses its flag, and stays held for the tutor to check',
      d.get(7).needs_diagram === false && d.get(7).answer_checked === true && d.get(7).ai_note === 'unclear' && d.get(7).correct_option === null, d.get(7));
    check('one held as unclear that needs its figure keeps the flag', d.get(8).needs_diagram === true && d.get(8).ai_note === 'unclear' && d.get(8).correct_option === null, d.get(8));
    check('a question the tutor reworded still has its figure decided by the checks', d.get(9).needs_diagram === false && d.get(9).correct_option === 1, d.get(9));
    state.calls = [];
    const again = await api('POST', `/teacher/papers/${P}/answers`, T);
    check('each held question is asked about its figure once', again.body?.tried === 0 && state.calls.length === 0, { body: again.body, calls: state.calls });
  }

  // ---------------------------------------------------------------- the solver cannot be heard when a held question is asked about its figure
  {
    reset();
    const P = await makePaper([{ tag: '[120b=wB 20b=wB gl=B]', writer: 1 }]);
    await asUploaded(P);
    const id = (await read(P)).get(1).id;
    await db.query(`update paper_drafts set needs_diagram = true, answer_checked = true, ai_note = 'unclear' where id = $1`, [id]);
    const row = async () => (await db.query('select needs_diagram, answer_tries, ai_note, correct_option from paper_drafts where id = $1', [id])).rows[0];
    state.down = { '120b': 'rate', '20b': 'rate' };
    const first = await api('POST', `/teacher/papers/${P}/answers`, T);
    let r = await row();
    check('both gpt-oss models refused: the held question keeps its flag and is not counted as asked',
      first.status === 200 && r.needs_diagram === true && r.answer_tries === 0, { body: first.body, r });
    state.calls = [];
    const soon = await api('POST', `/teacher/papers/${P}/answers`, T);
    check('a call straight after does not ask it again (the app would otherwise call on and on)', soon.body?.tried === 0 && state.calls.length === 0, { body: soon.body, calls: state.calls });
    state.down = {};
    await db.query(`update paper_drafts set answer_claimed_at = now() - interval '4 minutes' where id = $1`, [id]);
    await api('POST', `/teacher/papers/${P}/answers`, T);
    r = await row();
    check('a few minutes on it is asked again: its words are enough, so the flag goes and it stays held',
      r.needs_diagram === false && r.answer_tries === 1 && r.ai_note === 'unclear' && r.correct_option === null, r);
  }

  // ---------------------------------------------------------------- the tutor's mark is hers
  {
    reset();
    const P = await makePaper([{ tag: '[120b=B gl=C g35=B]', writer: 1 }]);
    await asUploaded(P);
    await api('POST', `/teacher/papers/${P}/answers`, T);
    let d = await read(P);
    const marked = await api('PATCH', `/teacher/drafts/${d.get(1).id}`, T, { correct_option: 3 });
    check('the tutor marks a question that waits for its second opinion', marked.status === 200 && marked.body.draft.correct_option === 3, marked.body);
    await api('POST', `/teacher/papers/${P}/second-opinion`, T);
    d = await read(P);
    check('and the second opinion does not change it', d.get(1).correct_option === 3 && d.get(1).answer_source === 'teacher', d.get(1));
  }
} finally {
  for (const P of papers) await api('DELETE', `/teacher/papers/${P}`, T).catch(() => {});
  await db.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
