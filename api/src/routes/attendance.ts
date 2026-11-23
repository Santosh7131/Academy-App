import { Hono } from 'hono';
import { istStart, istToday, readAbsent, readDay, readMonth, summarise } from '../lib/attendance.ts';
import { tuitionOf, type AppEnv } from '../lib/auth.ts';
import { ownCourse } from '../lib/courses.ts';
import { pool, tq, tq1, tx, type Db } from '../lib/db.ts';
import { bad, notFound, uuid } from '../lib/http.ts';
import { levelParam } from '../lib/levels.ts';
import { readBody } from './body.ts';

// Attendance (lib/attendance.ts): a tutor takes a class's register for a day, everyone marked present but the ones tapped
// as absent. Two tutors taking the same class's register for the same day update one register. Mounted behind
// requireUser('teacher') in index.ts; a student reads their own with attendanceOf, on their Home.
export const attendanceRoutes = new Hono<AppEnv>();

/** Which class a register is for: a group (a class and a subject) or a course. */
export type Which = { kind: 'group'; cls: number; subjectId: string } | { kind: 'course'; courseId: string };

/** The class named in a query or a body: course_id, or class_level and subject_id. It must be this tuition's. */
export async function whichClass(T: string, src: Record<string, unknown>): Promise<Which> {
  if (src.course_id !== undefined && src.course_id !== null && src.course_id !== '') {
    const course = await ownCourse(T, uuid(src.course_id, 'course id'));
    return { kind: 'course', courseId: course.id };
  }
  if (src.class_level === undefined || src.subject_id === undefined) throw bad('Say which class: a course, or a class and a subject.');
  const cls = await levelParam(src.class_level, T);
  const subjectId = uuid(src.subject_id, 'subject');
  const taught = await tq1(T, 'select 1 as x from tuition_subjects where tuition_id = @T and subject_id = $1', [subjectId]);
  if (!taught) throw notFound('This subject');
  return { kind: 'group', cls, subjectId };
}

/** SQL that picks the class's registers out of `attendance_days d`, with its parameters numbered from $n. */
function classMatch(w: Which, n: number): [string, unknown[]] {
  return w.kind === 'course'
    ? [`d.course_id = $${n}`, [w.courseId]]
    : [`d.course_id is null and d.class_level = $${n} and d.subject_id = $${n + 1}`, [w.cls, w.subjectId]];
}

type Student = { id: string; display_name: string; username: string };

/** The class's students now: a group's are those of its class who take its subject, a course's its people. Turned-off students are left out. */
export async function classStudents(T: string, w: Which, db: Db = pool): Promise<Student[]> {
  return w.kind === 'course'
    ? tq<Student>(
        T,
        `select u.id, u.display_name, u.username from course_members cm join users u on u.id = cm.student_id
           join memberships m on m.tuition_id = @T and m.user_id = u.id and m.role = 'student' and m.status = 'active'
          where cm.course_id = $1 order by u.display_name, u.id`,
        [w.courseId],
        db,
      )
    : tq<Student>(
        T,
        `select u.id, u.display_name, u.username from memberships m join users u on u.id = m.user_id
          where m.tuition_id = @T and m.role = 'student' and m.status = 'active' and m.class_level = $1
            and exists (select 1 from student_subjects ss where ss.tuition_id = @T and ss.student_id = u.id and ss.subject_id = $2)
          order by u.display_name, u.id`,
        [w.cls, w.subjectId],
        db,
      );
}

type Register = { id: string; taken_at: string; taken_by: string | null };

/** The class's register for a day, if it has been taken. */
async function registerOf(T: string, w: Which, day: string): Promise<Register | undefined> {
  const [match, params] = classMatch(w, 2);
  return tq1<Register>(
    T,
    `select d.id, d.taken_at, u.display_name as taken_by from attendance_days d left join users u on u.id = d.taken_by
      where d.tuition_id = @T and d.day = $1 and ${match}`,
    [day, ...params],
  );
}

/** How a class's register stands today, for its page: not taken, or how many came and how many did not. */
export async function attendanceToday(T: string, w: Which): Promise<{ taken: boolean; present: number; absent: number }> {
  const [match, params] = classMatch(w, 2);
  const r = await tq1<{ present: number; absent: number }>(
    T,
    `select count(*) filter (where m.present)::int as present, count(*) filter (where not m.present)::int as absent
       from attendance_days d join attendance_marks m on m.day_id = d.id
      where d.tuition_id = @T and d.day = $1 and ${match}
      group by d.id`,
    [istToday(), ...params],
  );
  return r ? { taken: true, present: r.present, absent: r.absent } : { taken: false, present: 0, absent: 0 };
}

/**
 * One student's attendance in this tuition, for their page, a report for parents and their own Home. `courseId`: a course's
 * registers only, or (null) the groups' only, or (left out) all of them. `from` and `to` are moments, `to` not included.
 */
export async function attendanceOf(
  T: string,
  studentId: string,
  o: { courseId?: string | null; from?: Date | null; to?: Date | null } = {},
): Promise<{ classes: number; present: number; absent_days: string[] }> {
  const marks = await tq<{ day: string; present: boolean }>(
    T,
    `select d.day::text as day, m.present from attendance_marks m join attendance_days d on d.id = m.day_id and d.tuition_id = @T
      where m.student_id = $1
        and (not $2::boolean or d.course_id is not distinct from $3::uuid)
        and ($4::timestamptz is null or d.day >= ($4::timestamptz at time zone 'Asia/Kolkata')::date)
        and ($5::timestamptz is null or d.day < ($5::timestamptz at time zone 'Asia/Kolkata')::date)
      order by d.day desc`,
    [studentId, o.courseId !== undefined, o.courseId ?? null, o.from ?? null, o.to ?? null],
  );
  return summarise(marks);
}

