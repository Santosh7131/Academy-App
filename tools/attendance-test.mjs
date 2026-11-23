// Checks for the rules of attendance (api/src/lib/attendance.ts), with no server or database: India's date, which days a
// register can be taken for, the month a register list covers, who is marked absent, and one student's marks summed up.
// routes/attendance.ts is checked end to end by tools/attendance-test.ts.
// Run: node tools/attendance-test.mjs
import { addDays, DAYS_BACK, istStart, istToday, MAX_STUDENTS, readAbsent, readDay, readMonth, summarise } from '../api/src/lib/attendance.ts';

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

// ------------------------------------------------------------------ India's date
eq('a class at 11 pm in India is still that day', istToday(new Date('2026-11-23T17:29:00Z')), '2026-11-23');
eq('after midnight in India it is the next day, though not yet in London', istToday(new Date('2026-11-23T18:31:00Z')), '2026-11-24');
eq('early morning in India is the day before in UTC', istToday(new Date('2026-11-23T20:00:00Z')), '2026-11-24');
eq('a day starts at 18:30 UTC the evening before', istStart('2026-11-24').toISOString(), '2026-11-23T18:30:00.000Z');
eq('a day forward', addDays('2026-11-30', 1), '2026-12-01');
eq('a day back over a year', addDays('2026-01-01', -1), '2025-12-31');
eq('a leap day', addDays('2028-02-28', 1), '2028-02-29');

// ------------------------------------------------------------------ the day of a register
const today = '2026-11-23';
eq('no day means today', readDay(undefined, today), today);
eq('an empty day means today', readDay('', today), today);
eq('today', readDay('2026-11-23', today), '2026-11-23');
eq('last month, to fix a mistake', readDay('2026-10-05', today), '2026-10-05');
eq('a year back is the furthest', readDay(addDays(today, -DAYS_BACK), today), addDays(today, -DAYS_BACK));
eq('further back is refused', refused(() => readDay(addDays(today, -DAYS_BACK - 1), today)), 'That day is more than a year ago.');
eq('tomorrow is refused', refused(() => readDay('2026-11-24', today)), 'Attendance cannot be taken for a day that has not come yet.');
eq('a day that does not exist is refused', refused(() => readDay('2026-02-30', today)), '2026-02-30 is not a date.');
eq('another way of writing a date is refused', refused(() => readDay('23/11/2026', today)), 'The day should be written like 2026-11-23.');
eq('a time is refused', refused(() => readDay('2026-11-23T10:00', today)), 'The day should be written like 2026-11-23.');
eq('a number is refused', refused(() => readDay(20261123, today)), 'The day should be written like 2026-11-23.');

// ------------------------------------------------------------------ a month of registers
eq('no month means this month', readMonth(undefined, today), { month: '2026-11', from: '2026-11-01', to: '2026-12-01' });
eq('December runs into January', readMonth('2025-12', today), { month: '2025-12', from: '2025-12-01', to: '2026-01-01' });
eq('February', readMonth('2026-02', today), { month: '2026-02', from: '2026-02-01', to: '2026-03-01' });
eq('next month is refused', refused(() => readMonth('2026-12', today)), 'That month has not come yet.');
eq('month 13 is refused', refused(() => readMonth('2026-13', today)), 'The month should be written like 2026-11.');
eq('a day is not a month', refused(() => readMonth('2026-11-01', today)), 'The month should be written like 2026-11.');

// ------------------------------------------------------------------ who is absent
const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
eq('nobody absent', readAbsent(undefined), []);
eq('an empty list', readAbsent([]), []);
eq('each student once', readAbsent([a, b, a]), [a, b]);
eq('not a list is refused', refused(() => readAbsent(a)), 'Absent should be a list of students.');
eq('a name instead of an id is refused', refused(() => readAbsent(['Asha'])), 'Student id is not valid.');
eq('more than a class can hold is refused', refused(() => readAbsent(Array(MAX_STUDENTS + 1).fill(a))), `A register takes up to ${MAX_STUDENTS} students.`);

// ------------------------------------------------------------------ one student's marks
eq('no registers yet', summarise([]), { classes: 0, present: 0, absent_days: [] });
eq('classes, present, and the days missed, newest first', summarise([
  { day: '2026-11-23', present: true },
  { day: '2026-11-21', present: false },
  { day: '2026-11-20', present: true },
  { day: '2026-11-18', present: false },
]), { classes: 4, present: 2, absent_days: ['2026-11-21', '2026-11-18'] });
eq('two classes missed on one day are one day missed', summarise([
  { day: '2026-11-21', present: false },
  { day: '2026-11-21', present: false },
]).absent_days, ['2026-11-21']);
eq('the latest 31 days missed are listed, and every class counted', (() => {
  const marks = Array.from({ length: 40 }, (_, i) => ({ day: addDays('2026-11-23', -i), present: false }));
  const s = summarise(marks);
  return [s.classes, s.present, s.absent_days.length, s.absent_days[0], s.absent_days[30]];
})(), [40, 0, 31, '2026-11-23', '2026-10-24']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
