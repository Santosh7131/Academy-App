import { Hono } from 'hono';
import { tuitionOf, type AppEnv } from '../lib/auth.ts';
import { pool, tq1, tx, type Db } from '../lib/db.ts';
import { bad, HttpError, notFound, uuid } from '../lib/http.ts';
import { levelParam } from '../lib/levels.ts';
import { addBook, bookFor, readyOffer } from '../lib/ready-made.ts';
import { readBody } from './body.ts';

// Ready-made questions (lib/ready-made.ts), offered in the question picker of a group whose class and subject have a book. Any
// tutor of the tuition can add them, on every plan, and they use no AI credit. Mounted behind requireUser('teacher') in index.ts.
// Kept apart from /teacher/library, which is the shelf of class files.
export const readyMadeRoutes = new Hono<AppEnv>();

/** A group the tuition has, from its class and subject, with the subject's name. With [lock], its row is locked until the end. */
async function groupOf(T: string, rawClass: unknown, rawSubject: unknown, lock?: Db): Promise<{ cls: number; subjectId: string; subject: string }> {
  if (rawClass === undefined || rawClass === null || rawSubject === undefined || rawSubject === null) throw bad('Say which class and subject.');
  const cls = await levelParam(rawClass, T);
  const subjectId = uuid(rawSubject, 'subject');
  const g = await tq1<{ subject: string }>(
    T,
    `select sj.name as subject from groups g join subjects sj on sj.id = g.subject_id
      where g.tuition_id = @T and g.class_level = $1 and g.subject_id = $2${lock ? ' for update of g' : ''}`,
    [cls, subjectId],
    lock ?? pool,
  );
  if (!g) throw notFound('This group');
  return { cls, subjectId, subject: g.subject };
}

/** What ready-made questions there are for a group (?class=&subject=), and how many the tuition has added: { ready: null } when none. */
readyMadeRoutes.get('/ready-made', async (c) => {
  const T = tuitionOf(c).id;
  const g = await groupOf(T, c.req.query('class'), c.req.query('subject'));
  return c.json({ ready: await readyOffer(T, g.cls, g.subject) });
});

/** Adds the book for a group { class_level, subject_id } to the tuition's questions: { added, ready }. Adding again adds only what is missing. */
readyMadeRoutes.post('/ready-made', async (c) => {
  const T = tuitionOf(c).id;
  const me = c.get('user');
  const b = await readBody(c);
  const out = await tx(async (cx) => {
    // The group's row is locked, so the same book added twice at once is added once, and a group deleted meanwhile is found gone.
    const g = await groupOf(T, b.class_level, b.subject_id, cx);
    const book = bookFor(g.cls, g.subject);
    if (!book) throw new HttpError(404, 'no_ready_made', 'There are no ready-made questions for this class and subject yet.');
    const added = await addBook(T, book, g.subjectId, me.id, cx);
    return { added, ready: await readyOffer(T, g.cls, g.subject, cx) };
  });
  return c.json(out);
});
