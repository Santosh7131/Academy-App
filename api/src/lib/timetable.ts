import { addDays, istToday } from './attendance.ts';
import { pool, tq, tq1, type Db } from './db.ts';
import { bad, int, notFound, str } from './http.ts';

// The timetable (migration 041): each class's times, each on a set of weekdays at one time of day in India, with an optional link
// to join the class online (the tutor's own Google Meet, Zoom, Jitsi or other). A class is a group or a course, as for registers.
// The app has no video of its own: Join opens the tutor's chosen service outside the app.

/** How many times one class can have: a class meeting at a different time each day of the week needs seven. */
export const MAX_TIMES_PER_CLASS = 10;

export type ClassTime = { id: string; weekdays: number[]; starts_at: string; minutes: number; join_url: string | null; note: string | null };

/** The class a time belongs to: a group, by its row, or a course. */
export type TimeClass = { kind: 'group'; groupId: string } | { kind: 'course'; courseId: string };

/** A time as the API sends it, its start as "16:30" in India. `ct` is class_times. */
export const TIME_COLS = `ct.id, ct.weekdays::int[] as weekdays, to_char(ct.starts_at, 'HH24:MI') as starts_at, ct.minutes::int as minutes,
  ct.join_url, ct.note`;

/**
 * The link to join a class online, as the tutor pasted it. Students tap it, and most are children, so anything but a plain https
 * link with a website and no login in it is refused, not cleaned up. None or blank is no link.
 */
export function joinUrl(v: unknown): string | null {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return null;
  if (typeof v !== 'string') throw bad('The link must be text.');
  const s = v.trim();
  if (s.length > 500) throw bad('The link is too long (max 500 characters).');
  if (/\s/.test(s) || /[\u0000-\u001f\u007f]/.test(s)) throw bad('The link has a space or a character that cannot be used.');
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw bad('That is not a link. Copy the link of your Google Meet, Zoom or Jitsi class: it starts with https://.');
  }
  if (u.protocol !== 'https:') throw bad('The link must start with https://.');
  if (u.username || u.password) throw bad('The link must not have a login in it.');
  if (!u.hostname.includes('.') || u.hostname.startsWith('.') || u.hostname.endsWith('.')) {
    throw bad('The link needs a website in it, such as meet.google.com.');
  }
  if (u.href.length > 500) throw bad('The link is too long (max 500 characters).');
  return u.href;
}

/** The weekdays of a time: 1 (Monday) to 7 (Sunday), at least one, each once, in order. */
export function weekdays(v: unknown): number[] {
  if (!Array.isArray(v) || v.length === 0) throw bad('Choose at least one day.');
  if (!v.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) throw bad('The days are 1 (Monday) to 7 (Sunday).');
  return [...new Set(v as number[])].sort((a, b) => a - b);
}

/** When a class starts, as "16:30" (India's time). */
export function startsAt(v: unknown): string {
  if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.trim())) throw bad('The start time must be like 16:30.');
  return v.trim();
}

/** A time's fields from a request body. */
export function readTime(b: Record<string, unknown>): Omit<ClassTime, 'id'> {
  return {
    weekdays: weekdays(b.weekdays),
    starts_at: startsAt(b.starts_at),
    minutes: int(b, 'minutes', { min: 10, max: 360 })!,
    join_url: joinUrl(b.join_url),
    note: str(b, 'note', { max: 80, optional: true }) ?? null,
  };
}

/** SQL that picks a class's times out of `class_times ct`, its parameter numbered $n. */
export function timeMatch(k: TimeClass, n: number): [string, unknown[]] {
  return k.kind === 'group' ? [`ct.group_id = $${n}`, [k.groupId]] : [`ct.course_id = $${n}`, [k.courseId]];
}

/** A class's times, in the order of their first day and then their start. */
export async function timesOf(T: string, k: TimeClass, db: Db = pool): Promise<ClassTime[]> {
  const [match, params] = timeMatch(k, 1);
  return tq<ClassTime>(T, `select ${TIME_COLS} from class_times ct where ct.tuition_id = @T and ${match} order by ct.weekdays[1], ct.starts_at, ct.id`, params, db);
}

