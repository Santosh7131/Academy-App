import { randomBytes } from 'node:crypto';
import { APP_NAME } from '../lib/brand.ts';
import { Hono, type Context } from 'hono';
import {
  checkPassword, checkUsername, clearTries, createSession, hashSecret, LOCK_MINUTES, lockedError, requireUser, takeTry, tokenHash, verifySecret, type AppEnv,
} from '../lib/auth.ts';
import { clientInfo, knowsCourses, minBuild, recordInstall, tooOld, updateRequired } from '../lib/client.ts';
import { startCredit } from '../lib/credit.ts';
import { pool, q, q1, tx, type Db } from '../lib/db.ts';
import { googleClientIds, verifyGoogleToken } from '../lib/google.ts';
import { bad, hasNul, HttpError, int, str, uuidOpt } from '../lib/http.ts';
import { addLevel, CLASS_MAX, CLASS_MIN, LEVELS_JSON } from '../lib/levels.ts';
import { ensureGroup, freeJoinCode, showCode } from '../lib/tuition.ts';
import { freeUsername } from '../lib/usernames.ts';
import { readBody } from './body.ts';

export const authRoutes = new Hono<AppEnv>();

/** The tuitions a person is in or waiting to join. Only a tutor is shown the join code. */
const myTuitions = (userId: string) =>
  q(
    `select t.id, t.name, m.role, m.status, m.class_level, m.joined_at, ${LEVELS_JSON},
            case when m.role in ('owner', 'tutor') and m.status = 'active' then t.join_code end as join_code
       from memberships m join tuitions t on t.id = m.tuition_id
      where m.user_id = $1 and m.status in ('active', 'pending')
      order by m.joined_at`,
    [userId],
  );

/** Every sign-in attempt goes into the login history the admin app shows. */
const authLog = (c: Context<AppEnv>, username: string) => {
  const ci = clientInfo(c);
  return (outcome: string, userId: string | null = null) =>
    pool.query(
      `insert into auth_events (username, user_id, outcome, install_id, app_version) values ($1, $2, $3, $4, $5)`,
      [username.slice(0, 40), userId, outcome, ci.installId, ci.appVersion],
    );
};

type KnownUser = { id: string; role: string; username: string; display_name: string; class_level: number | null; active: boolean };

/**
 * The rest of a sign-in once the person is known, with a password or with Google: a turned-off login and an app too old
 * for it are refused, and anyone else gets a session.
 */
async function finishLogin(c: Context<AppEnv>, u: KnownUser, log: ReturnType<typeof authLog>) {
  const ci = clientInfo(c);
  // A turned-off login is only said to be off to someone who has proved who they are, and every wrong guess at its
  // password counts toward the lockout like any other.
  if (!u.active) {
    await log('inactive', u.id);
    throw new HttpError(403, 'inactive', 'This login has been turned off. Please ask your teacher.');
  }
  // Said only to someone who proved the login is theirs, like "turned off" above. An app that is too old, or from before
  // courses and signing in as a student who has no class, is told to update instead of being let in to a screen it cannot show.
  if (tooOld(c, await minBuild())) {
    await log('update_required', u.id);
    throw updateRequired();
  }
  if (u.role === 'student' && !knowsCourses(c)) {
    const noClass = await q1(`select 1 as x from memberships where user_id = $1 and role = 'student' and status = 'active' and class_level is null`, [u.id]);
    if (noClass) {
      await log('update_required', u.id);
      throw updateRequired('Your courses need the newest version of ' + APP_NAME + '. Please install it, then open the app again. Your tutor can send it to you.');
    }
  }
  await pool.query('update users set failed_count = 0, locked_until = null, last_seen_at = now() where id = $1', [u.id]);
  await recordInstall(u.id, ci);
  const token = await createSession(u.id, ci.installId);
  await log('ok', u.id);
  return {
    token,
    user: { id: u.id, role: u.role, username: u.username, display_name: u.display_name, class_level: u.class_level },
    tuitions: u.role === 'developer' ? [] : await myTuitions(u.id),
  };
}

