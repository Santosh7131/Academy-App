import { createHash, randomInt } from 'node:crypto';
import { pool, q, q1, tx, type Db } from './db.ts';
import { aiConfigured } from './groq.ts';
import { HttpError, notFound } from './http.ts';

/**
 * AI credit: each tuition's balance for AI work (api/migrations/033_ai_credit.sql). A route that starts AI work sets its price aside
 * first (hold), charges in the same transaction that saves what the work made (chargePage, chargeQuestions), and lets the hold go
 * when it ends, done or not (release). Work that fails is never charged, and AI stops when the credit runs out. Amounts are paise.
 */

/** How long credit set aside counts. A job takes minutes at most; one whose request died lets its credit go after this. */
export const HOLD_MINUTES = 20;

/** The amounts the app offers when a tutor adds credit. */
export const TOP_UPS = [10000, 25000, 50000, 100000];
/** The least and most one request may ask for, and how many may wait at once. */
const MIN_REQUEST = 5000;
const MAX_REQUEST = 1000000;
const MAX_WAITING = 5;
/** The most the developer may add by hand in one go: ₹1,00,000. */
export const MAX_BY_HAND = 10000000;

export type CreditSettings = { pagePaise: number; questionPaise: number; startPaise: number; newClientsAi: boolean; upiId: string; upiName: string };

/** What a database with no credit settings uses: ₹2.40 a page, ₹0.60 a question, ₹20 to start. The migration writes the same. */
const DEFAULTS: CreditSettings = { pagePaise: 240, questionPaise: 60, startPaise: 2000, newClientsAi: true, upiId: '', upiName: '' };

/** The prices and the rest, from app_settings (the admin app changes them), with the default for any key that is missing. */
export async function creditSettings(db: Db = pool): Promise<CreditSettings> {
  const rows = await q<{ key: string; value: unknown }>(`select key, value from app_settings where key like 'credit\\_%'`, [], db);
  const v = new Map(rows.map((r) => [r.key, r.value]));
  const paise = (k: string, d: number) => {
    const x = v.get(k);
    return typeof x === 'number' && Number.isInteger(x) && x >= 0 ? x : d;
  };
  const text = (k: string) => {
    const x = v.get(k);
    return typeof x === 'string' ? x : '';
  };
  return {
    pagePaise: paise('credit_page_paise', DEFAULTS.pagePaise),
    questionPaise: paise('credit_question_paise', DEFAULTS.questionPaise),
    startPaise: paise('credit_start_paise', DEFAULTS.startPaise),
    newClientsAi: v.has('credit_new_clients_ai') ? v.get('credit_new_clients_ai') === true : DEFAULTS.newClientsAi,
    upiId: text('credit_upi_id'),
    upiName: text('credit_upi_name'),
  };
}

/** "₹1,250.00": an amount as a message says it. */
export const inr = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The answer when the credit left does not cover the work: it carries what is free to spend and what the work needs, so the app can show both. */
export function noCredit(freePaise: number, neededPaise: number) {
  const free = Math.max(freePaise, 0);
  return new HttpError(402, 'no_credit', `This needs ${inr(neededPaise)} of AI credit and you have ${inr(free)}. Add credit to carry on.`, {
    credit_paise: free,
    needed_paise: neededPaise,
  });
}

/** Credit set aside for one job, and the prices it was set aside at: the job is charged at these, whatever changes meanwhile. */
export type Hold = { id: string | null; pagePaise: number; questionPaise: number };

const heldSql = `coalesce((select sum(h.amount_paise) from credit_holds h where h.tuition_id = t.id and h.created_at > now() - interval '${HOLD_MINUTES} minutes'), 0)::int`;

/**
 * Sets the price of AI work aside before it starts: `pages` pages read and `questions` questions written. Throws 402 no_credit when
 * the credit left, less what jobs under way have set aside, does not cover it. Runs in `db` (a transaction the caller holds) or in
 * one of its own. AI that is not set up at all says so first: a tutor is never told to add credit for AI the server does not have.
 */