/** A group's row, found by its class and subject as its page names it; undefined when the tuition has no such group. */
export async function groupRow(T: string, cls: number, subjectId: string, db: Db = pool): Promise<string | undefined> {
  return (await tq1<{ id: string }>(T, 'select id from groups where tuition_id = @T and class_level = $1 and subject_id = $2', [cls, subjectId], db))?.id;
}

/** The group's or course's times for its page: none for a class and subject the tuition has no group for. */
export async function pageTimes(T: string, w: { kind: 'group'; cls: number; subjectId: string } | { kind: 'course'; courseId: string }): Promise<ClassTime[]> {
  if (w.kind === 'course') return timesOf(T, { kind: 'course', courseId: w.courseId });
  const g = await groupRow(T, w.cls, w.subjectId);
  return g ? timesOf(T, { kind: 'group', groupId: g }) : [];
}

export type StudentTime = ClassTime & { kind: 'group' | 'course'; name: string };

/**
 * Every time of the classes a student is in at this tuition: the groups of their class whose subject they take, and their courses.
 * A student whose place is turned off has none. `name` is the subject for a group and the course's name for a course.
 */
export async function studentTimes(T: string, studentId: string, db: Db = pool): Promise<StudentTime[]> {
  return tq<StudentTime>(
    T,
    `select ${TIME_COLS}, 'group' as kind, sj.name
       from class_times ct join groups g on g.id = ct.group_id join subjects sj on sj.id = g.subject_id
       join memberships m on m.tuition_id = @T and m.user_id = $1 and m.role = 'student' and m.status = 'active' and m.class_level = g.class_level
      where ct.tuition_id = @T
        and exists (select 1 from student_subjects ss where ss.tuition_id = @T and ss.student_id = $1 and ss.subject_id = g.subject_id)
     union all
     select ${TIME_COLS}, 'course' as kind, co.name
       from class_times ct join courses co on co.id = ct.course_id
       join course_members cm on cm.course_id = co.id and cm.student_id = $1
       join memberships m on m.tuition_id = @T and m.user_id = $1 and m.role = 'student' and m.status = 'active'
      where ct.tuition_id = @T
      order by starts_at, name, id`,
    [studentId],
    db,
  );
}

/** India's weekday, 1 (Monday) to 7 (Sunday), for a moment. */
export function istWeekday(now: Date = new Date()): number {
  const day = new Date(now.getTime() + 330 * 60_000).getUTCDay();
  return day === 0 ? 7 : day;
}

/**
 * Today's classes, by India's calendar on the server's clock (never the phone's), and the first class on a later day, within the
 * week, with that day as "2026-11-26": a student's Home shows today's, or the next one when there are none today.
 */
export function todayAndNext<C extends ClassTime>(times: C[], now: Date = new Date()): { today: C[]; next: (C & { day: string }) | null } {
  const wd = istWeekday(now);
  const byStart = (a: C, b: C) => a.starts_at.localeCompare(b.starts_at);
  const today = times.filter((t) => t.weekdays.includes(wd)).sort(byStart);
  for (let d = 1; d <= 7; d++) {
    const day = ((wd - 1 + d) % 7) + 1;
    const first = times.filter((t) => t.weekdays.includes(day)).sort(byStart)[0];
    if (first) return { today, next: { ...first, day: addDays(istToday(now), d) } };
  }
  return { today, next: null };
}

/** What a student's Home shows of the timetable. */
export async function classesForStudent(T: string, studentId: string) {
  return todayAndNext(await studentTimes(T, studentId));
}

/** A time of this tuition by its id, with the class it belongs to, or 404. */
export async function ownTime(T: string, id: string, db: Db = pool): Promise<{ id: string; group_id: string | null; course_id: string | null }> {
  const t = await tq1<{ id: string; group_id: string | null; course_id: string | null }>(
    T,
    'select id, group_id, course_id from class_times where id = $1 and tuition_id = @T',
    [id],
    db,
  );
  if (!t) throw notFound('This class time');
  return t;
}
