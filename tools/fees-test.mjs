// Checks for the rules of fees (api/src/lib/fees.ts), with no server or database: months and their window, money in paise and
// in rupees, the due day, how a payment was made and when, UPI ids, where a month stands, and a student's months worked out
// from the fees set and the payments made. routes/fees.ts is checked end to end by tools/fees-test.ts.
// Run: node tools/fees-test.mjs
import {
  addMonths, dueOn, feeStatus, MAX_FEE_PAISE, monthName, monthsOf, rateFor, readDueDay, readMethod, readMonth, readPaidOn, readPaise,
  readReference, readStudentIds, readUpiId, readUpiName, rupees, thisMonth,
} from '../api/src/lib/fees.ts';

let fail = 0;
let pass = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : `\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
};
/** The message a call is turned away with, or null when it is not. */
const refused = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e.status === 400 ? e.message : `not a 400: ${e}`;
  }
};

// 23 Nov 2026, 11:30 pm in India, is still November there; 24 Nov at 12:10 am in India is 6:40 pm on the 23rd in UTC.
const lateNov = new Date('2026-11-23T18:00:00Z');
const endOfMonth = new Date('2026-11-30T19:00:00Z'); // 1 Dec, 12:30 am in India

// ------------------------------------------------------------------ months
eq('this month is India\'s', thisMonth(lateNov), '2026-11');
eq('half past midnight on 1 Dec in India is December', thisMonth(endOfMonth), '2026-12');
eq('a month on', addMonths('2026-11', 1), '2026-12');
eq('over the year', addMonths('2026-12', 1), '2027-01');
eq('back over the year', addMonths('2027-01', -1), '2026-12');
eq('two years back', addMonths('2026-11', -24), '2024-11');
eq('a month by name', monthName('2026-11'), 'November 2026');
eq('none means this month', readMonth(undefined, lateNov), '2026-11');
eq('next month can be set', readMonth('2026-12', lateNov), '2026-12');
eq('the month after is too far', refused(() => readMonth('2027-01', lateNov)), 'That month is too far ahead. A fee can be set or paid up to next month.');
eq('two years back is allowed', readMonth('2024-11', lateNov), '2024-11');
eq('more than two years back is not', refused(() => readMonth('2024-10', lateNov)), 'That month is more than two years ago.');
eq('a month written another way', refused(() => readMonth('11-2026', lateNov)), 'The month should be written like 2026-11.');
eq('month 13', refused(() => readMonth('2026-13', lateNov)), 'The month should be written like 2026-11.');

// ------------------------------------------------------------------ money
eq('₹1,500', rupees(150000), '₹1,500');
eq('lakhs the Indian way', rupees(10000000), '₹1,00,000');
eq('crores', rupees(1234567800), '₹1,23,45,678');
eq('under a thousand', rupees(50000), '₹500');
eq('paise shown when there are some', rupees(150050), '₹1,500.50');
eq('a fee of nothing stops it', readPaise(0, 'A monthly fee', 0, MAX_FEE_PAISE), 0);
eq('a fee in whole paise', readPaise(150000, 'A monthly fee', 0, MAX_FEE_PAISE), 150000);
eq('not a fraction of a paisa', refused(() => readPaise(1500.5, 'A monthly fee', 0, MAX_FEE_PAISE)), 'A monthly fee should be a whole number of paise.');
eq('not text', refused(() => readPaise('1500', 'A monthly fee', 0, MAX_FEE_PAISE)), 'A monthly fee should be a whole number of paise.');
eq('not below nothing', refused(() => readPaise(-1, 'A monthly fee', 0, MAX_FEE_PAISE)), 'A monthly fee cannot be less than nothing.');
eq('a payment is more than nothing', refused(() => readPaise(0, 'The amount', 1, 100)), 'The amount should be more than ₹0.');
eq('a fee up to ₹1,00,000', refused(() => readPaise(MAX_FEE_PAISE + 1, 'A monthly fee', 0, MAX_FEE_PAISE)), 'A monthly fee can be up to ₹1,00,000.');

// ------------------------------------------------------------------ due day, method, day paid, reference
eq('due on the 5th', readDueDay(5), 5);
eq('the 28th is the last', readDueDay(28), 28);
eq('not the 29th, which February lacks', refused(() => readDueDay(29)), 'The fee should be due on a day from 1 to 28.');
eq('not the 0th', refused(() => readDueDay(0)), 'The fee should be due on a day from 1 to 28.');
eq('the due date of a month', dueOn('2026-11', 5), '2026-11-05');
eq('cash', readMethod('cash'), 'cash');
eq('UPI', readMethod('upi'), 'upi');
eq('a cheque is "other"', refused(() => readMethod('cheque')), 'Say how it was paid: cash, UPI or other.');
eq('paid today when not said', readPaidOn(undefined, lateNov), '2026-11-23');
eq('paid yesterday', readPaidOn('2026-11-22', lateNov), '2026-11-22');
eq('not paid tomorrow', refused(() => readPaidOn('2026-11-24', lateNov)), 'A payment cannot be made on a day that has not come yet.');
eq('not 30 February', refused(() => readPaidOn('2026-02-30', lateNov)), '2026-02-30 is not a date.');
eq('not more than two years back', refused(() => readPaidOn('2024-10-31', lateNov)), 'That day is more than two years ago.');
eq('a reference is tidied', readReference('  6123 4567  8901 '), '6123 4567 8901');
eq('an empty reference is none', readReference('   '), null);
eq('a reference up to 60 characters', refused(() => readReference('x'.repeat(61))), 'The reference can be up to 60 characters.');

// ------------------------------------------------------------------ UPI
eq('a UPI id', readUpiId('Priya.Classes@okaxis'), 'priya.classes@okaxis');
eq('spaces around it go', readUpiId('  priya@ybl '), 'priya@ybl');
eq('empty takes it away', readUpiId(''), null);
eq('no @', refused(() => readUpiId('priya.okaxis')), 'That is not a UPI id. It looks like name@bank, such as priya@okaxis.');
eq('a space inside', refused(() => readUpiId('priya sharma@okaxis')), 'That is not a UPI id. It looks like name@bank, such as priya@okaxis.');
eq('a link is not a UPI id', refused(() => readUpiId('upi://pay?pa=x@ybl')), 'That is not a UPI id. It looks like name@bank, such as priya@okaxis.');
eq('a name is tidied', readUpiName('  Priya   Sharma '), 'Priya Sharma');
eq('a name up to 50', refused(() => readUpiName('x'.repeat(51))), 'The name can be up to 50 characters.');
eq('students once each', readStudentIds(['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001']), ['00000000-0000-4000-8000-000000000001']);
eq('an empty list', refused(() => readStudentIds([])), 'Say which students.');

// ------------------------------------------------------------------ where a month stands
const today = '2026-11-23';
eq('paid in full', feeStatus({ fee: 150000, paid: 150000, claimed: 0, dueOn: '2026-11-05', today }), { status: 'paid', left: 0, late: false });
eq('paid more than the fee', feeStatus({ fee: 150000, paid: 200000, claimed: 0, dueOn: '2026-11-05', today }), { status: 'paid', left: 0, late: false });
eq('part paid, past the due day', feeStatus({ fee: 150000, paid: 50000, claimed: 0, dueOn: '2026-11-05', today }), { status: 'unpaid', left: 100000, late: true });
eq('not paid, not due yet', feeStatus({ fee: 150000, paid: 0, claimed: 0, dueOn: '2026-11-25', today }), { status: 'unpaid', left: 150000, late: false });
eq('not paid on the due day itself is not late', feeStatus({ fee: 150000, paid: 0, claimed: 0, dueOn: today, today }), { status: 'unpaid', left: 150000, late: false });
eq('the student says they paid', feeStatus({ fee: 150000, paid: 0, claimed: 150000, dueOn: '2026-11-05', today }), { status: 'claimed', left: 150000, late: true });
eq('no fee', feeStatus({ fee: null, paid: 50000, claimed: 0, dueOn: null, today }), { status: 'none', left: 0, late: false });

// ------------------------------------------------------------------ a student's months
const r = (from_month, fee_paise, due_day = 5) => ({ from_month, fee_paise, due_day });
const p = (month, amount_paise, status = 'confirmed') => ({ month, amount_paise, status });
const months = (rates, pays, joined = '2026-01', t = today) => monthsOf(rates, pays, joined, t).map((m) => [m.month, m.fee, m.paid, m.claimed, m.status]);

eq('the fee in force is the latest set before the month', rateFor([r('2026-09', 100000), r('2026-11', 150000)], '2026-10')?.fee_paise, 100000);
eq('none before the first', rateFor([r('2026-09', 100000)], '2026-08'), null);
eq('no fee and nothing paid: no months', months([], []), []);
eq('a fee from September: three months owed, newest first', months([r('2026-09', 150000)], [p('2026-09', 150000)]), [
  ['2026-11', 150000, 0, 0, 'unpaid'], ['2026-10', 150000, 0, 0, 'unpaid'], ['2026-09', 150000, 150000, 0, 'paid'],
]);
eq('a new fee leaves the months before it alone', months([r('2026-09', 100000), r('2026-11', 150000)], [p('2026-09', 100000), p('2026-10', 100000)]), [
  ['2026-11', 150000, 0, 0, 'unpaid'], ['2026-10', 100000, 100000, 0, 'paid'], ['2026-09', 100000, 100000, 0, 'paid'],
]);
eq('nothing is owed before the month they joined', months([r('2026-06', 150000)], [], '2026-10'), [['2026-11', 150000, 0, 0, 'unpaid'], ['2026-10', 150000, 0, 0, 'unpaid']]);
eq('a fee from next month owes nothing yet', months([r('2026-12', 150000)], []), []);
eq('a fee stopped: the stopped months are left out', months([r('2026-08', 150000), r('2026-10', 0)], [p('2026-08', 150000)]), [
  ['2026-09', 150000, 0, 0, 'unpaid'], ['2026-08', 150000, 150000, 0, 'paid'],
]);
eq('a month paid in advance shows', months([r('2026-11', 150000)], [p('2026-11', 150000), p('2026-12', 150000)]), [
  ['2026-12', 150000, 150000, 0, 'paid'], ['2026-11', 150000, 150000, 0, 'paid'],
]);
eq('a payment from before any fee still shows', months([r('2026-11', 150000)], [p('2026-09', 80000)]), [
  ['2026-11', 150000, 0, 0, 'unpaid'], ['2026-09', null, 80000, 0, 'none'],
]);
eq('a claim waits for the tutor', months([r('2026-11', 150000)], [p('2026-11', 150000, 'claimed')]), [['2026-11', 150000, 0, 150000, 'claimed']]);
eq('no further back than two years', monthsOf([r('2020-01', 1000)], [], '2020-01', today).length, 25);
const nov = monthsOf([r('2026-11', 150000, 5)], [], '2026-01', today)[0];
eq('a month carries its due day and date, and whether it is late', [nov.due_day, nov.due_on, nov.late, nov.left], [5, '2026-11-05', true, 150000]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
