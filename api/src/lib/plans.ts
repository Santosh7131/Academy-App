import { creditCode, creditSettings, inr, showCreditCode } from './credit.ts';
import { pool, q, q1, tx, type Db } from './db.ts';
import { HttpError, notFound } from './http.ts';

/**
 * Plans (api/migrations/040_plans.sql): Free, Basic and Pro, each with room for so many students and tutors, and Basic and Pro with
 * AI each month. A plan bought counts until its end date and then the tuition is on Free again; nothing is deleted, and nothing runs
 * on a timer: every check works out the plan for today. Sizes and prices are app_settings, which the admin app changes.
 */

export type PlanName = 'free' | 'basic' | 'pro';
export type PaidPlan = 'basic' | 'pro';
export const PAID_PLANS: PaidPlan[] = ['basic', 'pro'];
export const planTitle = (p: PlanName) => ({ free: 'Free', basic: 'Basic', pro: 'Pro' })[p];

/** Where a plan can be bought: in the app and the web version, or only one of them. */
export type PayWhere = 'both' | 'web' | 'app';

export type PlanSize = { students: number; tutors: number; aiPaise: number; pricePaise: number | null };
export type PlanSettings = Record<PlanName, PlanSize> & { payWhere: PayWhere };

/** Santosh's sizes (migration 040 writes the same). No price: a plan is not on sale until the developer sets one. */
const DEFAULTS: Record<PlanName, PlanSize> = {
  free: { students: 20, tutors: 1, aiPaise: 0, pricePaise: null },
  basic: { students: 100, tutors: 3, aiPaise: 30000, pricePaise: null },
  pro: { students: 300, tutors: 10, aiPaise: 90000, pricePaise: null },
};

/** How many months a plan can be bought for at once. */
export const PLAN_MONTHS = [1, 3, 6, 12];
/** How many of a tuition's plan payments may wait to be checked at once. */
const MAX_WAITING = 3;

/** The sizes, prices and where plans are sold, from app_settings, with the default for any key that is missing or wrong. */
export async function planSettings(db: Db = pool): Promise<PlanSettings> {
  const rows = await q<{ key: string; value: unknown }>(`select key, value from app_settings where key like 'plan\\_%'`, [], db);
  const v = new Map(rows.map((r) => [r.key, r.value]));
  const whole = (k: string, d: number) => {
    const x = v.get(k);
    return typeof x === 'number' && Number.isInteger(x) && x >= 0 ? x : d;
  };
  const size = (p: PlanName): PlanSize => {
    const price = v.get(`plan_${p}_price_paise`);
    return {
      students: whole(`plan_${p}_students`, DEFAULTS[p].students),
      tutors: Math.max(1, whole(`plan_${p}_tutors`, DEFAULTS[p].tutors)),
      aiPaise: p === 'free' ? 0 : whole(`plan_${p}_ai_paise`, DEFAULTS[p].aiPaise),
      pricePaise: p !== 'free' && typeof price === 'number' && Number.isInteger(price) && price > 0 ? price : null,
    };
  };
  const where = v.get('plan_pay_where');
  return { free: size('free'), basic: size('basic'), pro: size('pro'), payWhere: where === 'web' || where === 'app' ? where : 'both' };
}

// ---------------------------------------------------------------- the plan for today

/** Today in India, the day plans start and end by. */
export const TODAY = `((now() at time zone 'Asia/Kolkata')::date)`;

/** The plan a tuition is on today (SQL over its row `t`): the one bought, until its end date; Free after that. */
export const effectivePlan = (t = 't') => `(case when ${t}.plan <> 'free' and ${t}.plan_until > ${TODAY} then ${t}.plan else 'free' end)`;

/**
 * Whole months from one day to another (SQL over two dates): the most months that can be added to `from` without passing `to`.
 * Adding months keeps the day of the month where it can (31 January and a month is 28 February), and this counts the same way.
 */
const monthsBetween = (from: string, to: string) => {
  const m = `((extract(year from ${to}) - extract(year from ${from})) * 12 + extract(month from ${to}) - extract(month from ${from}))::int`;
  return `(case when (${from} + make_interval(months => ${m}))::date > ${to} then ${m} - 1 else ${m} end)`;
};

/**
 * The first day of the plan month today is in, and of the one after it (SQL over `t`): months are counted from the day the plan's
 * stretch began, so a plan bought on the 24th gives its AI again on each 24th. Null on Free.
 */
