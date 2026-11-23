import { waitUntil } from '@neon/functions';
import { Hono } from 'hono';
import { clearTries, LOCK_MINUTES, lockedError, takeTry, tuitionOf, verifySecret, type AppEnv } from '../lib/auth.ts';
import { pool, q, q1, tq, tq1, tx } from '../lib/db.ts';
import { bad, bool, HttpError, notFound, str, uuid } from '../lib/http.ts';
import { addLevel, cleanLabel, CUSTOM_MAX, CUSTOM_MIN, levelInUse, levelIn, levelsOf } from '../lib/levels.ts';
import { afterTestChange } from '../lib/notify.ts';
import { pushConfigured, pushToUsers } from '../lib/push.ts';
import { abortMultipart, deleteObjects, listObjects } from '../lib/storage.ts';
import { subjectIds } from '../lib/subjects.ts';
import { ensureGroup, freeJoinCode, showCode, taughtSubjectIds } from '../lib/tuition.ts';
import { readBody } from './body.ts';
import { LINK_REQUESTS } from './links.ts';
import { effectivePlan, roomFor } from '../lib/plans.ts';

// A tutor's own tuition: its name, the code students join with, and the students asking to join.
// Mounted with the teacher routes, behind requireUser('teacher').
export const tuitionRoutes = new Hono<AppEnv>();

const TUITION = `select t.id, t.name, t.join_code, t.join_open, ${effectivePlan('t')} as plan, t.plan_until::text as plan_until, t.created_at,
       (select count(*) from memberships m where m.tuition_id = t.id and m.role = 'student' and m.status = 'active') as students,
       (select count(*) from memberships m where m.tuition_id = t.id and m.role in ('owner', 'tutor') and m.status = 'active') as tutors,
       (select count(*) from groups g where g.tuition_id = t.id) as groups,
       (select count(*) from memberships m where m.tuition_id = t.id and m.role = 'student' and m.status = 'pending') as pending
  from tuitions t where t.id = @T`;

async function tuitionPayload(id: string, role: string) {
  const t = await tq1(id, TUITION);
  return { ...t, join_code_shown: showCode(t.join_code), role };
}

tuitionRoutes.get('/tuition', async (c) => {
  const t = tuitionOf(c);
  return c.json({ tuition: await tuitionPayload(t.id, t.role) });
});

/** Renames the tuition, or opens and closes joining. */
tuitionRoutes.patch('/tuition', async (c) => {
  const t = tuitionOf(c);
  const b = await readBody(c);
  const name = str(b, 'name', { max: 60, optional: true });
  const open = 'join_open' in b ? bool(b, 'join_open') : null;
  await tq(
    t.id,
    `update tuitions set name = coalesce($1, name), join_open = coalesce($2, join_open) where id = @T`,
    [name ?? null, open],
  );
  return c.json({ tuition: await tuitionPayload(t.id, t.role) });
});

/**
 * Deletes the tuition for good, with the owner's password: its tests and the students' results, papers, questions, groups, courses
 * and Library files, and the accounts of its tutors who are in no other tuition, the owner's too. Students keep their accounts (they
 * made them, and can join another tuition or delete them themselves), and so does any tutor with a place in another tuition (or a
 * request waiting there), or who had only asked to join. The money that came in stays on record: credit lines
 * that added credit keep the tuition's name (migration 034); every other line goes with it. Storage is emptied once the rows are gone.
 */
