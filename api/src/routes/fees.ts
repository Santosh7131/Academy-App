import { waitUntil } from '@neon/functions';
import { Hono, type Context } from 'hono';
import { istToday } from '../lib/attendance.ts';
import { tuitionOf, type AppEnv, type Tuition } from '../lib/auth.ts';
import { pool, tq, tq1, tx, type Db } from '../lib/db.ts';
import {
  dueOn, feeStatus, MAX_FEE_PAISE, MAX_PAYMENT_PAISE, monthName, monthOf, monthsOf, rateFor, readDueDay, readMethod, readMonth, readPaidOn, readPaise,
  readReference, readStudentIds, readUpiId, readUpiName, rupees, thisMonth, type MonthRow, type Pay, type Rate,
} from '../lib/fees.ts';
import { bad, HttpError, notFound, uuid } from '../lib/http.ts';
import { pushConfigured, pushToUsers } from '../lib/push.ts';
import { classStudents, whichClass } from './attendance.ts';
import { readBody } from './body.ts';

// Fees (lib/fees.ts; migration 039). Only the tuition's owner sees them, sets them and records payments: a helper tutor who
// could change the UPI id could send every student's fees somewhere else. Mounted behind requireUser('teacher') in index.ts.
// Students see their own fees and say when they have paid by UPI with studentFeeRoutes, behind requireUser('student').
export const feeRoutes = new Hono<AppEnv>();
export const studentFeeRoutes = new Hono<AppEnv>();

/** The tuition, for its owner only. */
function ownerOf(c: Context<AppEnv>): Tuition {
  const t = tuitionOf(c);
  if (t.role !== 'owner') throw new HttpError(403, 'owner_only', 'Only the owner of the tuition sees fees.');
  return t;
}

const first = (month: string) => `${month}-01`;

/** A payment as the app shows it, from `fee_payments p`. */
const PAYMENT = `p.id, p.student_id, p.student_name, to_char(p.month, 'YYYY-MM') as month, p.amount_paise, p.method,
       to_char(p.paid_on, 'YYYY-MM-DD') as paid_on, p.reference, p.status, p.receipt_no, p.created_at, p.confirmed_at,
       (select u.display_name from users u where u.id = p.confirmed_by) as confirmed_by`;

/** Which month a student joined the tuition in, in India, as YYYY-MM. */
const JOINED = `to_char(date_trunc('month', m.joined_at at time zone 'Asia/Kolkata'), 'YYYY-MM')`;

type Upi = { id: string; name: string | null } | null;

async function upiOf(T: string, db: Db = pool): Promise<Upi> {
  const r = await tq1<{ upi_id: string | null; upi_name: string | null }>(T, 'select upi_id, upi_name from tuitions where id = @T', [], db);
  return r?.upi_id ? { id: r.upi_id, name: r.upi_name } : null;
}

/** The next receipt number: never given twice, even after a payment is taken away. Holds the tuition's row to the end of `cx`. */
async function nextReceipt(T: string, cx: Db): Promise<number> {
  return (await tq1<{ n: number }>(T, 'update tuitions set fee_receipt_no = fee_receipt_no + 1 where id = @T returning fee_receipt_no as n', [], cx))!.n;
}

/** Tells someone about a payment, after the answer has gone. */
function tell(ids: (string | null)[], title: string, body: string) {
  const to = ids.filter((x): x is string => !!x);
  if (to.length && pushConfigured()) waitUntil(pushToUsers(to, { title, body }).catch(() => 0));
}

async function ownersOf(T: string): Promise<string[]> {
  return (await tq<{ id: string }>(T, `select user_id as id from memberships where tuition_id = @T and role = 'owner' and status = 'active'`)).map((r) => r.id);
}

/** A student's fees set and payments made here, for monthsOf. */
async function historyOf(T: string, studentId: string, db: Db = pool) {
  const rates = await tq<Rate>(
    T,
    `select to_char(from_month, 'YYYY-MM') as from_month, fee_paise, due_day from fee_rates where tuition_id = @T and student_id = $1 order by from_month`,
    [studentId],
    db,
  );
  const payments = await tq<Pay & Record<string, unknown>>(
    T,
    `select ${PAYMENT} from fee_payments p where p.tuition_id = @T and p.student_id = $1 order by p.month desc, p.created_at desc limit 300`,
    [studentId],
    db,
  );
  return { rates, payments };
}