const monthStart = (t = 't') => `(${t}.plan_from + make_interval(months => ${monthsBetween(`${t}.plan_from`, TODAY)}))::date`;
const nextMonthStart = (t = 't') => `(${t}.plan_from + make_interval(months => ${monthsBetween(`${t}.plan_from`, TODAY)} + 1))::date`;

export type PlanNow = {
  plan: PlanName; bought: PlanName; from: string | null;
  /** The first day the plan bought no longer covers, and the last day it does. */
  until: string | null; lastDay: string | null;
  lapsed: boolean;
  /** When the plan's next month starts and its AI is given again; null when the plan ends first, and on Free. */
  nextMonthOn: string | null;
};

/** A tuition's plan today, with the dates of the plan bought. */
export async function planNow(T: string, db: Db = pool): Promise<PlanNow> {
  const t = await q1<{ plan: PlanName; bought: PlanName; from: string | null; until: string | null; last: string | null; next: string | null }>(
    `select ${effectivePlan('t')} as plan, t.plan as bought, t.plan_from::text as "from", t.plan_until::text as until,
            (t.plan_until - 1)::text as last,
            (case when ${nextMonthStart('t')} < t.plan_until then ${nextMonthStart('t')}::text end) as next
       from tuitions t where t.id = $1`,
    [T],
    db,
  );
  if (!t) throw notFound('This tuition');
  return {
    plan: t.plan, bought: t.bought, from: t.from, until: t.until, lastDay: t.last, lapsed: t.bought !== 'free' && t.plan === 'free',
    nextMonthOn: t.plan === 'free' ? null : t.next,
  };
}

// ---------------------------------------------------------------- room for students and tutors

/** The answer when a plan is full: what it has room for, and (but on the biggest plan) that a bigger plan has more. */
function full(plan: PlanName, kind: 'student' | 'tutor', limit: number) {
  const what = `${limit} ${kind}${limit === 1 ? '' : 's'}`;
  return new HttpError(
    402,
    kind === 'student' ? 'plan_students_full' : 'plan_tutors_full',
    plan === 'pro' ? `Your Pro plan has room for ${what}, and it is full.` : `Your ${planTitle(plan)} plan has room for ${what}. Move to a bigger plan to add more.`,
    { plan, limit },
  );
}

/**
 * Refuses one more active student (or tutor: the owner and tutors) than the tuition's plan has room for. Called in the transaction
 * that adds them; it locks the tuition's row first, so two added at once are counted one after the other. Someone already active
 * here (a student let into another group, a place turned on twice) takes no more room, and students turned off take none.
 */
export async function roomFor(cx: Db, T: string, kind: 'student' | 'tutor', userId?: string | null) {
  const roles = kind === 'student' ? `('student')` : `('owner', 'tutor')`;
  const t = await q1<{ plan: PlanName }>(`select ${effectivePlan('t')} as plan from tuitions t where t.id = $1 for no key update`, [T], cx);
  if (!t) throw notFound('This tuition');
  if (userId) {
    const already = await q1(`select 1 from memberships where tuition_id = $1 and user_id = $2 and role in ${roles} and status = 'active'`, [T, userId], cx);
    if (already) return;
  }
  const limit = (await planSettings(cx))[t.plan][kind === 'student' ? 'students' : 'tutors'];
  const n = (await q1<{ n: number }>(
    `select count(*)::int as n from memberships where tuition_id = $1 and role in ${roles} and status = 'active'`,
    [T],
    cx,
  ))!.n;
  if (n >= limit) throw full(t.plan, kind, limit);
}

/** How many active students and tutors a tuition has, as its plan counts them. */
export async function roomUsed(T: string, db: Db = pool) {
  return (await q1<{ students: number; tutors: number }>(
    `select count(*) filter (where role = 'student')::int as students, count(*) filter (where role in ('owner', 'tutor'))::int as tutors
       from memberships where tuition_id = $1 and status = 'active'`,
    [T],
    db,
  ))!;
}

// ---------------------------------------------------------------- the plan's AI each month

/**
 * Gives the plan's AI for the plan month today is in, once: tops the credit up to the plan's AI and never lowers it (credit bought
 * before, beyond it, stays). In the caller's transaction; it locks the tuition's row, so two jobs starting together give it once.
 */