/** This month's attendance for a student's own Home, in India's calendar. */
export function attendanceThisMonth(T: string, studentId: string) {
  return attendanceOf(T, studentId, { from: istStart(`${istToday().slice(0, 7)}-01`) });
}

/**
 * A class's register for a day (today when none is named): everyone in the class now, with their mark when it has been
 * taken (null when not), and anyone marked that day who has left the class since, so an old register reads as it was.
 */
attendanceRoutes.get('/attendance', async (c) => {
  const T = tuitionOf(c).id;
  const today = istToday();
  const w = await whichClass(T, c.req.query());
  const day = readDay(c.req.query('day'), today);
  const reg = await registerOf(T, w, day);
  const students = await classStudents(T, w);
  const marks = reg
    ? await tq<Student & { present: boolean }>(
        T,
        `select u.id, u.display_name, u.username, m.present
           from attendance_marks m join attendance_days d on d.id = m.day_id and d.tuition_id = @T join users u on u.id = m.student_id
          where m.day_id = $1 order by u.display_name, u.id`,
        [reg.id],
      )
    : [];
  const markOf = new Map(marks.map((m) => [m.id, m.present]));
  const now = new Set(students.map((s) => s.id));
  return c.json({
    day,
    today,
    register: reg ? { taken_at: reg.taken_at, taken_by: reg.taken_by } : null,
    students: [
      ...students.map((s) => ({ ...s, present: markOf.get(s.id) ?? null, in_class: true })),
      ...marks.filter((m) => !now.has(m.id)).map((m) => ({ id: m.id, display_name: m.display_name, username: m.username, present: m.present, in_class: false })),
    ],
  });
});

/**
 * Takes (or changes) a class's register for a day: the students in `absent` did not come, everyone else in the class did.
 * A student marked that day who has left the class since keeps their mark. Says who was absent, for telling their parents.
 */
attendanceRoutes.put('/attendance', async (c) => {
  const T = tuitionOf(c).id;
  const b = await readBody(c);
  const w = await whichClass(T, b);
  const day = readDay(b.day, istToday());
  const absent = readAbsent(b.absent);
  const students = await tx(async (cx) => {
    const now = await classStudents(T, w, cx);
    if (!now.length) throw bad('There is nobody in this class to take attendance for.');
    const ids = new Set(now.map((s) => s.id));
    if (absent.some((a) => !ids.has(a))) throw bad('One of the students marked absent is not in this class.');
    const reg =
      w.kind === 'course'
        ? await tq1<{ id: string }>(
            T,
            `insert into attendance_days (tuition_id, course_id, day, taken_by) values (@T, $1, $2, $3)
             on conflict (course_id, day) where course_id is not null do update set taken_by = excluded.taken_by, taken_at = now()
             returning id`,
            [w.courseId, day, c.get('user').id],
            cx,
          )
        : await tq1<{ id: string }>(
            T,
            `insert into attendance_days (tuition_id, class_level, subject_id, day, taken_by) values (@T, $1, $2, $3, $4)
             on conflict (tuition_id, class_level, subject_id, day) where course_id is null
             do update set taken_by = excluded.taken_by, taken_at = now()
             returning id`,
            [w.cls, w.subjectId, day, c.get('user').id],
            cx,
          );
    await cx.query(
      `insert into attendance_marks (day_id, student_id, present)
       select $1, s, not (s = any($3::uuid[])) from unnest($2::uuid[]) as s
       on conflict (day_id, student_id) do update set present = excluded.present`,
      [reg!.id, [...ids], absent],
    );
    return now;
  });
  const away = students.filter((s) => absent.includes(s.id));
  return c.json({ day, present: students.length - away.length, absent: away.map((s) => ({ id: s.id, display_name: s.display_name })) });
});

/** Takes away a register taken by mistake, with its marks. */
attendanceRoutes.delete('/attendance', async (c) => {
  const T = tuitionOf(c).id;
  const w = await whichClass(T, c.req.query());
  const day = readDay(c.req.query('day'), istToday());
  const [match, params] = classMatch(w, 2);
  const gone = await tq(T, `delete from attendance_days d where d.tuition_id = @T and d.day = $1 and ${match} returning d.id`, [day, ...params]);
  if (!gone.length) throw notFound("That day's register");
  return c.json({ ok: true });
});

/** A month of a class's registers, newest first: each day with how many came and how many did not. */
attendanceRoutes.get('/attendance/month', async (c) => {
  const T = tuitionOf(c).id;
  const today = istToday();
  const w = await whichClass(T, c.req.query());
  const { month, from, to } = readMonth(c.req.query('month'), today);
  const [match, params] = classMatch(w, 3);
  const days = await tq(
    T,
    `select d.day::text as day, count(*) filter (where m.present)::int as present, count(*) filter (where not m.present)::int as absent
       from attendance_days d left join attendance_marks m on m.day_id = d.id
      where d.tuition_id = @T and d.day >= $1::date and d.day < $2::date and ${match}
      group by d.day order by d.day desc`,
    [from, to, ...params],
  );
  return c.json({ month, today, days });
});
