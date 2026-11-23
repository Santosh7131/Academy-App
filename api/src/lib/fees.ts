// Fees (migration 039): each student's monthly fee, set from a month on, and the payments against it. A payment is for one
// month; a tutor records it (confirmed, with a receipt number), or a student says they paid by UPI and the tutor confirms it.
// Money is whole paise, as with AI credit. Pure: the routes are in routes/fees.ts.
import { istToday } from './attendance.ts';
import { bad, uuid } from './http.ts';

/** The most a monthly fee can be: ₹1,00,000. */
export const MAX_FEE_PAISE = 100_000_00;

/** The most one payment can be: ₹10,00,000. */
export const MAX_PAYMENT_PAISE = 1_000_000_00;

/** How far back a month can be looked at, owed or paid for: two years. */
export const MONTHS_BACK = 24;

/** How far ahead: next month, so a fee can be set or paid before the month starts. */
export const MONTHS_AHEAD = 1;

/** The most students one fee can be set for at once. */
export const MAX_STUDENTS = 1000;

export type Method = 'cash' | 'upi' | 'other';
export type FeeStatus = 'paid' | 'claimed' | 'unpaid' | 'none';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** This month in India, YYYY-MM. */
export function thisMonth(now: Date = new Date()): string {
  return istToday(now).slice(0, 7);
}

/** The month `n` months after `month` (YYYY-MM); `n` may be negative. */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}

/** "November 2026". */
export function monthName(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/** A month to look at, owe or pay for: YYYY-MM, from two years back to next month. None means this month. */
export function readMonth(v: unknown, now: Date = new Date()): string {
  const current = thisMonth(now);
  if (v === undefined || v === null || v === '') return current;
  if (typeof v !== 'string' || !MONTH.test(v)) throw bad('The month should be written like 2026-11.');
  if (v > addMonths(current, MONTHS_AHEAD)) throw bad('That month is too far ahead. A fee can be set or paid up to next month.');
  if (v < addMonths(current, -MONTHS_BACK)) throw bad('That month is more than two years ago.');
  return v;
}

/** An amount of money in whole paise, from `min` to `max`. */
export function readPaise(v: unknown, what: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw bad(`${what} should be a whole number of paise.`);
  if (v < min) throw bad(min === 0 ? `${what} cannot be less than nothing.` : `${what} should be more than ₹0.`);
  if (v > max) throw bad(`${what} can be up to ${rupees(max)}.`);
  return v;
}

/** The day of the month a fee is due: 1 to 28, so every month has it. */
export function readDueDay(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 28) throw bad('The fee should be due on a day from 1 to 28.');
  return v;
}

export function readMethod(v: unknown): Method {
  if (v === 'cash' || v === 'upi' || v === 'other') return v;
  throw bad('Say how it was paid: cash, UPI or other.');
}

/** The day a payment was made: YYYY-MM-DD, not after today in India and not more than two years back. None means today. */
export function readPaidOn(v: unknown, now: Date = new Date()): string {
  const today = istToday(now);
  if (v === undefined || v === null || v === '') return today;
  if (typeof v !== 'string' || !DAY.test(v)) throw bad('The day should be written like 2026-11-23.');
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw bad(`${v} is not a date.`);
  if (v > today) throw bad('A payment cannot be made on a day that has not come yet.');
  if (v < `${addMonths(today.slice(0, 7), -MONTHS_BACK)}-01`) throw bad('That day is more than two years ago.');
  return v;
}

/** A note on a payment, such as the UPI reference number: up to 60 characters, or none. */
export function readReference(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw bad('The reference should be text.');
  const s = v.trim().replace(/\s+/g, ' ');
  if (!s) return null;
  if (s.length > 60) throw bad('The reference can be up to 60 characters.');
  if (/[\u0000-\u001f\u007f]/.test(s)) throw bad('The reference has a character it cannot keep.');
  return s;
}

/**
 * A UPI id, such as priya@okaxis: up to 200 letters, digits, dots, dashes and underscores, an @, then the bank's handle.
 * Empty or null takes it away. Kept as typed but without spaces; UPI ids are not case-sensitive, so it is kept in lower case.
 */
export function readUpiId(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw bad('The UPI id should be text.');
  const s = v.trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z0-9._-]{2,200}@[a-z][a-z0-9.-]{1,63}$/.test(s)) throw bad('That is not a UPI id. It looks like name@bank, such as priya@okaxis.');
  return s;
}