export async function refillPlanCredit(cx: Db, T: string): Promise<void> {
  const t = await q1<{ plan: PlanName; month: string | null; refilled: string | null; credit_paise: number }>(
    `select ${effectivePlan('t')} as plan, ${monthStart('t')}::text as month, t.plan_refilled::text as refilled, t.credit_paise
       from tuitions t where t.id = $1 for no key update`,
    [T],
    cx,
  );
  if (!t || t.plan === 'free' || !t.month || (t.refilled !== null && t.refilled >= t.month)) return;
  const add = (await planSettings(cx))[t.plan].aiPaise - t.credit_paise;
  if (add > 0) {
    const r = await q1<{ credit_paise: number }>(
      'update tuitions set credit_paise = credit_paise + $2, plan_refilled = $3::date where id = $1 returning credit_paise',
      [T, add, t.month],
      cx,
    );
    await cx.query(`insert into credit_ledger (tuition_id, kind, amount_paise, balance_paise, label) values ($1, 'plan', $2, $3, $4)`, [
      T, add, r!.credit_paise, `${planTitle(t.plan)} plan`,
    ]);
  } else {
    await cx.query('update tuitions set plan_refilled = $2::date where id = $1', [T, t.month]);
  }
}

/**
 * The same in a transaction of its own, for screens that show the credit, so the balance shown is this month's. A quick look first:
 * the row is locked only on the one day a month the AI is due.
 */
export async function refreshPlanCredit(T: string) {
  const due = await q1(
    `select 1 from tuitions t where t.id = $1 and ${effectivePlan('t')} <> 'free' and (t.plan_refilled is null or t.plan_refilled < ${monthStart('t')})`,
    [T],
  );
  if (due) await tx((cx) => refillPlanCredit(cx, T));
}

/** "24 Dec 2026": a day as a message says it. */
const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** The paid plans that can be bought now: those with a price, while the developer has a UPI id to pay to. */
export async function plansOnSale(db: Db = pool): Promise<PaidPlan[]> {
  const [s, pay] = await Promise.all([planSettings(db), creditSettings(db)]);
  return pay.upiId ? PAID_PLANS.filter((p) => s[p].pricePaise !== null) : [];
}

/**
 * The answer when the AI left does not cover the work (402 no_credit, as before plans): what is left and what the work needs, and
 * what the tutor can do: on Free and Basic, move to a bigger plan that is on sale; on Basic and Pro, wait for the plan's next month.
 * There are no top-ups (Santosh, 24 Nov 2026: "Upgrade only"). Before any plan is on sale, Free says so rather than send the tutor to
 * plans they cannot buy.
 */
export async function noCreditFor(T: string, freePaise: number, neededPaise: number, db: Db = pool) {
  const [p, sale] = await Promise.all([planNow(T, db), plansOnSale(db)]);
  const free = Math.max(freePaise, 0);
  const need = `This needs ${inr(neededPaise)} of AI and you have ${inr(free)} left`;
  const when = p.nextMonthOn ? ` Your plan's AI comes again on ${day(p.nextMonthOn)}.` : '';
  const message = p.plan === 'free'
    ? sale.length
      ? `${need}. Move to ${sale.map(planTitle).join(' or ')} for AI every month.`
      : `${need}. Plans with AI every month go on sale soon.`
    : p.plan === 'basic'
      ? `${need} this month.${when}${sale.includes('pro') ? ' Or move to Pro for more.' : ''}`
      : `${need} this month.${when}`;
  return new HttpError(402, 'no_credit', message, {
    credit_paise: free, needed_paise: neededPaise, plan: p.plan, next_month_on: p.nextMonthOn, plans_on_sale: sale,
  });
}

// ---------------------------------------------------------------- buying a plan

export type Client = 'web' | 'app';

/**
 * A tutor's "I have paid" for a plan: waits for the developer to find the payment. Refused for a plan with no price (not on sale), a
 * number of months not offered, while the developer has no UPI id, where plans are not sold (the app or the web version), and while
 * MAX_WAITING of the tuition's plan payments are waiting already.
 */
