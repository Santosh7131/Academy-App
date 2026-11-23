import { Hono } from 'hono';
import { tuitionOf, type AppEnv } from '../lib/auth.ts';
import { balanceOf, creditCode, creditSettings, showCreditCode } from '../lib/credit.ts';
import { q, q1, tx } from '../lib/db.ts';
import { bad, HttpError, int, notFound, str, uuid } from '../lib/http.ts';
import {
  askForPlan, effectivePlan, endPlan, grantPlan, PAID_PLANS, PLAN_MONTHS, planNow, planRequestOut, planSettings, refreshPlanCredit, roomUsed,
  type Client, type PaidPlan, type PlanName, type PlanSettings,
} from '../lib/plans.ts';
import { readBody } from './body.ts';

/** Which kind of app sent the request: the web version says so in x-os (app/lib/core/device.dart); anything else is the app. */
const clientOf = (os: string | undefined): Client => (os === 'web' ? 'web' : 'app');

const PLAN_ORDER: PlanName[] = ['free', 'basic', 'pro'];

/** The three plans as the apps show them: room for students and tutors, AI each month (Free: the start), and the price a month. */
const plansOut = (s: PlanSettings, startPaise: number) =>
  PLAN_ORDER.map((p) => ({
    name: p, students: s[p].students, tutors: s[p].tutors,
    ai_month_paise: s[p].aiPaise, ai_start_paise: p === 'free' ? startPaise : 0, price_month_paise: s[p].pricePaise,
  }));

const planOut = (p: Awaited<ReturnType<typeof planNow>>) => ({
  name: p.plan, bought: p.bought, from: p.from, until: p.until, last_day: p.lastDay, lapsed: p.lapsed, next_month_on: p.nextMonthOn,
});

// ---------------------------------------------------------------- the tutor's side
// Mounted behind requireUser('teacher') in index.ts. The plan is the tuition's: every tutor sees it, and its owner buys it.

export const planRoutes = new Hono<AppEnv>();

/**
 * The plan screen: the plan today and what it has room for, how much of it is used, the AI left, the three plans, and how to buy
 * one here (closed until the developer has set a UPI id and a price, and where plans are sold only in the app or only on the web).
 */
planRoutes.get('/plan', async (c) => {
  const t = tuitionOf(c);
  await refreshPlanCredit(t.id);
  const [now, s, credit, used, ai] = await Promise.all([planNow(t.id), planSettings(), creditSettings(), roomUsed(t.id), balanceOf(t.id)]);
  const forSale = PAID_PLANS.filter((p) => s[p].pricePaise !== null);
  const open = credit.upiId !== '' && forSale.length > 0;
  const client = clientOf(c.req.header('x-os'));
  const here = s.payWhere === 'both' || s.payWhere === client;
  const waiting = await q(
    `select id, plan, months, amount_paise, code, upi_id, status, created_at, decided_at from plan_requests
      where tuition_id = $1 and status = 'waiting' order by created_at desc`,
    [t.id],
  );
  return c.json({
    plan: planOut(now),
    used,
    plans: plansOut(s, credit.startPaise),
    ai: { balance_paise: ai.balance, free_paise: ai.free },
    owner: t.role === 'owner',
    pay: {
      open, here, where: s.payWhere, for_sale: forSale, months: PLAN_MONTHS,
      upi_id: open ? credit.upiId : null, upi_name: open ? credit.upiName : null, code: open ? showCreditCode(await creditCode(t.id)) : null,
    },
    waiting: waiting.map(planRequestOut),
  });
});

/** "I have paid" for a plan: the owner says which plan and for how many months; the developer finds the payment. */
planRoutes.post('/plan/requests', async (c) => {
  const t = tuitionOf(c);
  if (t.role !== 'owner') throw new HttpError(403, 'owner_only', "Only the tuition's owner can buy a plan.");
  const b = await readBody(c);
  const r = await askForPlan(t.id, c.get('user').id, b.plan, b.months, clientOf(c.req.header('x-os')));
  return c.json({ request: planRequestOut(r) }, 201);
});

// ---------------------------------------------------------------- the developer's side
// Mounted behind requireUser('developer') in index.ts.

export const planAdminRoutes = new Hono<AppEnv>();

// Midnight at the start of this month, India time.
const IST_MONTH = `(date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')`;