// ---------------------------------------------------------------- one month, for the tutor

type Row = {
  id: string; display_name: string; username: string; class_level: number; active: boolean; joined: string;
  fee: number | null; due_day: number | null; has_rate: boolean; paid: number; claimed: number;
};

/**
 * A month's fees: every student owed a fee that month or who paid something for it, how each stands, and the totals; the
 * payments for it by people no longer here; the students who have no fee yet; and every payment waiting to be confirmed,
 * whatever its month.
 */
export async function monthView(T: string, month: string, now = new Date()) {
  const today = istToday(now);
  const rows = await tq<Row>(
    T,
    `with people as (
       select u.id, u.display_name, u.username, m.class_level, (m.status = 'active') as active, ${JOINED} as joined
         from memberships m join users u on u.id = m.user_id
        where m.tuition_id = @T and m.role = 'student' and m.status in ('active', 'off')),
     rate as (
       select distinct on (r.student_id) r.student_id, r.fee_paise, r.due_day
         from fee_rates r where r.tuition_id = @T and r.from_month <= $1::date
        order by r.student_id, r.from_month desc),
     pay as (
       select p.student_id, coalesce(sum(p.amount_paise) filter (where p.status = 'confirmed'), 0)::int as paid,
              coalesce(sum(p.amount_paise) filter (where p.status = 'claimed'), 0)::int as claimed
         from fee_payments p where p.tuition_id = @T and p.month = $1::date and p.student_id is not null
        group by p.student_id)
     select pe.id, pe.display_name, pe.username, pe.class_level, pe.active, pe.joined,
            case when to_char($1::date, 'YYYY-MM') >= pe.joined and r.fee_paise > 0 then r.fee_paise end as fee, r.due_day,
            exists (select 1 from fee_rates x where x.tuition_id = @T and x.student_id = pe.id) as has_rate,
            coalesce(pa.paid, 0) as paid, coalesce(pa.claimed, 0) as claimed
       from people pe left join rate r on r.student_id = pe.id left join pay pa on pa.student_id = pe.id
      order by pe.display_name, pe.id`,
    [first(month)],
  );
  const students = [];
  const noFee = [];
  for (const r of rows) {
    if (r.fee || r.paid || r.claimed) {
      const due = r.fee && r.due_day ? dueOn(month, r.due_day) : null;
      const s = feeStatus({ fee: r.fee, paid: r.paid, claimed: r.claimed, dueOn: due, today });
      students.push({
        id: r.id, display_name: r.display_name, username: r.username, class_level: r.class_level, active: r.active,
        fee: r.fee, due_day: r.fee ? r.due_day : null, due_on: due, paid: r.paid, claimed: r.claimed, ...s,
      });
    } else if (!r.has_rate && r.active) {
      noFee.push({ id: r.id, display_name: r.display_name, username: r.username, class_level: r.class_level });
    }
  }
  // Payments for this month by students who have left the tuition or deleted their account: still the tutor's records.
  const others = await tq(
    T,
    `select ${PAYMENT} from fee_payments p
      where p.tuition_id = @T and p.month = $1::date
        and (p.student_id is null or not exists (select 1 from memberships m where m.tuition_id = @T and m.user_id = p.student_id
                                                  and m.role = 'student' and m.status in ('active', 'off')))
      order by p.created_at`,
    [first(month)],
  );
  const claims = await tq(T, `select ${PAYMENT} from fee_payments p where p.tuition_id = @T and p.status = 'claimed' order by p.created_at`);
  const sums = (await tq1<{ collected: number; waiting: number }>(
    T,
    `select coalesce(sum(amount_paise) filter (where status = 'confirmed'), 0)::int as collected,
            coalesce(sum(amount_paise) filter (where status = 'claimed'), 0)::int as waiting
       from fee_payments where tuition_id = @T and month = $1::date`,
    [first(month)],
  ))!;
  const owed = students.filter((s) => s.fee);
  const left = owed.reduce((n, s) => n + s.left, 0);
  return {
    month, this_month: thisMonth(now), today, upi: await upiOf(T),
    totals: {
      // Every fee, plus any money beyond them (from a student who has left, one with no fee, or more than a fee): so what came in
      // and what is still to come always make the whole, and "paid so far" cannot look complete while someone still owes.
      expected: sums.collected + left,
      collected: sums.collected,
      waiting: sums.waiting,
      left,
      students: owed.length,
      paid: owed.filter((s) => s.status === 'paid').length,
      unpaid: owed.filter((s) => s.status === 'unpaid').length,
      late: owed.filter((s) => s.status !== 'paid' && s.late).length,
    },
    students, others, no_fee: noFee, claims,
  };
}

