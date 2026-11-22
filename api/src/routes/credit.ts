import { Hono } from 'hono';
import { tuitionOf, type AppEnv } from '../lib/auth.ts';
import {
  addCredit, askForCredit, balanceOf, creditCode, creditSettings, historyOf, MAX_BY_HAND, requestOut, showCreditCode, TOP_UPS, type CreditSettings,
} from '../lib/credit.ts';
import { q, q1, tx } from '../lib/db.ts';
import { bad, bool, date, HttpError, int, notFound, str, uuid } from '../lib/http.ts';
import { costInr, rupees } from '../lib/pricing.ts';
import { readBody } from './body.ts';

// ---------------------------------------------------------------- the tutor's side
// Mounted behind requireUser('teacher') in index.ts. The credit is the tuition's, so every tutor of it sees and adds to the same.

export const creditRoutes = new Hono<AppEnv>();

/** The AI credit screen: the balance, the prices, where and how to pay, the payments waiting to be checked, and the last few lines. */
creditRoutes.get('/credit', async (c) => {
  const T = tuitionOf(c).id;
  const s = await creditSettings();
  const { balance, free } = await balanceOf(T);
  // Paying is open once the developer has given a UPI id; until then the app says adding credit opens soon.
  const open = s.upiId !== '';
  const waiting = await q(
    `select id, amount_paise, code, upi_id, status, created_at from credit_requests where tuition_id = $1 and status = 'waiting' order by created_at desc`,
    [T],
  );
  return c.json({
    credit: { balance_paise: balance, free_paise: free },
    prices: { page_paise: s.pagePaise, question_paise: s.questionPaise },
    pay: {
      open, upi_id: open ? s.upiId : null, upi_name: open ? s.upiName : null, code: open ? showCreditCode(await creditCode(T)) : null, amounts_paise: TOP_UPS,
    },
    waiting: waiting.map(requestOut),
    recent: await historyOf(T, { limit: 5 }),
  });
});

/** Every line, newest first, thirty at a time: ?before=<the last line's time> gives the thirty before it. */
creditRoutes.get('/credit/history', async (c) => {
  const before = date({ before: c.req.query('before') }, 'before');
  const lines = await historyOf(tuitionOf(c).id, { limit: 31, before });
  return c.json({ lines: lines.slice(0, 30), more: lines.length > 30 });
});

/** "I have paid": asks the developer to find the payment and add the credit. */
creditRoutes.post('/credit/requests', async (c) => {
  const b = await readBody(c);
  // The range is checked with the rest of the request, which says it in rupees.
  const amount = int(b, 'amount_paise')!;
  const r = await askForCredit(tuitionOf(c).id, c.get('user').id, amount);
  return c.json({ request: requestOut(r) }, 201);
});

// ---------------------------------------------------------------- the developer's side
// Mounted behind requireUser('developer') in index.ts.

export const creditAdminRoutes = new Hono<AppEnv>();

// Midnight at the start of this month, India time.
const IST_MONTH = `(date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')`;

const settingsOut = (s: CreditSettings) => ({
  page_paise: s.pagePaise, question_paise: s.questionPaise, start_paise: s.startPaise, new_clients_ai: s.newClientsAi, upi_id: s.upiId, upi_name: s.upiName,
});

/** The requests with their client, as the admin app lists them. */
const REQUESTS = `select r.id, r.amount_paise, r.code, r.upi_id, r.status, r.created_at, r.decided_at, t.id as client_id, t.name as client,
         (select u.display_name from memberships m join users u on u.id = m.user_id where m.tuition_id = t.id and m.role = 'owner' limit 1) as owner
    from credit_requests r join tuitions t on t.id = r.tuition_id`;
const requestRow = (r: any) => ({ ...requestOut(r), client_id: r.client_id, client: r.client, owner: r.owner });

/**
 * This month's credit and what AI cost to give it, at list prices: credit added and used, the pages read and questions written, and
 * what reading a page and writing a question cost on average. Finding answers serves both, so its cost is given on its own.
 */
async function monthFigures() {
  const credit = await q1<{ added: number; used: number; pages: number; questions: number }>(
    `select coalesce(sum(amount_paise) filter (where kind in ('topup', 'by_hand')), 0)::int as added,
            coalesce(-sum(amount_paise) filter (where kind in ('page', 'questions')), 0)::int as used,
            count(*) filter (where kind = 'page')::int as pages,
            coalesce(sum(questions) filter (where kind = 'questions'), 0)::int as questions
       from credit_ledger where created_at >= ${IST_MONTH}`,
  );
  const use = await q<{ task: string; model: string; prompt: number; completion: number }>(
    `select task, model, coalesce(sum(prompt_tokens), 0) as prompt, coalesce(sum(completion_tokens), 0) as completion
       from ai_usage where created_at >= ${IST_MONTH} group by task, model`,
  );
  const cost = (tasks: string[] | null) =>
    use.filter((u) => tasks === null || tasks.includes(u.task)).reduce((a, u) => a + costInr(u.model, Number(u.prompt), Number(u.completion)), 0);
  const pages = credit?.pages ?? 0;
  const questions = credit?.questions ?? 0;
  return {
    credit_added_paise: credit?.added ?? 0,
    credit_used_paise: credit?.used ?? 0,
    pages,
    questions,
    ai_worth_inr: rupees(cost(null)),
    page_cost_inr: pages ? rupees(cost(['read_paper_page', 'detect_paper']) / pages) : null,
    question_cost_inr: questions ? rupees(cost(['write_questions']) / questions) : null,
    answers_cost_inr: rupees(cost(['answer_questions', 'second_opinion'])),
  };
}