tuitionRoutes.post('/tuition/delete', async (c) => {
  const t = tuitionOf(c);
  if (t.role !== 'owner') throw new HttpError(403, 'not_owner', 'Only the owner can delete the tuition.');
  const me = c.get('user');
  const b = await readBody(c);
  const secret = str(b, 'secret', { max: 200 })!;
  const u = await q1<{ secret_hash: string; secret_salt: string }>('select secret_hash, secret_salt from users where id = $1', [me.id]);
  if (!u) throw notFound('Your account');
  // Checked as a login checks it: every wrong try counts toward the lockout. A wrong password is 403, not 401, so the app does not
  // take it for a session that ended.
  const tried = await takeTry(me.id);
  if (tried.locked) throw lockedError(tried.minutes);
  if (!(await verifySecret(secret, u.secret_hash, u.secret_salt))) {
    if (tried.lastTry) throw lockedError(LOCK_MINUTES);
    throw new HttpError(403, 'wrong_password', 'That password is not right.');
  }
  await clearTries(me.id);

  const T = t.id;
  // What storage holds for the tuition, found while its rows still say so. Question pictures and Library files sit under the
  // tuition's own prefixes and are listed after; a paper's pages are kept under the paper's id.
  const pages = await q<{ k: string }>('select pp.object_key as k from paper_pages pp join papers p on p.id = pp.paper_id where p.tuition_id = $1', [T]);
  const uploads = await q<{ object_key: string; upload_id: string }>(
    'select object_key, upload_id from class_files where tuition_id = $1 and upload_id is not null',
    [T],
  );
  const gone = await tx(async (cx) => {
    const row = await q1<{ name: string }>('select name from tuitions where id = $1 for update', [T], cx);
    if (!row) throw notFound('The tuition');
    // A plan payment still waiting would go with the tuition, leaving the developer with money in their UPI app and nothing to match
    // it to. Checked under the tuition's lock, so none can be sent in between. Once it is received (it then stays on record under
    // the tuition's name) or declined, the tuition can go.
    const planWaiting = await q1('select 1 from plan_requests where tuition_id = $1 and status = $2 limit 1', [T, 'waiting'], cx);
    if (planWaiting) {
      throw new HttpError(409, 'plan_payment_waiting', 'A payment for a plan is still waiting to be checked. The tuition can be deleted once it has been checked.');
    }
    // Who was really in it, taken before the memberships go: only these people can lose their accounts. Someone whose only link
    // to the tuition is a request still waiting was never let in, so its owner has no say over their account.
    const members = (await q<{ user_id: string }>(
      `select user_id from memberships where tuition_id = $1 and status <> 'pending'`,
      [T],
      cx,
    )).map((m) => m.user_id);
    await cx.query(`update credit_ledger set client_name = $2 where tuition_id = $1 and kind in ('topup', 'by_hand')`, [T, row.name]);
    await cx.query(`delete from credit_ledger where tuition_id = $1 and kind not in ('topup', 'by_hand')`, [T]);
    // The tests first: a test holds on to its questions, which would stop the rest.
    const tests = await cx.query('delete from tests where tuition_id = $1', [T]);
    await cx.query('delete from tuitions where id = $1', [T]);
    // Tutors only (never a student, whose account is their own, or a developer), and never one who still has a place (or a
    // request waiting) in another tuition.
    const users = await q<{ id: string }>(
      `delete from users u where u.id = any($1::uuid[]) and u.role = 'teacher'
          and not exists (select 1 from memberships m where m.user_id = u.id)
        returning u.id`,
      [members],
      cx,
    );
    return { tests: tests.rowCount ?? 0, accounts: users.map((x) => x.id) };
  });

  const keys = new Set(pages.map((p) => p.k));
  for (const prefix of [`questions/${T}/`, `library/${T}/`]) {
    for (const o of await listObjects(prefix).catch(() => [])) keys.add(o.key);
  }
  for (const f of uploads) await abortMultipart(f.object_key, f.upload_id).catch(() => {});
  await deleteObjects([...keys]).catch(() => {});
  return c.json({ ok: true, account_deleted: gone.accounts.includes(me.id), accounts_deleted: gone.accounts.length, tests_deleted: gone.tests });
});

/** A new join code: the old one stops working. Only the owner. */
tuitionRoutes.post('/tuition/join-code', async (c) => {
  const t = tuitionOf(c);
  if (t.role !== 'owner') throw new HttpError(403, 'owner_only', 'Only the owner of the tuition can change its join code.');
  await pool.query('update tuitions set join_code = $2 where id = $1', [t.id, await freeJoinCode()]);
  return c.json({ tuition: await tuitionPayload(t.id, t.role) });
});

// ---------------------------------------------------------------- students asking to join

/**
 * Who is waiting to be let in. `requests` asked with the tuition's code, so the tutor chooses their class (below); `link_requests`
 * asked with a group's or course's link, so each says what for, and is let in or declined in routes/links.ts. A student who asked
 * both ways shows only with their links.
 */
tuitionRoutes.get('/join-requests', async (c) => {
  const T = tuitionOf(c).id;
  const rows = await tq(
    T,
    `select u.id, u.display_name, u.username, m.class_level, m.joined_at as asked_at
       from memberships m join users u on u.id = m.user_id
      where m.tuition_id = @T and m.role = 'student' and m.status = 'pending'
        and not exists (select 1 from join_requests r where r.tuition_id = @T and r.student_id = m.user_id)
      order by m.joined_at`,
  );
  return c.json({ requests: rows, link_requests: await tq(T, LINK_REQUESTS) });
});