authRoutes.post('/login', async (c) => {
  const b = await readBody(c);
  const username = typeof b.username === 'string' ? b.username.trim().toLowerCase() : '';
  const secret = typeof b.secret === 'string' ? b.secret : '';
  const wrong = new HttpError(401, 'wrong_login', 'That username and password do not match.');
  // A username is 3 to 24 plain characters: anything else cannot be one, and a NUL would not even reach the database.
  if (!username || !secret || username.length > 64 || hasNul(username)) throw wrong;
  const log = authLog(c, username);

  const u = await q1(
    `select id, role, username, display_name, class_level, secret_hash, secret_salt, active
       from users where username = $1`,
    [username],
  );
  if (!u) {
    // The same work as a real attempt, so how long the reply takes does not say whether the username exists.
    await hashSecret(secret);
    await log('unknown_user');
    throw wrong;
  }
  // The try is taken before the secret is looked at, in one statement, so a burst of guesses sent at once cannot all be
  // checked before the lock shows.
  const t = await takeTry(u.id);
  if (t.locked) {
    await log('locked', u.id);
    throw lockedError(t.minutes);
  }
  if (!(await verifySecret(secret, u.secret_hash, u.secret_salt))) {
    if (t.lastTry) {
      await log('lockout', u.id);
      throw lockedError(LOCK_MINUTES);
    }
    await log('wrong_secret', u.id);
    throw wrong;
  }
  // The right secret gives the tries back, whatever else stops this login below.
  await clearTries(u.id);
  return c.json(await finishLogin(c, u, log));
});

/** New logins an hour, across the whole server, by role: a class of students may all sign up in the same lesson. */
const MAX_SIGNUPS_PER_HOUR = { teacher: 30, student: 300 } as const;
const MAX_SIGNUPS_PER_PHONE_PER_DAY = 3;

type NewLogin = {
  role: 'teacher' | 'student';
  username: string;
  displayName: string;
  secret: string;
  /** The username was made from the name (Google sign-up), so a taken one moves on to the next free one. */
  madeUp?: boolean;
  googleSub?: string;
};

/**
 * Makes the login of someone signing themselves up, a tutor or a student, with a password or with Google, and signs them in.
 * They are in no tuition yet: a tutor creates one next (POST /auth/tuitions), a student asks to join one (POST /student/join).
 * Sign-ups are capped, by role an hour and by phone a day, so the open door cannot be used to fill the database.
 */
async function signUp(c: Context<AppEnv>, n: NewLogin) {
  const ci = clientInfo(c);
  const tooMany = async (db: Db) => {
    const recent = await q1(
      `select (select count(*) from users where role = $2 and created_at > now() - interval '1 hour') as hour,
              (select count(*) from auth_events where outcome = 'signup' and install_id = $1 and at > now() - interval '1 day') as phone_day`,
      [ci.installId, n.role],
      db,
    );
    return recent.hour >= MAX_SIGNUPS_PER_HOUR[n.role] || (ci.installId && recent.phone_day >= MAX_SIGNUPS_PER_PHONE_PER_DAY);
  };
  const full = new HttpError(429, 'too_many_signups', 'Too many new accounts were made just now. Please try again later.');
  // A first look before the password is worked on, so a refused sign-up costs almost nothing.
  if (await tooMany(pool)) throw full;
  const { hash, salt } = await hashSecret(n.secret);
  let username = n.username;
  let u: { id: string; role: string; username: string; display_name: string };
  for (let attempt = 0; ; attempt++) {
    try {
      u = await tx(async (cx) => {
        // One at a time from here: the caps are counted again with every sign-up before this one in view, so a burst sent at
        // once cannot all pass a count that was read before any of them was written.
        await cx.query(`select pg_advisory_xact_lock(hashtext('signup'))`);
        if (await tooMany(cx)) throw full;
        const row = (await q1(
          `insert into users (role, username, display_name, secret_hash, secret_salt, google_sub) values ($1, $2, $3, $4, $5, $6)
           returning id, role, username, display_name`,
          [n.role, username, n.displayName, hash, salt, n.googleSub ?? null],
          cx,
        ))!;
        await cx.query(
          `insert into auth_events (username, user_id, outcome, install_id, app_version) values ($1, $2, 'signup', $3, $4)`,
          [username, row.id, ci.installId, ci.appVersion],
        );
        return row;
      });
      break;
    } catch (e: any) {
      if (e.code !== '23505') throw e;
      // The same Google account signing up twice at once: the first one made the login.
      if (e.constraint === 'users_google_sub_key') throw new HttpError(409, 'google_taken', 'This Google account already has a login. Sign in with Google again.');
      if (n.madeUp && attempt < 3) {
        username = await freeUsername(n.displayName, pool, [username]);
        continue;
      }
      throw new HttpError(409, 'username_taken', `The username ${username} is already taken.`);
    }
  }
  await recordInstall(u.id, ci);
  const token = await createSession(u.id, ci.installId);
  return { token, user: { ...u, class_level: null }, tuitions: [] };
}

