import { APP_NAME } from './lib/brand.ts';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { requireUser, type AppEnv } from './lib/auth.ts';
import { knowsMoreOptions } from './lib/client.ts';
import { geminiConfigured } from './lib/gemini.ts';
import { aiConfigured } from './lib/groq.ts';
import { HttpError } from './lib/http.ts';
import { countRequest, logError } from './lib/metrics.ts';
import { NEEDS_NEWER_APP, usesMoreOptions } from './lib/options.ts';
import { pushConfigured } from './lib/push.ts';
import { adminRoutes } from './routes/admin.ts';
import { authRoutes } from './routes/auth.ts';
import { courseRoutes } from './routes/courses.ts';
import { creditAdminRoutes, creditRoutes } from './routes/credit.ts';
import { libraryRoutes } from './routes/library.ts';
import { notifyRoutes } from './routes/notify.ts';
import { paperRoutes } from './routes/papers.ts';
import { studentOpenRoutes, studentRoutes } from './routes/student.ts';
import { teacherRoutes } from './routes/teacher.ts';
import { tuitionRoutes } from './routes/tuition.ts';

const app = new Hono<AppEnv>();

// A large request body that no route reads (a route that ignores it, or one that answers 401 first) can stay in the platform's connection to this
// function, and the next request on that connection then gets no answer for a minute. The security test found it. So every body is read away
// before any route runs, and one over MAX_BODY (the app sends a few KB at most) is read away and refused.
const MAX_BODY = 1_000_000;
const tooBig = () => new HttpError(413, 'too_big', 'That is too much data to send at once.');
async function readAway(stream: ReadableStream<Uint8Array>, each?: (bytes: number) => void) {
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    each?.(value.byteLength);
  }
}
app.use('*', async (c, next) => {
  const raw = c.req.raw;
  if (!raw.body) return next();
  // A body that says it is too big is read away without being kept.
  if (Number(c.req.header('content-length')) > MAX_BODY) {
    await readAway(raw.body);
    throw tooBig();
  }
  // Any other is read from a copy, so the route can still read the request itself (the notification trigger does). A body with no length stated can
  // be any size: once it passes MAX_BODY the route's copy is let go and the rest is only read away, so nothing past the cap is ever kept.
  let size = 0;
  await readAway(raw.clone().body!, (n) => {
    size += n;
    if (size > MAX_BODY && size - n <= MAX_BODY) raw.body!.cancel().catch(() => {});
  });
  if (size > MAX_BODY) throw tooBig();
  return next();
});

// The Android apps need no CORS. A browser build is let in only from the origins named in CORS_ORIGINS
// (comma separated), which the live function never sets: no website can call it from a page.
const origins = (process.env.CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
if (origins.length) {
  app.use('*', cors({
    origin: origins,
    allowHeaders: ['authorization', 'content-type', 'x-install-id', 'x-app', 'x-device', 'x-os', 'x-tuition'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  }));
}

// Requests per route per day, for the admin app (lib/metrics.ts says which ones count).
app.use('*', async (c, next) => {
  const started = performance.now();
  await next();
  countRequest(c, performance.now() - started);
});

// An app before build 13 has four slots for a question's options, so it is never sent a question with more (lib/options.ts says why). The
// whole reply is swapped for a sentence that says what to do; the question stays where it is, and the newest app opens it as usual. This
// only swaps what was read: a call that changes something first (starting a test) checks before it does, so nothing is used up unseen.
app.use('*', async (c, next) => {
  await next();
  if (knowsMoreOptions(c) || c.res.status >= 300 || !(c.res.headers.get('content-type') ?? '').includes('application/json')) return;
  let body: unknown;
  try {
    body = await c.res.clone().json();
  } catch {
    return;
  }
  if (usesMoreOptions(body)) c.res = c.json({ error: { code: 'needs_newer_app', message: NEEDS_NEWER_APP } }, 409);
});

app.get('/', (c) =>
  c.json({
    name: `${APP_NAME} API`, branch: process.env.NEON_BRANCH ?? null,
    ai: aiConfigured(), gemini: geminiConfigured(), push: pushConfigured(),
  }));

app.route('/auth', authRoutes);
app.route('/student', studentOpenRoutes);
app.route('/student', studentRoutes);
app.route('/', notifyRoutes);

const teacher = new Hono<AppEnv>();
teacher.use('*', requireUser('teacher'));
teacher.route('/', teacherRoutes);
teacher.route('/', tuitionRoutes);
teacher.route('/', courseRoutes);
teacher.route('/', libraryRoutes);
teacher.route('/', paperRoutes);
teacher.route('/', creditRoutes);
app.route('/teacher', teacher);

const admin = new Hono<AppEnv>();
admin.use('*', requireUser('developer'));
admin.route('/', adminRoutes);
admin.route('/', creditAdminRoutes);
app.route('/admin', admin);

app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found.' } }, 404));

app.onError((err, c) => {
  if (err instanceof HttpError) {
    // Anything extra (the credit left, say) goes beside the code and message, never over them.
    return c.json({ error: { ...err.extra, code: err.code, message: err.message } }, err.status as 400);
  }
  console.error(err);
  logError(c, err);
  return c.json({ error: { code: 'server_error', message: 'Something went wrong on the server. Please try again.' } }, 500);
});

export default app;