/** Fees on the owner's Home: this month's totals and the payments waiting to be confirmed. */
export async function feesForHome(T: string) {
  const v = await monthView(T, thisMonth());
  return { month: v.month, ...v.totals, claims: v.claims.length, no_fee: v.no_fee.length, upi: v.upi !== null };
}

/** The month a student joined, YYYY-MM; null when they are not a student here. */
async function joinedMonth(T: string, studentId: string, db: Db = pool): Promise<string | null> {
  const m = await tq1<{ joined: string }>(
    T,
    `select ${JOINED} as joined from memberships m where m.tuition_id = @T and m.user_id = $1 and m.role = 'student'`,
    [studentId],
    db,
  );
  return m?.joined ?? null;
}

/** One student's fee on their page, for the owner: the fee now, this month, and what is still owed. A null fee: none now. */
export async function feeOfStudent(T: string, studentId: string, now = new Date()) {
  const joined = await joinedMonth(T, studentId);
  if (!joined) return null;
  const { rates, payments } = await historyOf(T, studentId);
  return summary(rates, monthsOf(rates, payments, joined, istToday(now)), thisMonth(now));
}

function summary(rates: Rate[], months: MonthRow[], current: string) {
  const r = rateFor(rates, current);
  const owing = months.filter((m) => m.status === 'unpaid' || m.status === 'claimed');
  return {
    fee: r && r.fee_paise > 0 ? r.fee_paise : null,
    due_day: r && r.fee_paise > 0 ? r.due_day : null,
    set: rates.length > 0,
    month: months.find((m) => m.month === current) ?? null,
    // The oldest month still owed first.
    owing: owing.reverse().map((m) => ({ month: m.month, left: m.left, status: m.status, late: m.late, due_on: m.due_on })),
    left: owing.filter((m) => m.status === 'unpaid').reduce((n, m) => n + m.left, 0),
  };
}

// ---------------------------------------------------------------- the owner's routes

feeRoutes.get('/fees', async (c) => {
  const t = ownerOf(c);
  return c.json(await monthView(t.id, readMonth(c.req.query('month'))));
});

/** One student's fees: the fee set from each month, every month owed or paid for, and every payment with its receipt. */
feeRoutes.get('/fees/students/:id', async (c) => {
  const t = ownerOf(c);
  const id = uuid(c.req.param('id'), 'student id');
  const s = await tq1<{ id: string; display_name: string; username: string; class_level: number; active: boolean; joined: string }>(
    t.id,
    `select u.id, u.display_name, u.username, m.class_level, (m.status = 'active') as active, ${JOINED} as joined
       from memberships m join users u on u.id = m.user_id
      where m.tuition_id = @T and m.user_id = $1 and m.role = 'student' and m.status in ('active', 'off')`,
    [id],
  );
  if (!s) throw notFound('This student');
  const { rates, payments } = await historyOf(t.id, id);
  const months = monthsOf(rates, payments, s.joined, istToday());
  return c.json({
    student: s, this_month: thisMonth(), today: istToday(), upi: await upiOf(t.id), rates, months, payments,
    ...summary(rates, months, thisMonth()),
  });
});