export async function hold(T: string, work: { pages?: number; questions?: number }, db?: Db): Promise<Hold> {
  if (!aiConfigured()) throw new HttpError(503, 'ai_not_configured', 'AI is not set up on the server yet.');
  const run = async (cx: Db): Promise<Hold> => {
    const s = await creditSettings(cx);
    const amount = (work.pages ?? 0) * s.pagePaise + (work.questions ?? 0) * s.questionPaise;
    // The tuition's row is locked, so two jobs starting at once are set aside one after the other.
    const t = await q1<{ credit_paise: number }>('select credit_paise from tuitions where id = $1 for update', [T], cx);
    if (!t) throw notFound('This tuition');
    await cx.query(`delete from credit_holds where tuition_id = $1 and created_at <= now() - interval '${HOLD_MINUTES} minutes'`, [T]);
    const held = (await q1<{ n: number }>('select coalesce(sum(amount_paise), 0)::int as n from credit_holds where tuition_id = $1', [T], cx))!.n;
    if (t.credit_paise - held < amount) throw noCredit(t.credit_paise - held, amount);
    // Work that costs nothing (a price of ₹0) needs nothing set aside.
    if (amount === 0) return { id: null, pagePaise: s.pagePaise, questionPaise: s.questionPaise };
    const row = await q1<{ id: string }>('insert into credit_holds (tuition_id, amount_paise) values ($1, $2) returning id', [T, amount], cx);
    return { id: row!.id, pagePaise: s.pagePaise, questionPaise: s.questionPaise };
  };
  return db ? run(db) : tx(run);
}

/** Lets a job's credit go when it ends, done or not. Never throws: a hold left behind stops counting after HOLD_MINUTES. */
export async function release(h: Hold | null | undefined) {
  if (h?.id) await pool.query('delete from credit_holds where id = $1', [h.id]).catch(() => {});
}

/** Work that was charged needs its credit set aside no more: the hold shrinks by what was charged, so it is not counted twice. */
async function shrink(cx: Db, h: Hold | null, amount: number) {
  if (!h?.id) return;
  const r = await cx.query('update credit_holds set amount_paise = amount_paise - $2 where id = $1 and amount_paise > $2', [h.id, amount]);
  if (!r.rowCount) await cx.query('delete from credit_holds where id = $1', [h.id]);
}

/** Which picture a page was read from: reading the same picture again is not charged again, and a new picture of the page is. */
export const pictureOf = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex').slice(0, 32);

/**
 * Charges a page AI read, in the transaction that stores it, at the price `h` set aside. A page costs once for each picture read: the
 * app asking again after a reply it never got, or the tutor reading the page again, costs nothing. Returns the balance after.
 */
export async function chargePage(cx: Db, T: string, h: Hold | null, page: { paperId: string; pageNo: number; picture: string }): Promise<number | null> {
  const price = h ? h.pagePaise : (await creditSettings(cx)).pagePaise;
  const t = await q1<{ credit_paise: number }>('select credit_paise from tuitions where id = $1 for update', [T], cx);
  if (!t) return null;
  // Never below zero: credit set aside covers the price, and a hold that ran out (a job past HOLD_MINUTES) takes what is left.
  const amount = Math.min(price, t.credit_paise);
  if (amount <= 0) return t.credit_paise;
  const after = t.credit_paise - amount;
  const line = await q1(
    `insert into credit_ledger (tuition_id, kind, amount_paise, balance_paise, paper_id, page_no, picture, label)
     values ($1, 'page', $2, $3, $4, $5, $6, (select exam_name from papers where id = $4))
     on conflict (paper_id, page_no, picture) where kind = 'page' do nothing returning id`,
    [T, -amount, after, page.paperId, page.pageNo, page.picture],
    cx,
  );
  if (!line) return t.credit_paise; // this picture of the page was paid for already
  await cx.query('update tuitions set credit_paise = $2 where id = $1', [T, after]);
  await shrink(cx, h, amount);
  return after;
}