export async function askForPlan(T: string, userId: string, plan: unknown, months: unknown, client: Client) {
  if (plan !== 'basic' && plan !== 'pro') throw new HttpError(400, 'invalid', 'Choose Basic or Pro.');
  if (typeof months !== 'number' || !PLAN_MONTHS.includes(months)) {
    throw new HttpError(400, 'invalid', `Choose ${PLAN_MONTHS.slice(0, -1).join(', ')} or ${PLAN_MONTHS.at(-1)} months.`);
  }
  const s = await planSettings();
  const price = s[plan].pricePaise;
  if (price === null) throw new HttpError(409, 'not_on_sale', 'Plans are not on sale yet. Please try again later.');
  if (s.payWhere === 'web' && client !== 'web') throw new HttpError(409, 'pay_on_web', 'Plans are bought in the web version of the app, in a browser.');
  if (s.payWhere === 'app' && client !== 'app') throw new HttpError(409, 'pay_in_app', 'Plans are bought in the app on a phone.');
  const pay = await creditSettings();
  if (!pay.upiId) throw new HttpError(409, 'no_upi', 'Plans are not on sale yet. Please try again later.');
  // While Pro runs, Basic would end it early: it waits until Pro ends. A bigger plan, or more of the same, can be bought any time.
  const now = await planNow(T);
  if (now.plan === 'pro' && plan === 'basic') {
    throw new HttpError(409, 'smaller_plan', `You are on Pro until ${day(now.lastDay!)}. Basic can be bought after that.`);
  }
  const code = await creditCode(T);
  return tx(async (cx) => {
    // One tuition's requests are counted one at a time, so several sent at once cannot each pass the count.
    await cx.query('select 1 from tuitions where id = $1 for no key update', [T]);
    const waiting = (await q1<{ n: number }>(`select count(*)::int as n from plan_requests where tuition_id = $1 and status = 'waiting'`, [T], cx))!.n;
    if (waiting >= MAX_WAITING) {
      throw new HttpError(409, 'too_many_requests', `You have ${waiting} payments waiting to be checked. Please wait until they are.`);
    }
    return (await q1(
      `insert into plan_requests (tuition_id, plan, months, amount_paise, code, upi_id, asked_by) values ($1, $2, $3, $4, $5, $6, $7)
       returning id, plan, months, amount_paise, code, upi_id, status, created_at, decided_at`,
      [T, plan, months, price * months, code, pay.upiId, userId],
      cx,
    ))!;
  });
}

/** A plan payment as the apps show it. */
export const planRequestOut = (r: {
  id: string; plan: string; months: number; amount_paise: number; code: string; upi_id: string; status: string; created_at: Date; decided_at?: Date | null;
}) => ({
  id: r.id, plan: r.plan, months: r.months, amount_paise: r.amount_paise, code: showCreditCode(r.code), upi_id: r.upi_id, status: r.status,
  created_at: r.created_at, decided_at: r.decided_at ?? null,
});

/**
 * Starts or lengthens a plan, in the caller's transaction: a payment received or a stretch the developer gives. The same plan, still
 * running, goes on for the months after the ones it has; any other (from Free, after it ended, or a change of plan) starts today, and
 * its first month's AI comes with the next AI work. A change of plan does not carry the days left of the old one.
 */
export async function grantPlan(
  cx: Db,
  T: string,
  g: { plan: PaidPlan; months: number; amountPaise: number; requestId?: string | null; ref?: string | null; byUser: string },
) {
  const t = await q1<{ current: PlanName; until: string | null; today: string }>(
    `select ${effectivePlan('t')} as current, t.plan_until::text as until, ${TODAY}::text as today from tuitions t where t.id = $1 for no key update`,
    [T],
    cx,
  );
  if (!t) throw notFound('This client');
  const same = t.current === g.plan;
  // Lengthened, the end is counted from the plan's first day (31 January and two months is 31 March, where 28 February and a month
  // would be 28 March), so its months keep starting on the same day.
  const r = (await q1<{ from: string; until: string }>(
    same
      ? `update tuitions set plan_until = (plan_from + make_interval(months => ${monthsBetween('plan_from', 'plan_until')} + $2))::date
          where id = $1 returning plan_from::text as "from", plan_until::text as until`
      : `update tuitions set plan = $3, plan_from = ${TODAY}, plan_until = (${TODAY} + make_interval(months => $2))::date, plan_refilled = null
          where id = $1 returning plan_from::text as "from", plan_until::text as until`,
    same ? [T, g.months] : [T, g.months, g.plan],
    cx,
  ))!;
  await cx.query(
    `insert into plan_periods (tuition_id, plan, months, amount_paise, period_from, period_until, request_id, ref, by_user)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [T, g.plan, g.months, g.amountPaise, same ? t.until : r.from, r.until, g.requestId ?? null, g.ref ?? null, g.byUser],
  );
  return { plan: g.plan, from: r.from, until: r.until };
}

/** Puts a tuition back on Free today (the developer's choice, such as a payment that bounced). Its credit stays. */
export async function endPlan(cx: Db, T: string) {
  const r = await cx.query(`update tuitions set plan = 'free', plan_from = null, plan_until = null, plan_refilled = null where id = $1`, [T]);
  if (!r.rowCount) throw notFound('This client');
}