/**
 * Sets a monthly fee from a month on, for one student, a list, or everyone in a group or a course now: { fee_paise, due_day,
 * from (YYYY-MM, this month when left out) } with student_ids, or class_level and subject_id, or course_id. A fee of 0 stops it.
 * A fee set from a month replaces any set for later months; the months before keep the fee they had.
 */
feeRoutes.put('/fees/rates', async (c) => {
  const t = ownerOf(c);
  const me = c.get('user');
  const b = await readBody(c);
  const fee = readPaise(b.fee_paise, 'A monthly fee', 0, MAX_FEE_PAISE);
  const dueDay = readDueDay(b.due_day);
  const from = readMonth(b.from);
  let ids: string[];
  if (b.student_ids !== undefined) {
    ids = readStudentIds(b.student_ids);
    const known = await tq(
      t.id,
      `select user_id from memberships where tuition_id = @T and role = 'student' and status in ('active', 'off') and user_id = any($1::uuid[])`,
      [ids],
    );
    if (known.length !== ids.length) throw bad('One of the students is not in this tuition.');
  } else if (b.course_id !== undefined || b.class_level !== undefined) {
    ids = (await classStudents(t.id, await whichClass(t.id, b))).map((s) => s.id);
    if (!ids.length) throw bad('There is nobody in this class to set a fee for.');
  } else {
    throw bad('Say who the fee is for: students, a group or a course.');
  }
  await tx(async (cx) => {
    await tq(t.id, 'delete from fee_rates where tuition_id = @T and student_id = any($1::uuid[]) and from_month > $2::date', [ids, first(from)], cx);
    await tq(
      t.id,
      `insert into fee_rates (tuition_id, student_id, from_month, fee_paise, due_day, set_by)
       select @T, s, $2::date, $3, $4, $5 from unnest($1::uuid[]) as s
       on conflict (tuition_id, student_id, from_month)
       do update set fee_paise = excluded.fee_paise, due_day = excluded.due_day, set_by = excluded.set_by, set_at = now()`,
      [ids, first(from), fee, dueDay, me.id],
      cx,
    );
  });
  return c.json({ students: ids.length, from, fee_paise: fee, due_day: dueDay });
});

/**
 * Records a payment the tutor has received: { student_id, month, amount_paise, method, paid_on, reference }. It is confirmed
 * with the next receipt number. If the student has said they paid for that month and it waits to be confirmed, this confirms
 * their payment instead of adding another, so the month is not counted twice.
 */
feeRoutes.post('/fees/payments', async (c) => {
  const t = ownerOf(c);
  const me = c.get('user');
  const b = await readBody(c);
  const studentId = uuid(b.student_id, 'student id');
  const month = readMonth(b.month);
  const amount = readPaise(b.amount_paise, 'The amount', 1, MAX_PAYMENT_PAISE);
  const method = readMethod(b.method);
  const paidOn = readPaidOn(b.paid_on);
  const reference = readReference(b.reference);
  const out = await tx(async (cx) => {
    const s = await tq1<{ display_name: string }>(
      t.id,
      `select u.display_name from memberships m join users u on u.id = m.user_id
        where m.tuition_id = @T and m.user_id = $1 and m.role = 'student' and m.status in ('active', 'off')`,
      [studentId],
      cx,
    );
    if (!s) throw notFound('This student');
    const claim = await tq1<{ id: string }>(
      t.id,
      `select id from fee_payments where tuition_id = @T and student_id = $1 and month = $2::date and status = 'claimed' for update`,
      [studentId, first(month)],
      cx,
    );
    const no = await nextReceipt(t.id, cx);
    const row = claim
      ? await tq1(
          t.id,
          `update fee_payments p set status = 'confirmed', amount_paise = $2, method = $3, paid_on = $4::date, reference = coalesce($5, p.reference),
                  receipt_no = $6, recorded_by = $7, confirmed_by = $7, confirmed_at = now()
            where p.id = $1 and p.tuition_id = @T
           returning ${PAYMENT}`,
          [claim.id, amount, method, paidOn, reference, no, me.id],
          cx,
        )
      : await tq1(
          t.id,
          `insert into fee_payments as p (tuition_id, student_id, student_name, month, amount_paise, method, paid_on, reference, status, receipt_no,
                                         recorded_by, confirmed_by, confirmed_at)
           values (@T, $1, $2, $3::date, $4, $5, $6::date, $7, 'confirmed', $8, $9, $9, now())
           returning ${PAYMENT}`,
          [studentId, s.display_name, first(month), amount, method, paidOn, reference, no, me.id],
          cx,
        );
    return { row, settled: !!claim };
  });
  tell([studentId], t.name, `Your tutor has received ${rupees(amount)} for ${monthName(month)}. Receipt ${out.row.receipt_no}.`);
  return c.json({ payment: out.row, settled_claim: out.settled }, 201);
});

