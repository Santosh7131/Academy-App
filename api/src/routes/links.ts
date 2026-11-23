import { waitUntil } from '@neon/functions';
import { Hono, type Context } from 'hono';
import type pg from 'pg';
import { tuitionOf, type AppEnv, type Tuition } from '../lib/auth.ts';
import { ownCourse } from '../lib/courses.ts';
import { tq, tq1, tx } from '../lib/db.ts';
import { HttpError, notFound, uuid } from '../lib/http.ts';
import { joinPage, linkByCode, linkCodeIn, linkFor, linkUrl, newLinkFor, showLinkCode, targetLabel, type LinkInfo } from '../lib/join-links.ts';
import { groupClassSql, levelParam } from '../lib/levels.ts';
import { afterTestChange } from '../lib/notify.ts';
import { pushConfigured, pushToUsers } from '../lib/push.ts';

// Joining a group or a course with its link or QR code. Each group and course has one link (lib/join-links.ts); a student who
// opens it asks to join (POST /student/join), and a tutor lets them in or declines from Home. Students make their own logins,
// so this is how a tuition gets its students.

// ---------------------------------------------------------------- open to anyone with a link

export const joinPublicRoutes = new Hono<AppEnv>();

const publicLink = (l: LinkInfo) => ({
  code: l.code,
  code_shown: showLinkCode(l.code),
  tuition: { name: l.tuition_name },
  kind: l.course_id ? 'course' : 'group',
  label: targetLabel(l),
  joining_open: l.join_open,
});

const gone = () => new HttpError(404, 'unknown_link', 'This link has stopped working. Ask your tutor for the new one.');

/** What a link lets a student ask to join, so the app can show it before they ask, or before they have a login at all. */
joinPublicRoutes.get('/join/:code', async (c) => {
  const code = linkCodeIn(c.req.param('code'));
  const link = code ? await linkByCode(code) : undefined;
  if (!link) throw gone();
  return c.json({ link: publicLink(link) });
});

/** The page a link opens in a phone's browser, which is also where its QR code leads when scanned with the camera. */
joinPublicRoutes.get('/j/:code', async (c) => {
  const code = linkCodeIn(c.req.param('code'));
  const link = code ? await linkByCode(code) : undefined;
  c.header('cache-control', 'no-store');
  c.header('x-robots-tag', 'noindex');
  c.header('referrer-policy', 'no-referrer');
  c.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  return c.html(joinPage(link, code ?? ''), link ? 200 : 404);
});

// ---------------------------------------------------------------- a tutor's links

/** Mounted with the teacher routes, behind requireUser('teacher'). */
export const linkRoutes = new Hono<AppEnv>();

/** The group a path names (its class and subject), as a group of this tuition. */
async function groupOf(T: string, clsRaw: string, subjectRaw: string) {
  const cls = await levelParam(clsRaw, T);
  const subjectId = uuid(subjectRaw, 'subject');
  const g = await tq1<{ id: string }>(T, 'select id from groups where tuition_id = @T and class_level = $1 and subject_id = $2', [cls, subjectId]);
  if (!g) throw notFound('This group');
  return g;
}

const linkReply = (c: Context<AppEnv>, l: { code: string; created_at: Date }) => ({
  link: { code: l.code, code_shown: showLinkCode(l.code), url: linkUrl(l.code, c.req.url), created_at: l.created_at },
});

/** A group's link, made the first time it is asked for. */
linkRoutes.get('/groups/:cls/:subject/link', async (c) => {
  const T = tuitionOf(c).id;
  const g = await groupOf(T, c.req.param('cls'), c.req.param('subject'));
  return c.json(linkReply(c, await linkFor(T, { group_id: g.id }, c.get('user').id)));
});

/** A new link for the group: the old link and its QR code stop working. */
linkRoutes.post('/groups/:cls/:subject/link/new', async (c) => {
  const T = tuitionOf(c).id;
  const g = await groupOf(T, c.req.param('cls'), c.req.param('subject'));
  return c.json(linkReply(c, await newLinkFor(T, { group_id: g.id }, c.get('user').id)));
});

linkRoutes.get('/courses/:id/link', async (c) => {
  const T = tuitionOf(c).id;
  const co = await ownCourse(T, uuid(c.req.param('id'), 'course id'));
  return c.json(linkReply(c, await linkFor(T, { course_id: co.id }, c.get('user').id)));
});

linkRoutes.post('/courses/:id/link/new', async (c) => {
  const T = tuitionOf(c).id;
  const co = await ownCourse(T, uuid(c.req.param('id'), 'course id'));
  return c.json(linkReply(c, await newLinkFor(T, { course_id: co.id }, c.get('user').id)));
});

// ---------------------------------------------------------------- students asking through a link

/** SQL for "10th Maths" or the course's name, in a query that has join_requests r, groups g, subjects sj and courses co. */
export const REQUEST_LABEL = `coalesce(co.name, ${groupClassSql('g.class_level', 'r.tuition_id')} || ' ' || sj.name)`;

/** The students who asked to join a group or course through its link, oldest first, each with what they asked for. */
export const LINK_REQUESTS = `select r.id, r.student_id, u.display_name, u.username, r.asked_at,
       case when r.course_id is null then 'group' else 'course' end as kind, ${REQUEST_LABEL} as label,
       g.class_level, g.subject_id, r.course_id, m.status as place
  from join_requests r join users u on u.id = r.student_id
  left join groups g on g.id = r.group_id left join subjects sj on sj.id = g.subject_id
  left join courses co on co.id = r.course_id
  left join memberships m on m.tuition_id = r.tuition_id and m.user_id = r.student_id
 where r.tuition_id = @T
 order by r.asked_at, u.display_name`;