/** A tutor signs themselves up with a username and password. */
authRoutes.post('/signup-tutor', async (c) => {
  const b = await readBody(c);
  const displayName = str(b, 'display_name', { max: 60 })!;
  const username = checkUsername(b.username);
  const password = checkPassword(b.password);
  return c.json(await signUp(c, { role: 'teacher', username, displayName, secret: password }), 201);
});

/** A student signs themselves up with a username and password, then asks to join a tuition with a link, a QR code or a code. */
authRoutes.post('/signup-student', async (c) => {
  const b = await readBody(c);
  const displayName = str(b, 'display_name', { max: 60 })!;
  const username = checkUsername(b.username);
  const password = checkPassword(b.password);
  return c.json(await signUp(c, { role: 'student', username, displayName, secret: password }), 201);
});

/** What the login screen needs before anyone signs in: the Google client to ask for a token, when Google sign-in is on. */
authRoutes.get('/config', (c) => c.json({ google_client_id: googleClientIds()[0] ?? null }));

/**
 * Sign in with Google: { id_token, role? }. A Google account that has a login signs in to it. One that has none makes a
 * login when the app says which kind ("student" or "teacher"), with a username made from the name and no password; without
 * a role the reply is 404 no_account, and the app asks which kind and sends the same token again. Only the account's
 * Google number is kept.
 */
authRoutes.post('/google', async (c) => {
  const audiences = googleClientIds();
  if (!audiences.length) throw new HttpError(403, 'google_off', 'Google sign-in is not set up yet.');
  const b = await readBody(c);
  const token = typeof b.id_token === 'string' ? b.id_token : '';
  if (!token) throw bad('Google sent no sign-in token. Please try again.', 'no_token');
  let role: 'student' | 'teacher' | null = null;
  if (b.role !== undefined && b.role !== null) {
    if (b.role !== 'student' && b.role !== 'teacher') throw bad('Say whether this is a student or a tutor.', 'invalid_role');
    role = b.role;
  }
  const g = await verifyGoogleToken(token, audiences);
  const u = await q1<KnownUser>(`select id, role, username, display_name, class_level, active from users where google_sub = $1`, [g.sub]);
  if (u) return c.json(await finishLogin(c, u, authLog(c, u.username)));
  if (!role) throw new HttpError(404, 'no_account', 'This Google account has no login yet. Choose whether you are a student or a tutor.');
  const kind = role === 'teacher' ? 'Tutor' : 'Student';
  const name = g.name ?? kind;
  const made = await signUp(c, {
    role,
    // A username has English letters only: a name written in Tamil or Hindi letters gets "student.4" or "tutor.2".
    username: await freeUsername(/[a-z]/i.test(name) ? name : kind),
    displayName: name,
    // No password: this login is only ever signed in to with Google.
    secret: randomBytes(24).toString('base64url'),
    madeUp: true,
    googleSub: g.sub,
  });
  return c.json({ ...made, created: true }, 201);
});