/** Confirms a payment a student said they made: it takes the next receipt number. Confirming it twice changes nothing. */
feeRoutes.post('/fees/payments/:id/confirm', async (c) => {
  const t = ownerOf(c);
  const me = c.get('user');
  const id = uuid(c.req.param('id'), 'payment id');
  const out = await tx(async (cx) => {
    const p = await tq1<{ status: string }>(t.id, 'select status from fee_payments where id = $1 and tuition_id = @T for update', [id], cx);
    if (!p) throw notFound('This payment');
    if (p.status === 'confirmed') return { row: await tq1(t.id, `select ${PAYMENT} from fee_payments p where p.id = $1 and p.tuition_id = @T`, [id], cx), fresh: false };
    const no = await nextReceipt(t.id, cx);
    const row = await tq1(
      t.id,
      `update fee_payments p set status = 'confirmed', receipt_no = $2, confirmed_by = $3, confirmed_at = now()
        where p.id = $1 and p.tuition_id = @T returning ${PAYMENT}`,
      [id, no, me.id],
      cx,
    );
    return { row, fresh: true };
  });
  const r = out.row;
  if (out.fresh) tell([r.student_id], t.name, `Your tutor has confirmed the ${rupees(r.amount_paise)} you paid for ${monthName(r.month)}. Receipt ${r.receipt_no}.`);
  return c.json({ payment: r });
});

/**
 * Takes a payment away: one recorded by mistake, or one a student said they made that the tutor did not get (the student is
 * told). Its receipt number is not given again.
 */
feeRoutes.delete('/fees/payments/:id', async (c) => {
  const t = ownerOf(c);
  const id = uuid(c.req.param('id'), 'payment id');
  const p = await tq1<{ status: string; student_id: string | null; amount_paise: number; month: string }>(
    t.id,
    `delete from fee_payments where id = $1 and tuition_id = @T returning status, student_id, amount_paise, to_char(month, 'YYYY-MM') as month`,
    [id],
  );
  if (!p) throw notFound('This payment');
  if (p.status === 'claimed') {
    tell([p.student_id], t.name, `Your tutor has not received the ${rupees(p.amount_paise)} you marked as paid for ${monthName(p.month)}. Please check with them.`);
  }
  return c.json({ ok: true });
});

/** The UPI id students and parents pay to, and the name their UPI app shows (the tuition's name when left out). Empty takes it away. */
feeRoutes.put('/fees/upi', async (c) => {
  const t = ownerOf(c);
  const b = await readBody(c);
  const id = readUpiId(b.upi_id);
  const name = id ? readUpiName(b.upi_name) : null;
  await tq(t.id, 'update tuitions set upi_id = $1, upi_name = $2 where id = @T', [id, name]);
  return c.json({ upi: await upiOf(t.id) });
});

// ---------------------------------------------------------------- the student's own

/** The student's membership here: their name and the month they joined. */
async function meHere(T: string, studentId: string, db: Db = pool) {
  const m = await tq1<{ display_name: string; joined: string }>(
    T,
    `select u.display_name, ${JOINED} as joined from memberships m join users u on u.id = m.user_id
      where m.tuition_id = @T and m.user_id = $1 and m.role = 'student' and m.status = 'active'`,
    [studentId],
    db,
  );
  if (!m) throw notFound('Your place in this tuition');
  return m;
}