/** Charges the questions AI wrote, in the transaction that saves them, at the price `h` set aside. Returns the balance after. */
export async function chargeQuestions(cx: Db, T: string, h: Hold | null, work: { paperId: string; count: number; label: string }): Promise<number | null> {
  if (work.count <= 0) return null;
  const price = h ? h.questionPaise : (await creditSettings(cx)).questionPaise;
  const t = await q1<{ credit_paise: number }>('select credit_paise from tuitions where id = $1 for update', [T], cx);
  if (!t) return null;
  const amount = Math.min(price * work.count, t.credit_paise);
  if (amount <= 0) return t.credit_paise;
  const after = t.credit_paise - amount;
  await cx.query(
    `insert into credit_ledger (tuition_id, kind, amount_paise, balance_paise, paper_id, questions, label) values ($1, 'questions', $2, $3, $4, $5, $6)`,
    [T, -amount, after, work.paperId, work.count, work.label],
  );
  await cx.query('update tuitions set credit_paise = $2 where id = $1', [T, after]);
  await shrink(cx, h, amount);
  return after;
}

/** A new tuition's free credit to start with, in the transaction that makes it. None while new clients may not use AI. */
export async function startCredit(cx: Db, T: string): Promise<number> {
  const s = await creditSettings(cx);
  if (!s.newClientsAi || s.startPaise <= 0) return 0;
  const t = await q1<{ credit_paise: number }>('update tuitions set credit_paise = credit_paise + $2 where id = $1 returning credit_paise', [T, s.startPaise], cx);
  await cx.query(`insert into credit_ledger (tuition_id, kind, amount_paise, balance_paise) values ($1, 'start', $2, $3)`, [T, s.startPaise, t!.credit_paise]);
  return s.startPaise;
}

/** Adds credit the developer received (a request marked received, or by hand), in the caller's transaction. Returns the balance after. */
export async function addCredit(
  cx: Db,
  T: string,
  amount: number,
  line: { kind: 'topup' | 'by_hand'; requestId?: string | null; ref?: string | null; byUser: string },
): Promise<number> {
  const t = await q1<{ credit_paise: number }>('update tuitions set credit_paise = credit_paise + $2 where id = $1 returning credit_paise', [T, amount], cx);
  if (!t) throw notFound('This client');
  await cx.query(
    `insert into credit_ledger (tuition_id, kind, amount_paise, balance_paise, request_id, ref, by_user) values ($1, $2, $3, $4, $5, $6, $7)`,
    [T, line.kind, amount, t.credit_paise, line.requestId ?? null, line.ref ?? null, line.byUser],
  );
  return t.credit_paise;
}

/** A tuition's balance, and what is free to spend: the balance less what jobs under way have set aside. */
export async function balanceOf(T: string, db: Db = pool): Promise<{ balance: number; free: number }> {
  const r = await q1<{ credit_paise: number; held: number }>(`select t.credit_paise, ${heldSql} as held from tuitions t where t.id = $1`, [T], db);
  if (!r) throw notFound('This tuition');
  return { balance: r.credit_paise, free: Math.max(0, r.credit_paise - r.held) };
}

// ---------------------------------------------------------------- the payment code

// The same letters as join codes: no 0, O, 1 or I, so a code survives being read out or typed from a message.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** "CR-7K3Q": a code as the tutor writes it in the payment note and the developer looks for it. */
export const showCreditCode = (code: string) => `CR-${code}`;

/** The tuition's payment code, made the first time it is asked for. One code for every payment, so a payment made without "I have paid" still says whose it is. */
export async function creditCode(T: string): Promise<string> {
  for (let tries = 0; tries < 20; tries++) {
    const t = await q1<{ credit_code: string | null }>('select credit_code from tuitions where id = $1', [T]);
    if (!t) throw notFound('This tuition');
    if (t.credit_code) return t.credit_code;
    const code = Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)]).join('');
    try {
      await pool.query('update tuitions set credit_code = $2 where id = $1 and credit_code is null', [T, code]);
    } catch (e) {
      // Another tuition has it: the next turn tries another.
      if ((e as { code?: string }).code !== '23505') throw e;
    }
  }
  throw new Error('No payment code could be made.');
}