/**
 * A new password for the signed-in person, a tutor or a student. The current one has to be right, and wrong guesses count
 * toward the same lock as at login, so a stolen phone's session cannot be used to guess the password at leisure. Every other
 * phone is signed out: a password changed because a phone was lost must end the lost phone's session too. Also at
 * POST /teacher/password, where the tutors' app has always sent it.
 */
export async function changePassword(c: Context<AppEnv>) {
  const b = await readBody(c);
  const id = c.get('user').id;
  const me = await q1('select secret_hash, secret_salt from users where id = $1', [id]);
  const t = await takeTry(id);
  if (t.locked) throw lockedError(t.minutes);
  if (!(await verifySecret(String(b.current ?? ''), me.secret_hash, me.secret_salt))) {
    if (t.lastTry) throw lockedError(LOCK_MINUTES);
    throw new HttpError(400, 'wrong_password', 'Your current password is not right.');
  }
  const { hash, salt } = await hashSecret(checkPassword(b.next));
  await pool.query('update users set secret_hash = $2, secret_salt = $3, failed_count = 0, locked_until = null where id = $1', [id, hash, salt]);
  await pool.query('delete from sessions where user_id = $1 and token_hash <> $2', [id, tokenHash((c.req.header('authorization') ?? '').slice(7).trim())]);
  return c.json({ ok: true });
}

authRoutes.post('/password', requireUser(undefined, { tuition: 'none' }), changePassword);

/**
 * Deletes the signed-in student's account for good, with their results in every tuition: { secret } with their password, or
 * { id_token } from signing in with Google again, for a login made with Google. Wrong passwords count toward the login's lock,
 * and a wrong one is 403, not 401, so the app does not take it for a session that ended. A tutor's account goes with their
 * tuition instead (POST /teacher/tuition/delete).
 */
authRoutes.post('/delete-account', requireUser('student', { tuition: 'none' }), async (c) => {
  const me = c.get('user');
  const b = await readBody(c);
  const u = (await q1<{ secret_hash: string; secret_salt: string; google_sub: string | null }>(
    'select secret_hash, secret_salt, google_sub from users where id = $1',
    [me.id],
  ))!;
  if (typeof b.id_token === 'string' && b.id_token) {
    const audiences = googleClientIds();
    const other = new HttpError(403, 'wrong_google', 'That is not the Google account this login uses.');
    if (!audiences.length || !u.google_sub) throw other;
    if ((await verifyGoogleToken(b.id_token, audiences)).sub !== u.google_sub) throw other;
  } else {
    const secret = str(b, 'secret', { max: 200 })!;
    const tried = await takeTry(me.id);
    if (tried.locked) throw lockedError(tried.minutes);
    if (!(await verifySecret(secret, u.secret_hash, u.secret_salt))) {
      if (tried.lastTry) throw lockedError(LOCK_MINUTES);
      throw new HttpError(403, 'wrong_password', 'That password is not right.');
    }
  }
  await pool.query(`delete from users where id = $1 and role = 'student'`, [me.id]);
  return c.json({ ok: true });
});

/** The standard subjects a new tuition can pick from while it is being set up (it has no tuition yet). */
authRoutes.get('/standard-subjects', requireUser('teacher', { tuition: 'none' }), async (c) =>
  c.json({ subjects: await q('select id, name from subjects where tuition_id is null order by sort_order, name') }));

const MAX_OWNED = 3;

/**
 * Creates a tuition for the signed-in tutor, who becomes its owner, with the subjects and groups
 * they teach: { name, groups: [{ class_level, subject_id | subject_name }] }. A subject is a
 * standard one (by id or by name) or, for a name nobody has used, one of the tuition's own.
 */