/** The name the payer's UPI app shows: up to 50 characters, or none (the tuition's name is used). */
export function readUpiName(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw bad('The name should be text.');
  const s = v.trim().replace(/\s+/g, ' ');
  if (!s) return null;
  if (s.length > 50) throw bad('The name can be up to 50 characters.');
  if (/[\u0000-\u001f\u007f]/.test(s)) throw bad('The name has a character it cannot keep.');
  return s;
}

/** Students named in a body: each once, up to 1000. */
export function readStudentIds(v: unknown): string[] {
  if (!Array.isArray(v)) throw bad('Students should be a list.');
  if (v.length === 0) throw bad('Say which students.');
  if (v.length > MAX_STUDENTS) throw bad(`A fee can be set for up to ${MAX_STUDENTS} students at once.`);
  return [...new Set(v.map((x) => uuid(x, 'student id')))];
}

/** The day a month's fee is due, YYYY-MM-DD. */
export function dueOn(month: string, dueDay: number): string {
  return `${month}-${String(dueDay).padStart(2, '0')}`;
}

/**
 * Where a month stands for one student. `fee` is the fee owed that month (0 or null: none). Paid means confirmed payments
 * cover the fee; claimed means the student said they paid the rest and the tutor has not confirmed it yet. A month not paid
 * is late once its due day has passed.
 */
export function feeStatus(m: { fee: number | null; paid: number; claimed: number; dueOn: string | null; today: string }): {
  status: FeeStatus;
  left: number;
  late: boolean;
} {
  if (!m.fee) return { status: 'none', left: 0, late: false };
  const left = Math.max(m.fee - m.paid, 0);
  if (left === 0) return { status: 'paid', left: 0, late: false };
  const late = m.dueOn !== null && m.today > m.dueOn;
  return { status: m.claimed > 0 ? 'claimed' : 'unpaid', left, late };
}

/** A fee set from a month on. */
export type Rate = { from_month: string; fee_paise: number; due_day: number };

/** A payment for a month: confirmed, or claimed by the student and waiting for the tutor. */
export type Pay = { month: string; amount_paise: number; status: string };

export type MonthRow = {
  month: string; fee: number | null; due_day: number | null; due_on: string | null; paid: number; claimed: number;
  status: FeeStatus; left: number; late: boolean;
};

/** The fee in force in a month: the one set from the latest month not after it. `rates` oldest first. */
export function rateFor(rates: Rate[], month: string): Rate | null {
  let r: Rate | null = null;
  for (const x of rates) if (x.from_month <= month) r = x;
  return r;
}

/**
 * Every month a student owed a fee or paid something for, newest first: from the first month owed (not before the month they
 * joined, nor more than two years back) to this month, and a later month paid in advance. A month with no fee and nothing paid
 * is left out. `joined` is YYYY-MM; `today` YYYY-MM-DD, in India.
 */
export function monthsOf(rates: Rate[], pays: Pay[], joined: string, today: string): MonthRow[] {
  const current = today.slice(0, 7);
  const owedFrom = rates.find((r) => r.fee_paise > 0)?.from_month;
  let start = owedFrom ? (owedFrom > joined ? owedFrom : joined) : null;
  let end = current;
  for (const p of pays) {
    if (start === null || p.month < start) start = p.month;
    if (p.month > end) end = p.month;
  }
  if (start === null) return [];
  const oldest = addMonths(current, -MONTHS_BACK);
  if (start < oldest) start = oldest;
  const out: MonthRow[] = [];
  for (let m = end; m >= start; m = addMonths(m, -1)) {
    const row = monthOf(rates, pays, joined, today, m);
    if (row.fee || row.paid || row.claimed) out.push(row);
  }
  return out;
}

/** One month for a student: the fee owed (none before the month they joined), what is paid and claimed, and where it stands. */
export function monthOf(rates: Rate[], pays: Pay[], joined: string, today: string, month: string): MonthRow {
  const r = rateFor(rates, month);
  const fee = r && r.fee_paise > 0 && month >= joined ? r.fee_paise : null;
  let paid = 0;
  let claimed = 0;
  for (const p of pays) {
    if (p.month !== month) continue;
    if (p.status === 'confirmed') paid += p.amount_paise;
    else claimed += p.amount_paise;
  }
  const due = fee && r ? dueOn(month, r.due_day) : null;
  return { month, fee, due_day: fee && r ? r.due_day : null, due_on: due, paid, claimed, ...feeStatus({ fee, paid, claimed, dueOn: due, today }) };
}

/** Rupees in the Indian way: ₹1,500, ₹1,00,000, ₹1,500.50. */
export function rupees(paise: number): string {
  const r = Math.floor(paise / 100);
  const p = paise % 100;
  const s = String(r);
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `₹${grouped}${p ? `.${String(p).padStart(2, '0')}` : ''}`;
}