/** Lets a student in, in the class and with the subjects the tutor chooses (their asked class, and none, if not sent). */
tuitionRoutes.post('/join-requests/:id/accept', async (c) => {
  const t = tuitionOf(c);
  const id = uuid(c.req.param('id'), 'student id');
  const b = await readBody(c);
  const cls = (await levelIn(b, 'class_level', t.id, { optional: true })) ?? null;
  const subjects = 'subject_ids' in b ? subjectIds(b.subject_ids) : [];
  await taughtSubjectIds(t.id, subjects);
  const m = await tx(async (cx) => {
    // Letting a student in takes room on the tuition's plan (lib/plans.ts).
    await roomFor(cx, t.id, 'student', id);
    const row = await tq1<{ class_level: number | null }>(
      t.id,
      `update memberships set status = 'active', class_level = coalesce($2, class_level)
        where tuition_id = @T and user_id = $1 and role = 'student' and status = 'pending' returning class_level`,
      [id, cls],
      cx,
    );
    if (!row) return null;
    // A person who so far is only in another tuition's courses has no class to ask for: the tutor names one.
    if (row.class_level == null) throw bad('Choose a class for this student.', 'class_needed');
    await tq(t.id, 'delete from student_subjects where tuition_id = @T and student_id = $1', [id], cx);
    if (subjects.length) {
      await tq(t.id, 'insert into student_subjects (tuition_id, student_id, subject_id) select @T::uuid, $1::uuid, unnest($2::uuid[])', [id, subjects], cx);
      for (const s of subjects) await ensureGroup(t.id, row.class_level, s, cx);
    }
    return row;
  });
  if (!m) throw notFound('This request');
  if (pushConfigured()) await pushToUsers([id], { title: t.name, body: 'You have been added. Open the app to see your tests.' }).catch(() => 0);
  waitUntil(afterTestChange());
  return c.json({ ok: true });
});

/** Declines a student who is waiting, with any link requests they made here too. */
tuitionRoutes.post('/join-requests/:id/decline', async (c) => {
  const T = tuitionOf(c).id;
  const id = uuid(c.req.param('id'), 'student id');
  const gone = await tx(async (cx) => {
    const m = await tq1(
      T,
      `delete from memberships where tuition_id = @T and user_id = $1 and role = 'student' and status = 'pending' returning user_id`,
      [id],
      cx,
    );
    if (m) await tq(T, 'delete from join_requests where tuition_id = @T and student_id = $1', [id], cx);
    return m;
  });
  if (!gone) throw notFound('This request');
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- the tuition's classes

/** Class 1 to 12, and the levels this tuition has named itself (LKG, "NEET 2027"). */
tuitionRoutes.get('/levels', async (c) => c.json({ levels: await levelsOf(tuitionOf(c).id) }));

/** Names a new level. Asking for a name the tuition already has gives that level back. */
tuitionRoutes.post('/levels', async (c) => {
  const T = tuitionOf(c).id;
  const level = await addLevel(T, (await readBody(c)).label);
  return c.json({ level, levels: await levelsOf(T) }, 201);
});

const customCode = (raw: string) => {
  const code = Number(raw);
  if (!Number.isInteger(code) || code < CUSTOM_MIN || code > CUSTOM_MAX) throw bad('Only a class you named yourself can be changed.', 'not_custom');
  return code;
};

/** Renames a level the tuition named itself. */
tuitionRoutes.patch('/levels/:code', async (c) => {
  const T = tuitionOf(c).id;
  const code = customCode(c.req.param('code'));
  const label = cleanLabel((await readBody(c)).label);
  let row;
  try {
    row = await tq1(T, 'update tuition_levels set label = $2 where tuition_id = @T and code = $1 returning code, label', [code, label]);
  } catch (e: any) {
    if (e.code === '23505') throw new HttpError(409, 'level_exists', `You already have a class called ${label}.`);
    throw e;
  }
  if (!row) throw notFound('This class');
  return c.json({ levels: await levelsOf(T) });
});

/** Removes a level nothing uses any more. */
tuitionRoutes.delete('/levels/:code', async (c) => {
  const T = tuitionOf(c).id;
  const code = customCode(c.req.param('code'));
  if (await levelInUse(T, code)) {
    throw new HttpError(409, 'level_in_use', 'Students, groups, tests or papers still use this class. Move or delete those first.');
  }
  const gone = await tq1(T, 'delete from tuition_levels where tuition_id = @T and code = $1 returning code', [code]);
  if (!gone) throw notFound('This class');
  return c.json({ levels: await levelsOf(T) });
});