const settingsOut = (s: PlanSettings) => ({
  free: { students: s.free.students, tutors: s.free.tutors },
  basic: { students: s.basic.students, tutors: s.basic.tutors, ai_month_paise: s.basic.aiPaise, price_month_paise: s.basic.pricePaise },
  pro: { students: s.pro.students, tutors: s.pro.tutors, ai_month_paise: s.pro.aiPaise, price_month_paise: s.pro.pricePaise },
  pay_where: s.payWhere,
});

/** The plan requests with their client and the plan it is on today, as the admin app lists them. */
const REQUESTS = `select r.id, r.plan, r.months, r.amount_paise, r.code, r.upi_id, r.status, r.created_at, r.decided_at, t.id as client_id, t.name as client,
         ${effectivePlan('t')} as client_plan, (case when ${effectivePlan('t')} <> 'free' then (t.plan_until - 1)::text end) as client_last_day,
         (select u.display_name from memberships m join users u on u.id = m.user_id where m.tuition_id = t.id and m.role = 'owner' limit 1) as owner
    from plan_requests r join tuitions t on t.id = r.tuition_id`;
const requestRow = (r: any) => ({
  ...planRequestOut(r), client_id: r.client_id, client: r.client, owner: r.owner, client_plan: r.client_plan, client_last_day: r.client_last_day,
});

/** The plans screen: sizes, prices and where plans are sold; the payments waiting to be checked and the last ones decided; this month. */
planAdminRoutes.get('/plans', async (c) => {
  const waiting = await q(`${REQUESTS} where r.status = 'waiting' order by r.created_at`);
  const done = await q(`${REQUESTS} where r.status <> 'waiting' order by r.decided_at desc limit 20`);
  const month = await q1<{ paid: number; given: number }>(
    `select coalesce(sum(amount_paise), 0)::int as paid, count(*) filter (where amount_paise = 0)::int as given
       from plan_periods where created_at >= ${IST_MONTH}`,
  );
  const on = await q<{ plan: PlanName; n: number }>(`select ${effectivePlan('t')} as plan, count(*)::int as n from tuitions t group by 1`);
  return c.json({
    settings: settingsOut(await planSettings()),
    waiting: waiting.map(requestRow),
    done: done.map(requestRow),
    month: { paid_paise: month?.paid ?? 0, given: month?.given ?? 0 },
    clients: Object.fromEntries(PLAN_ORDER.map((p) => [p, on.find((x) => x.plan === p)?.n ?? 0])),
  });
});

/**
 * Changes the plans: the students and tutors each has room for, Basic's and Pro's AI each month and price a month (null takes a plan
 * off sale), and where plans are sold. Only the fields sent change; the body uses the names settingsOut gives, flattened
 * (basic_price_month_paise and so on).
 */
planAdminRoutes.put('/plans/settings', async (c) => {
  const b = await readBody(c);
  const has = (k: string) => Object.hasOwn(b, k);
  const set: [string, unknown][] = [];
  for (const p of PLAN_ORDER) {
    if (has(`${p}_students`)) set.push([`plan_${p}_students`, int(b, `${p}_students`, { min: 1, max: 100000 })]);
    if (has(`${p}_tutors`)) set.push([`plan_${p}_tutors`, int(b, `${p}_tutors`, { min: 1, max: 1000 })]);
  }
  for (const p of PAID_PLANS) {
    if (has(`${p}_ai_month_paise`)) set.push([`plan_${p}_ai_paise`, int(b, `${p}_ai_month_paise`, { min: 0, max: 10000000 })]);
    if (has(`${p}_price_month_paise`)) {
      const v = b[`${p}_price_month_paise`];
      set.push([`plan_${p}_price_paise`, v === null ? null : int(b, `${p}_price_month_paise`, { min: 100, max: 100000000 })]);
    }
  }
  if (has('pay_where')) {
    if (b.pay_where !== 'both' && b.pay_where !== 'web' && b.pay_where !== 'app') throw bad('Choose where plans are sold: both, web or app.');
    set.push(['plan_pay_where', b.pay_where]);
  }
  await tx(async (cx) => {
    for (const [key, value] of set) {
      await cx.query(`insert into app_settings (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value`, [key, JSON.stringify(value)]);
    }
  });
  return c.json({ settings: settingsOut(await planSettings()) });
});

const SIZE: Record<PlanName, number> = { free: 0, basic: 1, pro: 2 };

/**
 * Starts or lengthens a plan for a payment received, refusing a smaller plan while a bigger one runs (it would end the bigger one
 * today) unless `replace` says to: then the smaller plan starts today.
 */
