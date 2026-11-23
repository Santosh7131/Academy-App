// Checks fees end to end (routes/fees.ts, lib/fees.ts; migration 039): only the owner sees fees, a helper tutor and students
// do not; the UPI id; a fee set for a group, for a list, and from next month, and stopped; payments recorded with receipt
// numbers that are never given twice; a student's "I have paid", taken back, confirmed, settled by the tutor recording it, or
// turned down; a payment taken away; the owner's Home and a student's page and Home; a student removed from the tuition and a
// student who deletes their account both leave their payments on record by name; and another tuition reaches none of it.
// The API runs in this process against the dev database. Makes its own tutors, tuitions and students and removes them again.
// Dev only. Needs migration 039.
// Usage: node tools/fees-test.ts
import { randomInt } from 'node:crypto';
import pg from 'pg';
import { istToday } from '../api/src/lib/attendance.ts';
import { addMonths, thisMonth } from '../api/src/lib/fees.ts';

process.loadEnvFile('.env.local');
try { process.loadEnvFile('api/.env.secrets'); } catch {}
// Dev only: a database on this PC (tools/local-stack.mjs), or the dev branch whose host DEV_DATABASE_HOST names.
const devHosts = ['127.0.0.1', 'localhost', process.env.DEV_DATABASE_HOST].filter(Boolean);
const dbHost = (() => { try { return new URL(String(process.env.DATABASE_URL)).hostname; } catch { return ''; } })();
if (process.env.NEON_BRANCH !== 'dev' || !devHosts.includes(dbHost)) throw new Error('This only runs against a dev database.');
process.env.PUSH_DRY_RUN = '1';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `  -> ${JSON.stringify(detail)}`}`);
}

const { default: app } = await import('../api/src/index.ts');
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

const db = new pg.Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
await db.connect();
const count = async (sql: string, params: unknown[]) => Number((await db.query(sql, params)).rows[0].n);

const tag = `fee${randomInt(1000, 9999)}`;
const created = { users: [] as string[], tuitions: [] as string[] };
const month = thisMonth();
const next = addMonths(month, 1);
const today = istToday();

async function newTutor(suffix: string) {
  const su = await api('POST', '/auth/signup-tutor', undefined, { display_name: `Fees ${suffix}`, username: `${tag}.${suffix}`, password: 'longenough1' }, { 'x-install-id': `${tag}-${suffix}` });
  if (su.status !== 201) throw new Error(`sign-up failed: ${JSON.stringify(su.body)}`);
  created.users.push(su.body.user.id);
  const T = su.body.token as string;
  const mk = await api('POST', '/auth/tuitions', T, { name: `${tag} ${suffix}`, groups: [{ class_level: 9, subject_id: MATHS }] });
  if (mk.status !== 201) throw new Error(`tuition failed: ${JSON.stringify(mk.body)}`);
  created.tuitions.push(mk.body.tuition.id);
  return { T, tuition: mk.body.tuition.id as string };
}

async function newStudent(T: string, name: string, subjects: string[]) {
  const r = await api('POST', '/teacher/students', T, { display_name: `${tag} ${name}`, class_level: 9, username: `${tag}.${name.toLowerCase()}`, pin: '2468', subject_ids: subjects });
  if (r.status !== 201) throw new Error(`student failed: ${JSON.stringify(r.body)}`);
  created.users.push(r.body.student.id);
  const login = await api('POST', '/auth/login', undefined, { username: `${tag}.${name.toLowerCase()}`, secret: '2468' });
  return { id: r.body.student.id as string, token: login.body?.token as string };
}

const row = (r: { body: any }, id: string) => r.body?.students?.find((s: any) => s.id === id);
const view = (T: string, m = month) => api('GET', `/teacher/fees?month=${m}`, T);

try {
  const A = await newTutor('a');
  const asha = await newStudent(A.T, 'Asha', [MATHS]);
  const ravi = await newStudent(A.T, 'Ravi', [MATHS]);
  const kiran = await newStudent(A.T, 'Kiran', []);
  check('the students log in', !!(asha.token && ravi.token && kiran.token));

  // ---------------------------------------------------------------- only the owner
  // Free has room for one tutor (lib/plans.ts): the run's tuition is on Basic for its second, its AI for the month counted as given
  // so its credit is as it was.
  await db.query(`update tuitions set plan = 'basic', plan_from = current_date - 1, plan_until = current_date + 31, plan_refilled = current_date - 1 where id = $1`, [A.tuition]);
  const tu = await api('POST', '/teacher/tutors', A.T, { display_name: 'Fees helper', username: `${tag}.helper`, password: 'longenough2' });
  if (tu.body?.tutor?.id ?? tu.body?.user?.id) created.users.push(tu.body.tutor?.id ?? tu.body.user?.id);
  const helper = (await api('POST', '/auth/login', undefined, { username: `${tag}.helper`, secret: 'longenough2' })).body?.token as string;
  const denied = await api('GET', '/teacher/fees', helper);
  check('a helper tutor cannot see fees', denied.status === 403 && denied.body?.error?.code === 'owner_only', denied.body);
  check('nor change the UPI id', (await api('PUT', '/teacher/fees/upi', helper, { upi_id: 'someone@examplebank' })).status === 403);
  check('nor record a payment', (await api('POST', '/teacher/fees/payments', helper, { student_id: asha.id, month, amount_paise: 100, method: 'cash' })).status === 403);
  check("a helper's Home has no fees", (await api('GET', '/teacher/home', helper)).body?.fees === undefined);
  check("nor a student's page", (await api('GET', `/teacher/students/${asha.id}`, helper)).body?.fee === undefined);
  check('a student cannot use the owner\'s routes', (await api('GET', '/teacher/fees', asha.token)).status === 403);

  // ---------------------------------------------------------------- before any fee
  const empty = await view(A.T);
  check('no fee yet: everyone is listed as having none', empty.status === 200 && empty.body.students.length === 0 && empty.body.no_fee.length === 3 && empty.body.upi === null && empty.body.totals.expected === 0, empty.body);
  const ownerHome = (await api('GET', '/teacher/home', A.T)).body?.fees;
  check("the owner's Home has fees", ownerHome?.month === month && ownerHome.no_fee === 3 && ownerHome.claims === 0 && ownerHome.upi === false, ownerHome);
  check("a student's page says no fee is set", (await api('GET', `/teacher/students/${asha.id}`, A.T)).body?.fee?.set === false);
  check("and the student's Home shows none", (await api('GET', '/student/home', asha.token)).body?.fee === null);
  check('a student cannot say they paid before there is a UPI id', (await api('POST', '/student/fees/paid', asha.token, { month })).status === 400);

  // ---------------------------------------------------------------- the UPI id
  check('a UPI id must look like one', (await api('PUT', '/teacher/fees/upi', A.T, { upi_id: 'priya.examplebank' })).status === 400);
  const upi = await api('PUT', '/teacher/fees/upi', A.T, { upi_id: ' Priya.Classes@ExampleBank ', upi_name: 'Priya Sharma' });
  check('the UPI id is kept in lower case, with its name', upi.status === 200 && upi.body.upi?.id === 'priya.classes@examplebank' && upi.body.upi.name === 'Priya Sharma', upi.body);

  // ---------------------------------------------------------------- setting fees
  check('a fee must say who it is for', (await api('PUT', '/teacher/fees/rates', A.T, { fee_paise: 150000, due_day: 5 })).status === 400);
  check('due on the 29th is refused', (await api('PUT', '/teacher/fees/rates', A.T, { fee_paise: 150000, due_day: 29, student_ids: [asha.id] })).status === 400);
  check('a fee in rupees with paise is refused', (await api('PUT', '/teacher/fees/rates', A.T, { fee_paise: 1500.5, due_day: 5, student_ids: [asha.id] })).status === 400);
  check('the month after next is too far', (await api('PUT', '/teacher/fees/rates', A.T, { fee_paise: 150000, due_day: 5, student_ids: [asha.id], from: addMonths(month, 2) })).status === 400);
  const group = await api('PUT', '/teacher/fees/rates', A.T, { fee_paise: 150000, due_day: 5, class_level: 9, subject_id: MATHS });
  check('a fee for a group is set for its students', group.status === 200 && group.body.students === 2 && group.body.from === month, group.body);
  check('a fee for one student', (await api('PUT', '/teacher/fees/rates', A.T, { fee_paise: 120000, due_day: 10, student_ids: [kiran.id] })).body?.students === 1);
  const set = await view(A.T);
  check('everyone owes this month, from the month they joined', set.body.students.length === 3 && set.body.no_fee.length === 0 && set.body.totals.expected === 420000 && set.body.totals.left === 420000 && set.body.totals.unpaid === 3, set.body.totals);
  check('each with their fee and due date', row(set, asha.id)?.fee === 150000 && row(set, asha.id)?.due_on === `${month}-05` && row(set, kiran.id)?.due_on === `${month}-10` && row(set, asha.id)?.status === 'unpaid', row(set, asha.id));

  // ---------------------------------------------------------------- recording payments
  check('an amount of nothing is refused', (await api('POST', '/teacher/fees/payments', A.T, { student_id: asha.id, month, amount_paise: 0, method: 'cash' })).status === 400);
  check('a cheque is "other"', (await api('POST', '/teacher/fees/payments', A.T, { student_id: asha.id, month, amount_paise: 150000, method: 'cheque' })).status === 400);
  check('a payment tomorrow is refused', (await api('POST', '/teacher/fees/payments', A.T, { student_id: asha.id, month, amount_paise: 150000, method: 'cash', paid_on: '2099-01-01' })).status === 400);
  const cash = await api('POST', '/teacher/fees/payments', A.T, { student_id: asha.id, month, amount_paise: 150000, method: 'cash' });
  check('cash is recorded, confirmed, with receipt 1', cash.status === 201 && cash.body.payment.status === 'confirmed' && cash.body.payment.receipt_no === 1 && cash.body.payment.paid_on === today && cash.body.payment.confirmed_by === 'Fees a', cash.body);
  const part = await api('POST', '/teacher/fees/payments', A.T, { student_id: ravi.id, month, amount_paise: 50000, method: 'upi', reference: '612345678901' });
  check('part of a fee by UPI, receipt 2', part.status === 201 && part.body.payment.receipt_no === 2 && part.body.payment.reference === '612345678901', part.body);
  const after = await view(A.T);
  check('the month adds up', row(after, asha.id)?.status === 'paid' && row(after, ravi.id)?.left === 100000 && after.body.totals.collected === 200000 && after.body.totals.left === 220000 && after.body.totals.paid === 1, after.body.totals);

  // ---------------------------------------------------------------- "I have paid"
  const mine = await api('GET', '/student/fees', ravi.token);
  const ravMonth = mine.body?.months?.find((m: any) => m.month === month);
  check("the student sees what is left and where to pay", mine.status === 200 && ravMonth?.left === 100000 && mine.body.upi?.id === 'priya.classes@examplebank' && mine.body.upi.name === 'Priya Sharma', mine.body);
  const claim = await api('POST', '/student/fees/paid', ravi.token, { month, reference: '998877665544' });
  check('the student says they paid the rest, and it waits', claim.status === 201 && claim.body.payment.status === 'claimed' && claim.body.payment.amount_paise === 100000 && claim.body.payment.receipt_no === null, claim.body);
  check('saying it twice is refused', (await api('POST', '/student/fees/paid', ravi.token, { month })).status === 409);
  check("the student's Home says it waits", (await api('GET', '/student/home', ravi.token)).body?.fee?.owing?.[0]?.status === 'claimed');
  const waiting = await view(A.T);
  check('the owner sees it waiting to be confirmed', waiting.body.claims.length === 1 && waiting.body.claims[0].id === claim.body.payment.id && row(waiting, ravi.id)?.status === 'claimed' && waiting.body.totals.waiting === 100000, waiting.body.claims);
  check("and on Home", (await api('GET', '/teacher/home', A.T)).body?.fees?.claims === 1);
  check('a student can take it back', (await api('DELETE', `/student/fees/claims/${claim.body.payment.id}`, ravi.token)).status === 200);
  check('and then it is gone', (await view(A.T)).body.claims.length === 0);
  const again = await api('POST', '/student/fees/paid', ravi.token, { month, reference: '998877665544' });
  check('and say it again', again.status === 201);
  check("another student cannot take it back", (await api('DELETE', `/student/fees/claims/${again.body.payment.id}`, asha.token)).status === 404);
  const ok = await api('POST', `/teacher/fees/payments/${again.body.payment.id}/confirm`, A.T);
  check('the owner confirms it: receipt 3', ok.status === 200 && ok.body.payment.status === 'confirmed' && ok.body.payment.receipt_no === 3, ok.body);
  const twice = await api('POST', `/teacher/fees/payments/${again.body.payment.id}/confirm`, A.T);
  check('confirming twice changes nothing', twice.status === 200 && twice.body.payment.receipt_no === 3);
  check('the student cannot take back a confirmed payment', (await api('DELETE', `/student/fees/claims/${again.body.payment.id}`, ravi.token)).status === 404);
  check("the student's month is paid", (await api('GET', '/student/fees', ravi.token)).body?.months?.find((m: any) => m.month === month)?.status === 'paid');

  // Recording a payment the student has already said they made confirms theirs, so the month is not counted twice.
  const kClaim = await api('POST', '/student/fees/paid', kiran.token, { month });
  const kCash = await api('POST', '/teacher/fees/payments', A.T, { student_id: kiran.id, month, amount_paise: 120000, method: 'upi' });
  check("recording it confirms the student's own", kCash.status === 201 && kCash.body.settled_claim === true && kCash.body.payment.id === kClaim.body?.payment?.id && kCash.body.payment.receipt_no === 4, kCash.body);
  check('one payment for the month, not two', (await count('select count(*) as n from fee_payments where student_id = $1 and month = $2::date', [kiran.id, `${month}-01`])) === 1);

  // Paying ahead, turned down: the owner did not get it.
  const ahead = await api('POST', '/student/fees/paid', asha.token, { month: next });
  check('next month can be paid ahead', ahead.status === 201 && ahead.body.payment.month === next, ahead.body);
  check('the owner turns it down', (await api('DELETE', `/teacher/fees/payments/${ahead.body.payment.id}`, A.T)).status === 200);
  check('and it is gone', (await count('select count(*) as n from fee_payments where id = $1', [ahead.body.payment.id])) === 0);
  check('a month with no fee cannot be claimed', (await api('POST', '/student/fees/paid', asha.token, { month: addMonths(month, -3) })).status === 400);

  // ---------------------------------------------------------------- mistakes, and receipt numbers
  check("a payment recorded by mistake can be taken away", (await api('DELETE', `/teacher/fees/payments/${cash.body.payment.id}`, A.T)).status === 200);
  check("and Asha's month is owed again", row(await view(A.T), asha.id)?.status === 'unpaid');
  check('taking it away twice: not found', (await api('DELETE', `/teacher/fees/payments/${cash.body.payment.id}`, A.T)).status === 404);
  const redo = await api('POST', '/teacher/fees/payments', A.T, { student_id: asha.id, month, amount_paise: 150000, method: 'cash' });
  check('the next receipt is 5: no number is given twice', redo.body?.payment?.receipt_no === 5, redo.body);

  // ---------------------------------------------------------------- changing and stopping a fee
  await api('PUT', '/teacher/fees/rates', A.T, { fee_paise: 180000, due_day: 7, student_ids: [asha.id], from: next });
  check('a new fee from next month leaves this month alone', row(await view(A.T), asha.id)?.fee === 150000 && row(await view(A.T, next), asha.id)?.fee === 180000);
  await api('PUT', '/teacher/fees/rates', A.T, { fee_paise: 160000, due_day: 5, student_ids: [asha.id], from: month });
  check('a fee set from this month replaces the one set for next', row(await view(A.T, next), asha.id)?.fee === 160000 && row(await view(A.T), asha.id)?.fee === 160000);
  check("this month's payment now leaves a part to pay", row(await view(A.T), asha.id)?.left === 10000);
  await api('PUT', '/teacher/fees/rates', A.T, { fee_paise: 0, due_day: 10, student_ids: [kiran.id], from: next });
  const stopped = await view(A.T, next);
  check('a fee of nothing stops it, without asking for a fee again', !row(stopped, kiran.id) && stopped.body.no_fee.every((s: any) => s.id !== kiran.id), stopped.body);

  // ---------------------------------------------------------------- a student's page and Home
  const page = (await api('GET', `/teacher/students/${asha.id}`, A.T)).body?.fee;
  check("a student's page has their fee and what is left", page?.fee === 160000 && page.month?.status === 'unpaid' && page.left === 10000, page);
  const detail = await api('GET', `/teacher/fees/students/${asha.id}`, A.T);
  check("a student's fees: months and payments with receipts", detail.status === 200 && detail.body.payments.length === 1 && detail.body.payments[0].receipt_no === 5 && detail.body.rates.length === 1 && detail.body.months[0].month === month, detail.body);
  const aHome = (await api('GET', '/student/home', asha.token)).body?.fee;
  check("the student's Home says what is left", aHome?.left === 10000 && aHome.owing?.[0]?.month === month, aHome);

  // ---------------------------------------------------------------- payments stay on record
  const before = (await view(A.T)).body.totals.collected;
  check('removing a student', (await api('DELETE', `/teacher/students/${ravi.id}`, A.T)).status === 200);
  const gone = await view(A.T);
  check('their payments stay, by name, and the month still adds up', !row(gone, ravi.id) && gone.body.others.filter((p: any) => p.student_name === `${tag} Ravi`).length === 2 && gone.body.totals.collected === before, gone.body);
  // Their money counts in what was expected too: "paid so far" must not reach the whole while someone here still owes.
  const g = gone.body.totals;
  check('what came in and what is still to come make the whole', g.left > 0 && g.expected === g.collected + g.left && g.collected < g.expected, g);
  check('their fee is gone', (await count('select count(*) as n from fee_rates where student_id = $1', [ravi.id])) === 0);
  const del = await api('POST', '/auth/delete-account', kiran.token, { secret: '2468' });
  check('a student deletes their account', del.status === 200, del.body);
  const after2 = await view(A.T);
  const kept = after2.body.others.find((p: any) => p.student_name === `${tag} Kiran`);
  check('their payment stays too, by name', kept?.student_id === null && kept.receipt_no === 4 && after2.body.totals.collected === before, after2.body.others);

  // ---------------------------------------------------------------- another tuition
  const B = await newTutor('b');
  const bView = await view(B.T);
  check("another tuition's fees have none of these", bView.status === 200 && bView.body.students.length === 0 && bView.body.others.length === 0 && bView.body.claims.length === 0 && bView.body.upi === null, bView.body);
  check("and cannot open this tuition's student", (await api('GET', `/teacher/fees/students/${asha.id}`, B.T)).status === 404);
  check('nor set their fee', (await api('PUT', '/teacher/fees/rates', B.T, { fee_paise: 100, due_day: 1, student_ids: [asha.id] })).status === 400);
  check('nor record a payment for them', (await api('POST', '/teacher/fees/payments', B.T, { student_id: asha.id, month, amount_paise: 100, method: 'cash' })).status === 404);
  check('nor confirm or take away a payment', (await api('POST', `/teacher/fees/payments/${redo.body.payment.id}/confirm`, B.T)).status === 404
    && (await api('DELETE', `/teacher/fees/payments/${redo.body.payment.id}`, B.T)).status === 404);
  check("and B's receipts start at 1", (await api('POST', '/teacher/fees/payments', B.T, { student_id: (await newStudent(B.T, 'Bina', [MATHS])).id, month, amount_paise: 100, method: 'cash' })).body?.payment?.receipt_no === 1);
} catch (e) {
  fail++;
  console.log('FAIL  the run stopped:', e);
} finally {
  // What this run made goes: the tests first, as the route that deletes a tuition does. Fees go with their tuition.
  if (created.tuitions.length) await db.query('delete from tests where tuition_id = any($1::uuid[])', [created.tuitions]).catch(() => {});
  if (created.tuitions.length) await db.query('delete from tuitions where id = any($1::uuid[])', [created.tuitions]);
  if (created.users.length) await db.query('delete from users where id = any($1::uuid[])', [created.users]);
  await db.query('delete from users where username like $1', [`${tag}.%`]);
  await db.end();
  const { pool } = await import('../api/src/lib/db.ts');
  await pool.end().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