// ---------------------------------------------------------------- requests

/**
 * A tutor's "I have paid": waits for the developer to find the payment. Refused while no UPI id is set (there is nowhere to pay),
 * for an amount outside MIN_REQUEST to MAX_REQUEST, and while MAX_WAITING requests of the tuition are waiting already.
 */
export async function askForCredit(T: string, userId: string, amount: number) {
  if (!Number.isInteger(amount) || amount % 100 !== 0 || amount < MIN_REQUEST || amount > MAX_REQUEST) {
    throw new HttpError(400, 'invalid', `Choose an amount in whole rupees from ${inr(MIN_REQUEST)} to ${inr(MAX_REQUEST)}.`);
  }
  const s = await creditSettings();
  if (!s.upiId) throw new HttpError(409, 'no_upi', 'Adding credit is not open yet. Please try again later.');
  const code = await creditCode(T);
  return tx(async (cx) => {
    // One tuition's requests are counted one at a time, so several sent at once cannot each pass the count.
    await cx.query('select 1 from tuitions where id = $1 for update', [T]);
    const waiting = (await q1<{ n: number }>(`select count(*)::int as n from credit_requests where tuition_id = $1 and status = 'waiting'`, [T], cx))!.n;
    if (waiting >= MAX_WAITING) {
      throw new HttpError(409, 'too_many_requests', `You have ${waiting} payments waiting to be checked. Please wait until they are.`);
    }
    return (await q1(
      `insert into credit_requests (tuition_id, amount_paise, code, upi_id, asked_by) values ($1, $2, $3, $4, $5)
       returning id, amount_paise, code, upi_id, status, created_at`,
      [T, amount, code, s.upiId, userId],
      cx,
    ))!;
  });
}

/** A request as the apps show it. */
export const requestOut = (r: { id: string; amount_paise: number; code: string; upi_id: string; status: string; created_at: Date; decided_at?: Date | null }) => ({
  id: r.id, amount_paise: r.amount_paise, code: showCreditCode(r.code), upi_id: r.upi_id, status: r.status, created_at: r.created_at, decided_at: r.decided_at ?? null,
});

// ---------------------------------------------------------------- history

/**
 * A tuition's credit lines, newest first, as the apps list them. The pages of one paper read on one day are one line ("Read 4
 * pages"), and so are the questions written into one paper on one day. `before` (a time) gives the lines before it.
 */
export async function historyOf(T: string, opts: { limit: number; before?: Date | null }, db: Db = pool) {
  const rows = await q<{
    kind: string; amount_paise: number; at: Date; pages: number; questions: number; label: string | null; paper_id: string | null; ref: string | null;
  }>(
    `select min(l.kind) as kind, sum(l.amount_paise)::int as amount_paise, max(l.created_at) as at,
            count(*) filter (where l.kind = 'page')::int as pages, coalesce(sum(l.questions), 0)::int as questions,
            coalesce(max(p.exam_name), max(l.label)) as label, max(l.paper_id::text) as paper_id, max(l.ref) as ref
       from credit_ledger l left join papers p on p.id = l.paper_id
      where l.tuition_id = $1
      group by case when l.kind in ('page', 'questions')
                    then l.kind || ':' || coalesce(l.paper_id::text, 'gone:' || coalesce(l.label, '')) || ':' || ((l.created_at at time zone 'Asia/Kolkata')::date)::text
                    else l.id::text end
     having $2::timestamptz is null or max(l.created_at) < $2::timestamptz
      order by max(l.created_at) desc
      limit $3`,
    [T, opts.before ?? null, opts.limit],
    db,
  );
  return rows.map((r) => ({
    kind: r.kind, amount_paise: r.amount_paise, at: r.at, label: r.label, paper_id: r.paper_id,
    ...(r.kind === 'page' ? { pages: r.pages } : {}),
    ...(r.kind === 'questions' ? { questions: r.questions } : {}),
    ...(r.kind === 'topup' || r.kind === 'by_hand' ? { ref: r.ref } : {}),
  }));
}
