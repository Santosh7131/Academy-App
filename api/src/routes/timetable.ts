import { Hono } from 'hono';
import { tuitionOf, type AppEnv } from '../lib/auth.ts';
import { tq, tq1, tx } from '../lib/db.ts';
import { HttpError, notFound, uuid } from '../lib/http.ts';
import { groupRow, MAX_TIMES_PER_CLASS, ownTime, readTime, TIME_COLS, timesOf, type TimeClass } from '../lib/timetable.ts';
import { whichClass } from './attendance.ts';
import { readBody } from './body.ts';

// The timetable (lib/timetable.ts): a class's times, each on a set of weekdays at one time, with an optional link to join it
// online. Any tutor of the tuition keeps it, as with registers. Mounted behind requireUser('teacher') in index.ts; a student
// sees theirs on their Home (routes/student.ts).
export const timetableRoutes = new Hono<AppEnv>();

/** The class named in a query or a body: course_id, or class_level and subject_id of a group the tuition has. */
async function timeClass(T: string, src: Record<string, unknown>): Promise<TimeClass> {
  const w = await whichClass(T, src);
  if (w.kind === 'course') return { kind: 'course', courseId: w.courseId };
  const g = await groupRow(T, w.cls, w.subjectId);
  if (!g) throw notFound('This group');
  return { kind: 'group', groupId: g };
}

/** A class's times. */
timetableRoutes.get('/class-times', async (c) => {
  const T = tuitionOf(c).id;
  return c.json({ times: await timesOf(T, await timeClass(T, c.req.query())) });
});

/** A new time for a class: { class_level, subject_id | course_id, weekdays, starts_at, minutes, join_url?, note? }. */
timetableRoutes.post('/class-times', async (c) => {
  const T = tuitionOf(c).id;
  const me = c.get('user');
  const b = await readBody(c);
  const k = await timeClass(T, b);
  const t = readTime(b);
  const time = await tx(async (cx) => {
    // The class's own row is locked, so two times added at once never pass the cap together, and a class removed meanwhile is
    // found gone.
    const held = k.kind === 'group'
      ? await tq1(T, 'select 1 as x from groups where id = $1 and tuition_id = @T for update', [k.groupId], cx)
      : await tq1(T, 'select 1 as x from courses where id = $1 and tuition_id = @T for update', [k.courseId], cx);
    if (!held) throw notFound(k.kind === 'group' ? 'This group' : 'This course');
    if ((await timesOf(T, k, cx)).length >= MAX_TIMES_PER_CLASS) {
      throw new HttpError(409, 'too_many_times', `A class can have up to ${MAX_TIMES_PER_CLASS} times. Change one instead.`);
    }
    const [made] = await tq(
      T,
      `insert into class_times as ct (tuition_id, group_id, course_id, weekdays, starts_at, minutes, join_url, note, created_by)
       values (@T, $1, $2, $3::smallint[], $4::time, $5, $6, $7, $8)
       returning ${TIME_COLS}`,
      [k.kind === 'group' ? k.groupId : null, k.kind === 'course' ? k.courseId : null, t.weekdays, t.starts_at, t.minutes, t.join_url, t.note, me.id],
      cx,
    );
    return made;
  });
  return c.json({ time }, 201);
});

/** A time changed: every field again, as on adding it (the class stays the same). */
timetableRoutes.put('/class-times/:id', async (c) => {
  const T = tuitionOf(c).id;
  const id = uuid(c.req.param('id'), 'class time');
  const t = readTime(await readBody(c));
  await ownTime(T, id);
  const time = await tq1(
    T,
    `update class_times as ct set weekdays = $2::smallint[], starts_at = $3::time, minutes = $4, join_url = $5, note = $6, updated_at = now()
      where ct.id = $1 and ct.tuition_id = @T
      returning ${TIME_COLS}`,
    [id, t.weekdays, t.starts_at, t.minutes, t.join_url, t.note],
  );
  if (!time) throw notFound('This class time');
  return c.json({ time });
});

/** A time taken off the timetable. */
timetableRoutes.delete('/class-times/:id', async (c) => {
  const T = tuitionOf(c).id;
  const id = uuid(c.req.param('id'), 'class time');
  const gone = await tq1(T, 'delete from class_times where id = $1 and tuition_id = @T returning id', [id]);
  if (!gone) throw notFound('This class time');
  return c.json({ ok: true });
});