async function give(
  cx: Parameters<typeof grantPlan>[0],
  T: string,
  g: Parameters<typeof grantPlan>[2],
  replace: boolean,
) {
  const now = await planNow(T, cx);
  if (!replace && SIZE[now.plan] > SIZE[g.plan]) {
    throw new HttpError(
      409,
      'smaller_plan',
      `This client is on ${now.plan === 'pro' ? 'Pro' : 'Basic'} until ${now.lastDay}. Giving ${g.plan === 'pro' ? 'Pro' : 'Basic'} now would end it today.`,
      { client_plan: now.plan, client_last_day: now.lastDay },
    );
  }
  return grantPlan(cx, T, g);
}

/** Marks a waiting plan request received (the plan starts, or runs on, at once) or declined. A request is decided once. */
async function decide(id: string, to: 'received' | 'declined', by: string, ref: string | null, replace: boolean) {
  return tx(async (cx) => {
    const r = await q1(
      `update plan_requests set status = $2, decided_at = now(), decided_by = $3 where id = $1 and status = 'waiting'
       returning id, tuition_id, plan, months, amount_paise, code, upi_id, status, created_at, decided_at`,
      [id, to, by],
      cx,
    );
    if (!r) {
      const was = await q1<{ status: string }>('select status from plan_requests where id = $1', [id], cx);
      if (!was) throw notFound('This request');
      throw new HttpError(409, 'already_decided', `This request was ${was.status} already.`);
    }
    const plan = to === 'received'
      ? await give(cx, r.tuition_id, { plan: r.plan, months: r.months, amountPaise: r.amount_paise, requestId: r.id, ref: ref ?? showCreditCode(r.code), byUser: by }, replace)
      : null;
    return { request: planRequestOut(r), plan };
  });
}

planAdminRoutes.post('/plans/requests/:id/receive', async (c) => {
  const id = uuid(c.req.param('id'), 'request id');
  const b = await readBody(c);
  // The UPI transaction id, when the developer gives it; the plan's record keeps the code otherwise.
  const ref = str(b, 'ref', { max: 80, optional: true }) ?? null;
  return c.json(await decide(id, 'received', c.get('user').id, ref, b.replace === true));
});

planAdminRoutes.post('/plans/requests/:id/decline', async (c) => {
  const id = uuid(c.req.param('id'), 'request id');
  return c.json(await decide(id, 'declined', c.get('user').id, null, false));
});

/** A client's plan, its payments waiting, and every stretch it was given, newest first. */
planAdminRoutes.get('/clients/:id/plan', async (c) => {
  const id = uuid(c.req.param('id'), 'client id');
  const now = await planNow(id);
  const periods = await q(
    `select id, plan, months, amount_paise, period_from::text as "from", (period_until - 1)::text as last_day, ref, created_at
       from plan_periods where tuition_id = $1 order by created_at desc limit 20`,
    [id],
  );
  const waiting = await q(
    `select id, plan, months, amount_paise, code, upi_id, status, created_at, decided_at from plan_requests
      where tuition_id = $1 and status = 'waiting' order by created_at`,
    [id],
  );
  return c.json({ plan: planOut(now), used: await roomUsed(id), periods, waiting: waiting.map(planRequestOut) });
});

/** Gives a client a plan by hand: a payment that came without "I have paid", or months the developer gives (amount 0). */
planAdminRoutes.post('/clients/:id/plan', async (c) => {
  const id = uuid(c.req.param('id'), 'client id');
  const b = await readBody(c);
  if (b.plan !== 'basic' && b.plan !== 'pro') throw bad('Choose Basic or Pro.');
  const months = int(b, 'months', { min: 1, max: 24 })!;
  const amount = int(b, 'amount_paise', { min: 0, max: 100000000 })!;
  const ref = str(b, 'ref', { max: 80, optional: true }) ?? null;
  const plan = await tx((cx) => give(cx, id, { plan: b.plan as PaidPlan, months, amountPaise: amount, ref, byUser: c.get('user').id }, b.replace === true));
  return c.json({ plan }, 201);
});

/** Ends a client's plan today: it is on Free again. Nothing of it is deleted, and its AI credit stays. */
planAdminRoutes.delete('/clients/:id/plan', async (c) => {
  const id = uuid(c.req.param('id'), 'client id');
  await tx((cx) => endPlan(cx, id));
  return c.json({ plan: planOut(await planNow(id)) });
});