/**
 * Lets one student in, in the transaction given: into the group (its class, and its subject added to theirs) or the course.
 * A student who is in another class here is not moved by a group's link: the tutor changes their class on their page.
 */
async function accept(t: Tuition, id: string, cx: pg.PoolClient): Promise<{ student_id: string; name: string } | null> {
  const r = await tq1<{ student_id: string; display_name: string; group_id: string | null; course_id: string | null; class_level: number | null; subject_id: string | null; label: string }>(
    t.id,
    `select r.student_id, u.display_name, r.group_id, r.course_id, g.class_level, g.subject_id, ${REQUEST_LABEL} as label
       from join_requests r join users u on u.id = r.student_id
       left join groups g on g.id = r.group_id left join subjects sj on sj.id = g.subject_id
       left join courses co on co.id = r.course_id
      where r.id = $1 and r.tuition_id = @T
      for update of r`,
    [id],
    cx,
  );
  if (!r) return null;
  const m = await tq1<{ status: string; class_level: number | null }>(
    t.id,
    `select status, class_level from memberships where tuition_id = @T and user_id = $1 and role = 'student' for update`,
    [r.student_id],
    cx,
  );
  if (m?.status === 'off') {
    throw new HttpError(409, 'turned_off', `${r.display_name}'s place here is turned off. Turn it on from their page first.`);
  }
  if (r.group_id) {
    if (m?.status === 'active' && m.class_level != null && m.class_level !== r.class_level) {
      throw new HttpError(409, 'other_class', `${r.display_name} is in another class here. Change their class on their page, then let them into ${r.label}.`);
    }
    await tq(
      t.id,
      `insert into memberships (tuition_id, user_id, role, status, class_level) values (@T, $1, 'student', 'active', $2)
       on conflict (tuition_id, user_id) do update set status = 'active', class_level = excluded.class_level`,
      [r.student_id, r.class_level],
      cx,
    );
    await tq(t.id, 'insert into student_subjects (tuition_id, student_id, subject_id) values (@T, $1, $2) on conflict do nothing', [r.student_id, r.subject_id], cx);
  } else {
    await tq(
      t.id,
      `insert into memberships (tuition_id, user_id, role, status) values (@T, $1, 'student', 'active')
       on conflict (tuition_id, user_id) do update set status = 'active'`,
      [r.student_id],
      cx,
    );
    await cx.query('insert into course_members (course_id, student_id) values ($1, $2) on conflict do nothing', [r.course_id, r.student_id]);
  }
  await cx.query('delete from join_requests where id = $1', [id]);
  return { student_id: r.student_id, name: r.display_name };
}

/** Tells the students they are in, and puts them in the tests that are open now. */
async function afterAccept(t: Tuition, ids: string[]) {
  if (!ids.length) return;
  if (pushConfigured()) await pushToUsers(ids, { title: t.name, body: 'You have been let in. Open the app to see your tests.' }).catch(() => 0);
  waitUntil(afterTestChange());
}

linkRoutes.post('/link-requests/:id/accept', async (c) => {
  const t = tuitionOf(c);
  const id = uuid(c.req.param('id'), 'request id');
  const done = await tx((cx) => accept(t, id, cx));
  if (!done) throw notFound('This request');
  await afterAccept(t, [done.student_id]);
  return c.json({ ok: true });
});

/** Declines a request. A student who was waiting only for this, and is not in the tuition, is no longer waiting at all. */
linkRoutes.post('/link-requests/:id/decline', async (c) => {
  const t = tuitionOf(c);
  const id = uuid(c.req.param('id'), 'request id');
  const done = await tx(async (cx) => {
    const r = await tq1<{ student_id: string }>(t.id, 'delete from join_requests where id = $1 and tuition_id = @T returning student_id', [id], cx);
    if (!r) return false;
    await tq(
      t.id,
      `delete from memberships m where m.tuition_id = @T and m.user_id = $1 and m.role = 'student' and m.status = 'pending'
          and not exists (select 1 from join_requests x where x.tuition_id = @T and x.student_id = $1)`,
      [r.student_id],
      cx,
    );
    return true;
  });
  if (!done) throw notFound('This request');
  return c.json({ ok: true });
});

/** Lets in everyone who asked through a link, oldest first. Anyone who cannot be let in this way is left waiting, and said why. */
linkRoutes.post('/link-requests/accept-all', async (c) => {
  const t = tuitionOf(c);
  const waiting = await tq<{ id: string; display_name: string }>(
    t.id,
    `select r.id, u.display_name from join_requests r join users u on u.id = r.student_id where r.tuition_id = @T order by r.asked_at limit 300`,
  );
  const let_in: string[] = [];
  const left: { id: string; name: string; reason: string }[] = [];
  for (const w of waiting) {
    try {
      const done = await tx((cx) => accept(t, w.id, cx));
      if (done) let_in.push(done.student_id);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      left.push({ id: w.id, name: w.display_name, reason: e.message });
    }
  }
  await afterAccept(t, [...new Set(let_in)]);
  return c.json({ accepted: let_in.length, left });
});