/** The UPI id to pay to, with the name a UPI app shows: the tutor's, or the tuition's name. */
async function payTo(T: string, name: string, db: Db = pool) {
  const u = await upiOf(T, db);
  return u ? { id: u.id, name: u.name ?? name } : null;
}

/** On the student's Home: what is owed now, the oldest month first, or this month paid. Null when no fee was ever set. */
export async function feeForStudentHome(T: string, studentId: string, now = new Date()) {
  const joined = await joinedMonth(T, studentId);
  if (!joined) return null;
  const { rates, payments } = await historyOf(T, studentId);
  if (!rates.length) return null;
  const months = monthsOf(rates, payments, joined, istToday(now));
  const s = summary(rates, months, thisMonth(now));
  if (!s.owing.length && !s.month) return null;
  return { owing: s.owing, left: s.left, month: s.month };
}

/** The student's fees here: each month owed or paid for, their payments with receipts, and where to pay by UPI. */
studentFeeRoutes.get('/fees', async (c) => {
  const me = c.get('user');
  const t = tuitionOf(c);
  const m = await meHere(t.id, me.id);
  const { rates, payments } = await historyOf(t.id, me.id);
  const months = monthsOf(rates, payments, m.joined, istToday());
  return c.json({
    tuition: { id: t.id, name: t.name }, this_month: thisMonth(), today: istToday(), upi: await payTo(t.id, t.name),
    months, payments, ...summary(rates, months, thisMonth()),
  });
});

/**
 * "I have paid": the student paid the rest of a month's fee by UPI, { month, reference }. It waits for the owner to confirm it,
 * and the owner is told. One at a time for a month.
 */
studentFeeRoutes.post('/fees/paid', async (c) => {
  const me = c.get('user');
  const t = tuitionOf(c);
  const b = await readBody(c);
  const month = readMonth(b.month);
  const reference = readReference(b.reference);
  const row = await tx(async (cx) => {
    if (!(await upiOf(t.id, cx))) throw bad('Your tutor has not added a UPI id yet. Pay them another way, and they will note it here.');
    const m = await meHere(t.id, me.id, cx);
    const { rates, payments } = await historyOf(t.id, me.id, cx);
    // Any month with a fee, next month's too, to pay ahead.
    const owed = monthOf(rates, payments, m.joined, istToday(), month);
    if (!owed.fee) throw bad('There is no fee to pay for that month.');
    if (owed.status === 'paid') throw bad('That month is paid already.');
    if (owed.status === 'claimed') throw new HttpError(409, 'claimed', 'You have told your tutor about this payment already.');
    try {
      return await tq1(
        t.id,
        `insert into fee_payments as p (tuition_id, student_id, student_name, month, amount_paise, method, paid_on, reference, status, recorded_by)
         values (@T, $1, $2, $3::date, $4, 'upi', $5::date, $6, 'claimed', $1)
         returning ${PAYMENT}`,
        [me.id, m.display_name, first(month), owed.left, istToday(), reference],
        cx,
      );
    } catch (e: any) {
      if (e?.code === '23505') throw new HttpError(409, 'claimed', 'You have told your tutor about this payment already.');
      throw e;
    }
  });
  tell(await ownersOf(t.id), t.name, `${row.student_name} says they paid ${rupees(row.amount_paise)} for ${monthName(month)} by UPI. Open Fees to confirm it.`);
  return c.json({ payment: row }, 201);
});

/** Takes back an "I have paid" the tutor has not confirmed yet. */
studentFeeRoutes.delete('/fees/claims/:id', async (c) => {
  const me = c.get('user');
  const t = tuitionOf(c);
  const id = uuid(c.req.param('id'), 'payment id');
  const gone = await tq1(t.id, `delete from fee_payments where id = $1 and tuition_id = @T and student_id = $2 and status = 'claimed' returning id`, [id, me.id]);
  if (!gone) throw notFound('This payment');
  return c.json({ ok: true });
});