authRoutes.post('/tuitions', requireUser('teacher', { tuition: 'none' }), async (c) => {
  const me = c.get('user');
  const b = await readBody(c);
  const name = str(b, 'name', { max: 60 })!;
  const rawGroups: any[] = Array.isArray(b.groups) ? b.groups : [];
  if (rawGroups.length > 40) throw bad('That is too many groups to start with. Add the rest later.');
  const groups = rawGroups.map((g) => {
    const subjectId = uuidOpt(g?.subject_id, 'subject');
    const subjectName = str(g ?? {}, 'subject_name', { max: 40, optional: true }) ?? null;
    if (!subjectId && !subjectName) throw bad('Each group needs a subject.');
    // A new tuition has named no levels yet, so a group is Class 1 to 12 or gives the name of a level of its own.
    const levelName = str(g ?? {}, 'level_name', { max: 30, optional: true }) ?? null;
    const cls = levelName ? null : int(g, 'class_level', { min: CLASS_MIN, max: CLASS_MAX })!;
    return { cls, levelName, subjectId, subjectName };
  });
  const ownedCount = async (db: Db) => (await q1(`select count(*) as n from memberships where user_id = $1 and role = 'owner'`, [me.id], db)).n;
  const tooManyTuitions = new HttpError(409, 'too_many_tuitions', `You already run ${MAX_OWNED} tuitions.`);
  if ((await ownedCount(pool)) >= MAX_OWNED) throw tooManyTuitions;

  const t = await tx(async (cx) => {
    // Counted again with this tutor's other requests held back, so several sent at once cannot each pass the same count.
    await cx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`owner:${me.id}`]);
    if ((await ownedCount(cx)) >= MAX_OWNED) throw tooManyTuitions;
    const row = await q1<{ id: string; name: string; join_code: string }>(
      `insert into tuitions (name, join_code, created_by) values ($1, $2, $3) returning id, name, join_code`,
      [name, await freeJoinCode(cx), me.id],
      cx,
    );
    await cx.query(`insert into memberships (tuition_id, user_id, role, status) values ($1, $2, 'owner', 'active')`, [row!.id, me.id]);
    // The free AI credit a new tuition starts with (lib/credit.ts), or none while new clients may not use AI.
    await startCredit(cx, row!.id);
    for (const g of groups) {
      let subject: { id: string } | undefined;
      if (g.subjectId) {
        subject = await q1('select id from subjects where id = $1 and tuition_id is null', [g.subjectId], cx);
        if (!subject) throw bad('Choose one of the listed subjects, or type a new one.', 'unknown_subject');
      } else {
        subject = await q1('select id from subjects where tuition_id is null and lower(name) = lower($1)', [g.subjectName], cx);
        subject ??= await q1('select id from subjects where tuition_id = $1 and lower(name) = lower($2)', [row!.id, g.subjectName], cx);
        subject ??= await q1(
          `insert into subjects (name, sort_order, tuition_id)
           values ($1, coalesce((select max(sort_order) + 1 from subjects where tuition_id = $2), 100), $2) returning id`,
          [g.subjectName, row!.id],
          cx,
        );
      }
      await cx.query('insert into tuition_subjects (tuition_id, subject_id) values ($1, $2) on conflict do nothing', [row!.id, subject!.id]);
      const cls = g.levelName ? (await addLevel(row!.id, g.levelName, cx)).code : g.cls!;
      await ensureGroup(row!.id, cls, subject!.id, cx);
    }
    return row!;
  });
  return c.json({ tuition: { id: t.id, name: t.name, role: 'owner', join_code: t.join_code, join_code_shown: showCode(t.join_code) } }, 201);
});

authRoutes.post('/logout', requireUser(undefined, { gate: false }), async (c) => {
  const header = c.req.header('authorization') ?? '';
  await pool.query('delete from sessions where token_hash = $1', [tokenHash(header.slice(7).trim())]);
  return c.json({ ok: true });
});

authRoutes.get('/me', requireUser(), async (c) => {
  const u = c.get('user');
  const tuitions = u.role === 'developer' ? [] : await myTuitions(u.id);
  return c.json({
    user: u,
    // The apps from before tuitions show this as the tuition's name.
    tuition_name: c.get('tuition')?.name ?? tuitions.find((t: any) => t.status === 'active')?.name ?? APP_NAME,
    tuitions,
  });
});