/** The credit screen: the prices and payment details, the payments waiting to be checked, the last ones decided, and this month. */
creditAdminRoutes.get('/credit', async (c) => {
  const waiting = await q(`${REQUESTS} where r.status = 'waiting' order by r.created_at`);
  const done = await q(`${REQUESTS} where r.status <> 'waiting' order by r.decided_at desc limit 20`);
  return c.json({
    settings: settingsOut(await creditSettings()),
    waiting: waiting.map(requestRow),
    done: done.map(requestRow),
    month: await monthFigures(),
  });
});

/** A UPI id, or nothing to close paying: name@bank, as UPI apps write it. */
function upiId(v: unknown): string {
  if (v === '' || v === null) return '';
  if (typeof v !== 'string' || !/^[A-Za-z0-9._-]{2,80}@[A-Za-z][A-Za-z0-9.-]{1,40}$/.test(v.trim())) {
    throw bad('That UPI id does not look right. It is written like name@bank.');
  }
  return v.trim();
}

/** Changes the prices, the free start, whether new clients may use AI, and the UPI details. Only the fields sent change. */
creditAdminRoutes.put('/credit/settings', async (c) => {
  const b = await readBody(c);
  const has = (k: string) => Object.hasOwn(b, k);
  const set: [string, unknown][] = [];
  if (has('page_paise')) set.push(['credit_page_paise', int(b, 'page_paise', { min: 0, max: 10000 })]);
  if (has('question_paise')) set.push(['credit_question_paise', int(b, 'question_paise', { min: 0, max: 10000 })]);
  if (has('start_paise')) set.push(['credit_start_paise', int(b, 'start_paise', { min: 0, max: 100000 })]);
  if (has('new_clients_ai')) set.push(['credit_new_clients_ai', bool(b, 'new_clients_ai')]);
  if (has('upi_id')) set.push(['credit_upi_id', upiId(b.upi_id)]);
  if (has('upi_name')) set.push(['credit_upi_name', str(b, 'upi_name', { max: 60, optional: true }) ?? '']);
  await tx(async (cx) => {
    for (const [key, value] of set) {
      await cx.query(`insert into app_settings (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value`, [key, JSON.stringify(value)]);
    }
  });
  return c.json({ settings: settingsOut(await creditSettings()) });
});

/** Marks a waiting request received (the credit goes to the client at once) or declined. A request is decided once. */
async function decide(id: string, to: 'received' | 'declined', by: string, ref: string | null) {
  return tx(async (cx) => {
    const r = await q1(
      `update credit_requests set status = $2, decided_at = now(), decided_by = $3 where id = $1 and status = 'waiting'
       returning id, tuition_id, amount_paise, code, upi_id, status, created_at, decided_at`,
      [id, to, by],
      cx,
    );
    if (!r) {
      const was = await q1<{ status: string }>('select status from credit_requests where id = $1', [id], cx);
      if (!was) throw notFound('This request');
      throw new HttpError(409, 'already_decided', `This request was ${was.status} already.`);
    }
    const balance = to === 'received'
      ? await addCredit(cx, r.tuition_id, r.amount_paise, { kind: 'topup', requestId: r.id, ref: ref ?? showCreditCode(r.code), byUser: by })
      : null;
    return { request: requestOut(r), balance_paise: balance };
  });
}

creditAdminRoutes.post('/credit/requests/:id/receive', async (c) => {
  const id = uuid(c.req.param('id'), 'request id');
  const b = await readBody(c);
  // The UPI transaction id, when the developer gives it; the line keeps the code otherwise.
  const ref = str(b, 'ref', { max: 80, optional: true }) ?? null;
  return c.json(await decide(id, 'received', c.get('user').id, ref));
});

creditAdminRoutes.post('/credit/requests/:id/decline', async (c) => {
  const id = uuid(c.req.param('id'), 'request id');
  return c.json(await decide(id, 'declined', c.get('user').id, null));
});

/** Adds credit by hand: a payment that came without a request, or credit the developer gives. */
creditAdminRoutes.post('/clients/:id/credit', async (c) => {
  const id = uuid(c.req.param('id'), 'client id');
  const b = await readBody(c);
  const amount = int(b, 'amount_paise', { min: 1, max: MAX_BY_HAND })!;
  const ref = str(b, 'ref', { max: 80, optional: true }) ?? null;
  const balance = await tx((cx) => addCredit(cx, id, amount, { kind: 'by_hand', ref, byUser: c.get('user').id }));
  return c.json({ balance_paise: balance }, 201);
});
