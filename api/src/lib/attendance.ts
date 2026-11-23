// Attendance (migration 038): one register per class per day, a class being a group (a class and a subject) or a course.
// A register keeps one mark per student, the ones who came as well as the ones who did not, so it still says who was there
// after a student changes class or leaves. Pure: the routes are in routes/attendance.ts.
import { bad, uuid } from './http.ts';

/** How far back a register can be taken or changed: last month's, to fix a mistake, but not last year's. */
export const DAYS_BACK = 366;

/** The most students one register takes. */
export const MAX_STUDENTS = 1000;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date in India (UTC+5:30 all year) as YYYY-MM-DD: a class at 11 pm is still that day's class. */
export function istToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/** The day `n` days after `day`; `n` may be negative. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The first moment of `day` in India, for comparing with times kept in UTC. */
export function istStart(day: string): Date {
  return new Date(`${day}T00:00:00+05:30`);
}

/** A register's day: a real date, not after today in India and not more than a year before it. None means today. */
export function readDay(v: unknown, today: string): string {
  if (v === undefined || v === null || v === '') return today;
  if (typeof v !== 'string' || !DAY.test(v)) throw bad('The day should be written like 2026-11-23.');
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw bad(`${v} is not a date.`);
  if (v > today) throw bad('Attendance cannot be taken for a day that has not come yet.');
  if (v < addDays(today, -DAYS_BACK)) throw bad('That day is more than a year ago.');
  return v;
}

/** A month of registers to list, written YYYY-MM, not after this month; none means this month. With its first day, and the next month's. */
export function readMonth(v: unknown, today: string): { month: string; from: string; to: string } {
  const month = v === undefined || v === null || v === '' ? today.slice(0, 7) : v;
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw bad('The month should be written like 2026-11.');
  if (month > today.slice(0, 7)) throw bad('That month has not come yet.');
  const [y, m] = month.split('-').map(Number);
  return { month, from: `${month}-01`, to: m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01` };
}

/** The students marked absent, each once. Everyone else in the class is marked present. */
export function readAbsent(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw bad('Absent should be a list of students.');
  if (v.length > MAX_STUDENTS) throw bad(`A register takes up to ${MAX_STUDENTS} students.`);
  return [...new Set(v.map((x) => uuid(x, 'student id')))];
}

/** One student's marks, newest first, summed up: how many classes, how many they came to, and the days they missed (the latest 31). */
export function summarise(marks: { day: string; present: boolean }[]): { classes: number; present: number; absent_days: string[] } {
  const away = marks.filter((m) => !m.present).map((m) => m.day);
  return { classes: marks.length, present: marks.length - away.length, absent_days: [...new Set(away)].slice(0, 31) };
}
