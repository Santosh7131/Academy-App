import { Hono } from 'hono';
import { tuitionOf, type AppEnv } from '../lib/auth.ts';
import { ownCourse } from '../lib/courses.ts';
import { chargePage, chargeQuestions, hold, pictureOf, release, type Hold } from '../lib/credit.ts';
import { pool, q, q1, tq, tq1, tx, type Db } from '../lib/db.ts';
import { isGemini } from '../lib/gemini.ts';
import { CHECK_MODELS, chat, parseJson, SOLVE_MODELS, TIEBREAK_MODELS, VISION_MODELS, WRITE_MODELS, type ChatMessage } from '../lib/groq.ts';
import { bad, bool, date, hasNul, HttpError, int, MAX_OPTION_CHARS, notFound, str, uuid, uuidOpt } from '../lib/http.ts';
import { customLevels, isClassNumber, levelIn, levelLabel, studyOf } from '../lib/levels.ts';
import { realNewlines, wrapBareMath } from '../lib/latex-json.ts';
import { tidyPage } from '../lib/tidy.ts';
import { carryPlan, sharedPassage, takePassages } from '../lib/passages.ts';
import { figureOf, verdict, type Pick, type Votes } from '../lib/votes.ts';
import { difficultyOf, mustKeepOrder, type Difficulty } from '../lib/questions.ts';
import { cleanPlaced, isRestOfQuestion, joinParts, looksCut, placed, placedQuestion, storedOptions, type BoxOrder, type Part, type Placed } from '../lib/pieces.ts';
import { knowsMoreOptions } from '../lib/client.ts';
import { isWholeList, letterOf, MAX_OPTIONS, maxOptionsFor, MIN_OPTIONS } from '../lib/options.ts';
import { applyShared, cleanShared, wantingKey, type Shared } from '../lib/shared.ts';
import { applyRereads, cleanRereads, lastWordsOf, lostChoices, type Reread } from '../lib/second-look.ts';
import { asciiDigits, hasIndicText, indicLabelIndex, namesIndicLanguage } from '../lib/text.ts';
import { declaredSize, deleteObjects, MAX_IMAGE_BYTES, maybeViewUrl, objectSize, readObject, uploadUrl, viewUrl } from '../lib/storage.ts';
import { defaultSubject, ensureGroup, ownChapter, ownImageKey, taughtSubject } from '../lib/tuition.ts';
import { absorbRests, parseWholePages, planWindows, restBoxes } from '../lib/wholepaper.ts';
import { readBody } from './body.ts';

// Mounted behind requireUser('teacher') in index.ts.
//
// A paper is photographed or picked as a PDF first. AI then reads its first page for the details
// (name, class, subject, category, chapter) and the teacher fills in only what it could not find.
// Every page is read for its questions and any answer key it prints, and AI marks the answers the
// paper does not give only when two models agree and each is sure. The teacher checks and saves.
export const paperRoutes = new Hono<AppEnv>();

const MAX_PAGES = 20;
const pageKey = (paperId: string, pageNo: number) => `papers/${paperId}/p${pageNo}.jpg`;

/** Papers one tuition may start in a day. Each one is photos in storage and AI work, so there is a ceiling. */
const MAX_PAPERS_PER_DAY = 100;

/** The name old papers carry until AI or the tutor names them. */
const UNNAMED = 'New paper';

/** "Paper 10 Oct": the name a paper starts with, so nothing waits for a tutor to type one. AI replaces it with the paper's own title when it finds one. */
const autoName = () => `Paper ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}`;

/** How many questions AI answers per request, so each request stays short. */
const ANSWER_BATCH = 6;

const clip = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const conf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0);

/**
 * What a paper still needs before its questions can be saved. A name is never one of them: it starts with the
 * date. A course's paper needs nothing: it has no class or subject.
 */
function missingOf(p: { exam_name: string | null; class_level: number | null; subject_id: string | null; course_id?: string | null }) {
  if (p.course_id) return [];
  return [
    ...(p.class_level == null ? ['class_level'] : []),
    ...(p.subject_id == null ? ['subject_id'] : []),
  ];
}

const CATEGORIES = `select category as name, count(*) as papers from papers where tuition_id = @T and category is not null group by 1 order by 1`;

/** The tuition's papers for its groups, or with ?course=<id> a course's papers (never both). */
paperRoutes.get('/papers', async (c) => {
  const T = tuitionOf(c).id;
  const courseId = uuidOpt(c.req.query('course'), 'course');
  if (courseId) await ownCourse(T, courseId);
  const rows = await tq(
    T,
    `select p.id, p.class_level, p.course_id, p.exam_name, p.category, p.page_count, p.created_at,
            p.subject_id, (select name from subjects where id = p.subject_id) as subject,
            (select count(*) from paper_pages pp where pp.paper_id = p.id and pp.ai_status = 'done') as pages_read,
            (select count(*) from paper_drafts d where d.paper_id = p.id and d.status = 'draft' and d.kind = 'mcq') as to_check,
            (select count(*) from paper_drafts d where d.paper_id = p.id and d.status = 'saved') as saved
       from papers p
      where p.tuition_id = @T and p.course_id is not distinct from $1::uuid
      order by p.created_at desc`,
    [courseId],
  );
  return c.json({ papers: rows, categories: await tq(T, CATEGORIES) });
});

/** The test planned for a paper made as one of several: when it opens and closes, how long it takes, whether its questions are shuffled. */
type Plan = { opens_at: string | null; closes_at: string; time_limit_min: number | null; shuffle: boolean };

/**
 * Reads a paper's plan from a request; null clears it. Every test closes, so a plan has a closing time, after the opening one. No
 * time limit means a minute and a half a question, worked out when the test is posted.
 */
function readPlan(v: unknown): Plan | null {
  if (v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw bad('The plan must be an object.');
  const b = v as Record<string, any>;
  const opens = date(b, 'opens_at');
  const closes = date(b, 'closes_at');
  if (!closes) throw bad('A planned test needs a closing time.');
  if (opens && opens >= closes) throw bad('The test must close after it opens.');
  return {
    opens_at: opens ? opens.toISOString() : null,
    closes_at: closes.toISOString(),
    time_limit_min: int(b, 'time_limit_min', { min: 1, max: 300, optional: true }) ?? null,
    shuffle: bool(b, 'shuffle', true),
  };
}

/**
 * Creates the paper and hands back one direct-upload URL per page. The details are optional: AI
 * finds them afterwards. (The app before 1.3 sends the class, subject and name up front.) A paper made for a
 * course (course_id) has no class or subject: it belongs to the course. A paper made as one of several carries
 * the test planned for it (`plan`).
 */
paperRoutes.post('/papers', async (c) => {
  const T = tuitionOf(c).id;
  const b = await readBody(c);
  const pages = int(b, 'pages', { min: 1, max: MAX_PAGES })!;
  const plan = 'plan' in b ? readPlan(b.plan) : null;
  const courseId = uuidOpt(b.course_id, 'course');
  if (courseId) await ownCourse(T, courseId);
  const classLevel = courseId ? null : ((await levelIn(b, 'class_level', T, { optional: true })) ?? null);
  const named = str(b, 'exam_name', { max: 80, optional: true });
  // An app that sends a class but no subject is older than subjects: its papers are Maths (or the tuition's first subject).
  const sent = courseId ? null : uuidOpt(b.subject_id, 'subject');
  const subjectId = courseId ? null : sent ? (await taughtSubject(T, sent)).id : classLevel != null ? await defaultSubject(T) : null;
  // An app from 1.5.0 says how big each page is, and its upload URL then takes exactly that many bytes.
  const sizes: unknown[] = Array.isArray(b.sizes) ? b.sizes : [];
  if (sizes.length && sizes.length !== pages) throw bad('Say the size of every page, or none.');
  const declared = Array.from({ length: pages }, (_, i) => declaredSize(sizes[i]));
  const today = await tq1<{ n: number }>(T, `select count(*) as n from papers where tuition_id = @T and created_at > now() - interval '1 day'`);
  if ((today?.n ?? 0) >= MAX_PAPERS_PER_DAY) {
    throw new HttpError(429, 'too_many_papers', 'That is a lot of papers for one day. Please try again tomorrow.');
  }
  const paper = await tx(async (cx) => {
    const p = await q1(
      `insert into papers (tuition_id, class_level, exam_name, category, page_count, uploaded_by, subject_id, name_auto, course_id, plan)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb) returning id, class_level, exam_name, category, page_count, subject_id, course_id, plan`,
      [T, classLevel, named ?? autoName(), str(b, 'category', { max: 60, optional: true }) ?? null,
        pages, c.get('user').id, subjectId, named === undefined, courseId, plan ? JSON.stringify(plan) : null],
      cx,
    );
    for (let n = 1; n <= pages; n++) {
      await cx.query('insert into paper_pages (paper_id, page_no, object_key) values ($1, $2, $3)', [p.id, n, pageKey(p.id, n)]);
    }
    return p;
  });
  const uploads = await Promise.all(
    Array.from({ length: pages }, async (_, i) => ({
      page_no: i + 1,
      put_url: await uploadUrl(pageKey(paper.id, i + 1), 'image/jpeg', declared[i] ?? undefined),
    })),
  );
  return c.json({ paper, uploads }, 201);
});

/** One reply holds about this many questions, so a longer test is written in several calls. */
const WRITE_BATCH = 25;
/** Hindi and Tamil take several times the tokens of English for the same question, so a call writes fewer. */
const INDIC_WRITE_BATCH = 10;

/** One question the writer model gave back, with the option it says is right (null when that could not be told) and how hard it judged it (null when it did not say: the question is then saved as Medium). */
type Written = { text: string; options: string[]; answer: number | null; difficulty: Difficulty | null };

/**
 * Has the writer model write `asked` multiple-choice questions on the teacher's request. It is told what the paper holds
 * already (every draft, replaced ones too), so it writes something new. The writer's own answer comes with each question: it
 * is one opinion among three, so a question whose answer cannot be told is still kept. `name` is the test name the writer
 * suggested, which it is asked for only while the paper holds nothing.
 */
async function writeQuestions(w: {
  userId: string; tuitionId: string; request: string; asked: number; indic: boolean; study: string; subject: string | null;
  classLevel: number | null; course: boolean; written: { text: string }[];
}): Promise<{ items: Written[]; name: string }> {
  const { written, asked, study } = w;
  const already = written.slice(-150).map((x) => `- ${x.text.replace(/\s+/g, ' ').slice(0, 90)}`).join('\n');

  const messages: ChatMessage[] = [
      { role: 'system', content: `You write multiple-choice questions for ${w.classLevel != null && isClassNumber(w.classLevel) ? 'a CBSE tuition teacher' : 'a tuition teacher'} in India. You are exact about maths and science.` },
      {
        role: 'user',
        content: `Write exactly ${asked} multiple-choice questions for ${study}${w.subject ? ` ${w.subject}` : ''}, as the teacher asks below. The request may name a number of questions for the whole test: ignore that, this reply is ${asked}.
Teacher's request:
"""
${w.request}
"""
${written.length ? `
The test already has ${written.length} questions, listed below. Write ${asked} new ones on new ground within the request: not the same question, and not one of these reworded.
${already}
` : ''}

Reply only as JSON:
{${written.length ? '' : '"name":"<short test name>",'}"questions":[{"text":"<question>","work":"<one line: how you got the right answer>","options":["<a>","<b>","<c>","<d>"],"answer":"<the correct option, copied exactly as it is written in options>","difficulty":"easy" or "medium" or "hard"}]}
Rules:
- Write the keys of each question in the order shown: first the question, then "work", then the options. Work the answer out in "work" before you write the options, then make one option exactly that answer and build the other three from plausible mistakes (a wrong formula, a slip in a sign, a forgotten step). The right value of a calculation must be one of the options, and the question must give every number it needs (say "take g = 10 m/s²" when it matters).
- Exactly four options per question, and exactly one is correct. "answer" is the text of that option, copied character for character from "options" (not a letter). Spread the right answers over all four positions.
- Test each of the other three options before you finish a question and be sure it is wrong. Never write two options with the same value or meaning (such as $\\frac{\\sqrt{3}}{2}$ and $\\frac{\\sqrt{3}}{\\sqrt{4}}$, or $10\\sqrt{2}$ and 14.14), two that are both acceptable usage, or an option that repeats another.
- Ask only what a school textbook settles with one accepted answer. In grammar, vocabulary and idioms use the standard textbook examples, and do not use a sentence where more than one choice is acceptable. If a question cannot meet all of this, write a different one.
- Write all maths, formulas and chemical equations in LaTeX inside $...$, in the options as well as in the question, e.g. $\\frac{3}{4}$, $x^2$, $90^\\circ$, $H_2O$. This is JSON, so write every LaTeX backslash twice, as in "$\\\\frac{3}{4}$". Give each option's text without a letter label.
- Follow the teacher's topic and difficulty. ${w.course ? 'Pitch the questions at the level the request describes.' : `Match the ${study} syllabus.`}
- "difficulty" is how hard the question is for a student at that level: "easy" for a fact or one step, "medium" for a few steps, "hard" for many steps or a trap. Always give one of the three, and "medium" when you cannot tell. When the teacher asks for a mix, give each question the tag that is true of it.
- Write the questions and the options in the language of the teacher's request: English, Hindi or Tamil, or the one the request asks for. Hindi and Tamil questions use the standard school-textbook terms, and every number is written with the digits 0 to 9. The JSON keys and the answer letters A to D stay as shown.
- Every question must be answerable from its text alone: no figures, graphs or diagrams, and no "all of the above" or "none of the above".
- Wrong options are plausible mistakes. Do not repeat a question.
${written.length ? '' : '- name: at most 40 characters, e.g. "Quadratic equations, set 1".'}`,
      },
  ];

  // Each writer model gets its turn: one that fails, or whose reply holds no usable question (cut off, or not the shape asked for),
  // is followed by the next.
  let items: Written[] = [];
  let content = '';
  let failure: unknown = null;
  for (const model of WRITE_MODELS) {
    try {
      ({ content } = await chat({
        task: 'write_questions',
        userId: w.userId,
        tuitionId: w.tuitionId,
        models: [model],
        json: true,
        maxTokens: w.indic ? 10000 : 8000,
        temperature: 0.7,
        reasoning: 'low',
        messages,
      }));
    } catch (e) {
      failure = e;
      continue;
    }
    failure = null;
    items = [];
    for (const it of listIn(content, 'questions')) {
      const text = asciiDigits(clip(it?.text, 4000));
      const options = Array.isArray(it?.options)
        ? it.options.map((o: unknown) => wrapBareMath(asciiDigits(clip(typeof o === 'string' ? o : String(o ?? ''), 500))))
        : [];
      if (!text || options.length !== 4 || options.some((o: string) => !o)) continue;
      items.push({ text, options, answer: writerAnswer(it?.answer, options), difficulty: difficultyOf(it?.difficulty) });
      if (items.length >= asked) break;
    }
    if (items.length) break;
  }
  if (!items.length) throw failure ?? new HttpError(502, 'ai_unreadable', 'AI could not write that test. Try again, in different words.');
  let name = '';
  if (!written.length) {
    try {
      name = clip((parseJson<{ name?: unknown }>(content) as { name?: unknown })?.name, 40);
    } catch {
      // The questions are what matters: a missing name gets a plain one.
    }
  }
  return { items, name };
}

/**
 * The chat: the tutor says what test they want and AI writes it. The questions become the drafts
 * of a new paper with no pages, so they get the same checking as an uploaded one: two other models
 * solve each question without seeing the writer's answer, and it is marked only when both agree
 * with each other and with the writer. A question the checks cannot settle is replaced by a new one
 * (see /papers/:id/replace), which is why the paper keeps the request it was written from.
 *
 * A call writes at most WRITE_BATCH questions. A longer test is several calls: the first makes the
 * paper, and each later one sends its `paper_id` and adds to it, told what is already there so it
 * writes something new. The test can be any length.
 *
 * Papers belong to the tuition, not to the tutor who made them: every paper route is open to every
 * tutor (they share all groups, tests and papers, and any of them can already edit or delete a
 * paper), so adding to one checks its kind, class and subject but not who made it.
 */
paperRoutes.post('/papers/chat', async (c) => {
  const T = tuitionOf(c).id;
  const b = await readBody(c);
  // A course's test (course_id) is written for the course, which has no class or subject to name.
  const courseId = uuidOpt(b.course_id, 'course');
  const course = courseId ? await ownCourse(T, courseId) : null;
  const classLevel = course ? null : (await levelIn(b, 'class_level', T))!;
  const subjectId = course ? null : uuid(b.subject_id, 'subject');
  const request = str(b, 'request', { max: 1500 })!;
  const count = int(b, 'count', { min: 1, max: WRITE_BATCH, optional: true }) ?? 15;
  const paperId = b.paper_id == null ? null : uuid(b.paper_id, 'paper id');
  const subject = course ? null : await taughtSubject(T, subjectId!);
  const study = course ? `the course "${course.name}"` : await studyOf(T, classLevel!);
  // A request in Hindi or Tamil (or asking for one) is written in that language, a few questions at a time.
  const indic = hasIndicText(request) || namesIndicLanguage(request);
  const asked = indic ? Math.min(count, INDIC_WRITE_BATCH) : count;

  // The questions the paper already has, so a later call does not write them again.
  let written: { text: string; seq: number }[] = [];
  let paperName = '';
  if (paperId) {
    // Only a paper of this tuition: adding to another tuition's paper by its id is refused as not found.
    const p = await tq1<{ exam_name: string; class_level: number | null; subject_id: string | null; course_id: string | null; category: string | null; page_count: number }>(
      T,
      'select exam_name, class_level, subject_id, course_id, category, page_count from papers where id = $1 and tuition_id = @T',
      [paperId],
    );
    if (!p) throw notFound('This paper');
    const sameKind = course ? p.course_id === courseId : p.course_id === null && p.class_level === classLevel && p.subject_id === subjectId;
    if (p.category !== 'Made with AI' || p.page_count !== 0 || !sameKind) {
      throw bad('That paper was not written here, so questions cannot be added to it.');
    }
    paperName = p.exam_name;
    written = await q<{ text: string; seq: number }>('select text, seq from paper_drafts where paper_id = $1 order by seq', [paperId]);
  }

  // AI credit: the questions asked for are set aside before the writer starts, and only the ones it writes are charged, in the
  // transaction that saves them (lib/credit.ts). A writer that fails costs nothing.
  const held = await hold(T, { questions: asked });
  try {
    const { items, name: suggested } = await writeQuestions({
      userId: c.get('user').id, tuitionId: T, request, asked, indic, study, subject: subject?.name ?? null, classLevel, course: course != null, written,
    });
    const name = paperId ? paperName : suggested || `${subject?.name ?? course!.name} questions`;
    const first = written.length ? Math.max(...written.map((w) => w.seq)) + 1 : 0;

    const paper = await tx(async (cx) => {
      const p = paperId
        ? { id: paperId }
        : await q1(
            `insert into papers (tuition_id, class_level, exam_name, category, page_count, uploaded_by, subject_id, course_id, ai_request)
             values ($1, $2, $3, 'Made with AI', 0, $4, $5, $6, $7) returning id`,
            [T, classLevel, name, c.get('user').id, subjectId, courseId, request],
            cx,
          );
      for (const [i, it] of items.entries()) {
        await cx.query(
          `insert into paper_drafts (paper_id, page_no, seq, number_label, kind, text, options, answer_checked, proposed_option, difficulty, difficulty_by)
           values ($1, 1, $2, $3, 'mcq', $4, $5, false, $6, coalesce($7::text, 'medium'), case when $7::text is null then null else 'ai' end)`,
          [p.id, first + i, String(first + i + 1), it.text, it.options, it.answer, it.difficulty],
        );
      }
      await chargeQuestions(cx, T, held, { paperId: p.id, count: items.length, label: name });
      return p;
    });
    return c.json({ paper: { id: paper.id, exam_name: name }, questions: items.length, total: first + items.length }, 201);
  } finally {
    await release(held);
  }
});

/** The page number in a path: a whole number from 1 to MAX_PAGES, else a 400 (a word would reach the database and end as a server error). */
const pageNumber = (c: { req: { param(k: string): string } }) => int({ page: c.req.param('n') }, 'page', { min: 1, max: MAX_PAGES })!;

paperRoutes.post('/papers/:id/pages/:n/uploaded', async (c) => {
  const id = uuid(c.req.param('id'), 'paper id');
  const n = pageNumber(c);
  const page = await tq1(
    tuitionOf(c).id,
    `select pp.object_key from paper_pages pp join papers p on p.id = pp.paper_id
      where p.tuition_id = @T and pp.paper_id = $1 and pp.page_no = $2`,
    [id, n],
  );
  if (!page) throw notFound('This page');
  // The upload went straight to storage, which cannot cap its size: look at what arrived.
  const size = await objectSize(page.object_key);
  if (size === null) throw new HttpError(409, 'not_uploaded', 'This page did not finish uploading. Please add it again.');
  if (size > MAX_IMAGE_BYTES) {
    await deleteObjects([page.object_key]).catch(() => {});
    throw new HttpError(413, 'too_big', 'That picture is too big. Use one under 15 MB.');
  }
  await pool.query('update paper_pages set uploaded = true where paper_id = $1 and page_no = $2', [id, n]);
  return c.json({ ok: true });
});

const PAPER_COLS = `p.*, (select name from subjects where id = p.subject_id) as subject,
  (select name from chapters where id = p.chapter_id) as chapter, (select name from courses where id = p.course_id) as course`;

paperRoutes.get('/papers/:id', async (c) => {
  const T = tuitionOf(c).id;
  const id = uuid(c.req.param('id'), 'paper id');
  const p = await tq1(T, `select ${PAPER_COLS} from papers p where p.id = $1 and p.tuition_id = @T`, [id]);
  if (!p) throw notFound('This paper');
  const pages = await q(
    'select page_no, object_key, uploaded, ai_status, ai_error, read_at, answer_key from paper_pages where paper_id = $1 order by page_no',
    [id],
  );
  const drafts = await q(
    `select d.*, ch.name as chapter from paper_drafts d left join chapters ch on ch.id = d.chapter_id
      where d.paper_id = $1 order by d.page_no, d.seq`,
    [id],
  );
  const chapters =
    p.class_level == null || p.subject_id == null
      ? []
      : await tq(T, 'select id, name from chapters where tuition_id = @T and class_level = $1 and subject_id = $2 order by sort_order, name', [p.class_level, p.subject_id]);
  // The paper as a set: the questions saved from it, as they now are in the bank, in paper order.
  const questions = await q(
    `select qq.id, qq.text, qq.options, qq.correct_option, qq.image_key, coalesce(qq.difficulty, 'medium') as difficulty, qq.difficulty_by, ch.name as chapter, d.number_label
       from paper_drafts d join questions qq on qq.id = d.question_id left join chapters ch on ch.id = qq.chapter_id
      where d.paper_id = $1 and d.status = 'saved'
      order by d.page_no, d.seq`,
    [id],
  );
  // A paper AI wrote can have the questions its checks could not settle replaced: the app asks for that (POST /papers/:id/replace)
  // while this is true. The request the paper was written from stays on the server.
  const { ai_request: request, ...shown } = p;
  const replaceable = p.category === 'Made with AI' && p.page_count === 0 && request != null
    && drafts.filter((d) => d.ai_note === 'replaced').length < replaceCap(drafts.filter((d) => d.status !== 'discarded').length);
  return c.json({
    paper: { ...shown, missing: missingOf(p), replaceable },
    pages: await Promise.all(pages.map(async (pg) => ({ ...pg, image_url: pg.uploaded ? await viewUrl(pg.object_key) : null }))),
    drafts: await Promise.all(drafts.map(async (d) => ({ ...d, image_url: await maybeViewUrl(d.image_key) }))),
    chapters,
    questions: await Promise.all(questions.map(async (x) => ({ ...x, image_url: await maybeViewUrl(x.image_key) }))),
    categories: await tq(T, CATEGORIES),
    // Tests made from this paper, newest first.
    tests: await tq(
      T,
      `select id, title, status, opens_at, closes_at, (select count(*) from test_questions tq where tq.test_id = t.id) as question_count
         from tests t where t.paper_id = $1 and t.tuition_id = @T order by t.created_at desc`,
      [id],
    ),
  });
});

/**
 * Sets a paper's details. The class and subject can change only while no question from it is
 * saved, because saved questions use them. (The app before 1.3 sends only the name.)
 */
paperRoutes.patch('/papers/:id', async (c) => {
  const T = tuitionOf(c).id;
  const id = uuid(c.req.param('id'), 'paper id');
  const b = await readBody(c);
  const cur = await tq1(
    T,
    `select p.*, (select count(*) from paper_drafts d where d.paper_id = p.id and d.status = 'saved') as saved from papers p
      where p.id = $1 and p.tuition_id = @T`,
    [id],
  );
  if (!cur) throw notFound('This paper');
  const classLevel = 'class_level' in b ? ((await levelIn(b, 'class_level', T, { optional: true })) ?? null) : cur.class_level;
  const subjectId = 'subject_id' in b ? uuidOpt(b.subject_id, 'subject') : cur.subject_id;
  if (subjectId && subjectId !== cur.subject_id) await taughtSubject(T, subjectId);
  const moved = classLevel !== cur.class_level || subjectId !== cur.subject_id;
  if (moved && cur.saved > 0) {
    throw new HttpError(409, 'has_questions', 'Questions from this paper are already saved, so its class and subject stay as they are.');
  }
  // The planned test: sent as an object to set it, as null to clear it, left out to keep it.
  const plan = 'plan' in b ? readPlan(b.plan) : (cur.plan as Plan | null);
  const p = await tx(async (cx) => {
    const row = await q1(
      `update papers set exam_name = $2, category = $3, class_level = $4, subject_id = $5,
                         chapter_id = case when $7 then null else $6::uuid end,
                         name_auto = case when $8 then false else name_auto end,
                         plan = $9::jsonb
        where id = $1 returning id`,
      [
        id,
        'exam_name' in b ? str(b, 'exam_name', { max: 80 }) : cur.exam_name,
        'category' in b ? (str(b, 'category', { max: 60, optional: true }) ?? null) : cur.category,
        classLevel,
        subjectId,
        'chapter_id' in b ? await ownChapter(T, uuidOpt(b.chapter_id, 'chapter'), cx) : cur.chapter_id,
        moved,
        'exam_name' in b,
        plan ? JSON.stringify(plan) : null,
      ],
      cx,
    );
    // Chapters belong to a class and subject: drafts drop the old ones and are matched again.
    if (moved) await cx.query(`update paper_drafts set chapter_id = null where paper_id = $1 and status = 'draft'`, [id]);
    await fillChapters(id, cx);
    if (classLevel != null && subjectId) await ensureGroup(T, classLevel, subjectId, cx);
    return row;
  });
  const row = await q1(`select ${PAPER_COLS} from papers p where p.id = $1`, [p.id]);
  return c.json({ paper: { ...row, missing: missingOf(row) } });
});

// ---------------------------------------------------------------- AI: the paper's details

type Found = { value: unknown; confidence: number };

/** Every class, subject and chapter of the tuition, for AI to place a paper among. */
async function catalogue(T: string) {
  const subjects = await tq<{ id: string; name: string }>(
    T,
    'select sj.id, sj.name from subjects sj join tuition_subjects ts on ts.subject_id = sj.id and ts.tuition_id = @T order by sj.sort_order, sj.name',
  );
  const chapters = await tq<{ id: string; class_level: number; subject_id: string; name: string }>(
    T,
    'select id, class_level, subject_id, name from chapters where tuition_id = @T order by class_level, subject_id, sort_order, name',
  );
  const lines: string[] = [];
  const named = new Map((await customLevels(T)).map((l) => [l.code, l.label]));
  for (const cls of [...new Set(chapters.map((ch) => ch.class_level))].sort((x, y) => x - y)) {
    for (const s of subjects) {
      const names = chapters.filter((ch) => ch.class_level === cls && ch.subject_id === s.id).map((ch) => ch.name);
      if (names.length) lines.push(`${named.get(cls) ?? `Class ${cls}`} ${s.name}: ${names.join('; ')}`);
    }
  }
  return { subjects, chapters, lines };
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Reads the first page and fills in the details AI is sure of. Details already set stay. */
paperRoutes.post('/papers/:id/detect', async (c) => {
  const T = tuitionOf(c).id;
  const id = uuid(c.req.param('id'), 'paper id');
  const p = await tq1(T, 'select * from papers where id = $1 and tuition_id = @T', [id]);
  if (!p) throw notFound('This paper');
  const page = await q1('select * from paper_pages where paper_id = $1 and uploaded order by page_no limit 1', [id]);
  if (!page) throw new HttpError(409, 'not_uploaded', 'The pages have not finished uploading.');
  const { subjects, chapters, lines } = await catalogue(T);
  const categories = (await tq<{ name: string }>(T, CATEGORIES)).map((r) => r.name);

  const img = await readPageImage(page.object_key);
  const { content } = await chat({
    task: 'detect_paper',
    userId: c.get('user').id,
    tuitionId: T,
    models: VISION_MODELS,
    json: true,
    maxTokens: 800,
    messages: [
      { role: 'system', content: 'You look at the first page of a school question paper or worksheet and report its details as JSON.' },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `This is the first page of a question paper, worksheet or set of questions that a CBSE tuition teacher photographed.
Report its details as JSON:
{"exam_name":"<short name>","class_level":<1 to 12, or null>,"subject":"<subject>","printed_subject":"<subject as printed>","category":"<source>","chapter":"<chapter>",
 "confidence":{"exam_name":0.0,"class_level":0.0,"subject":0.0,"category":0.0,"chapter":0.0}}
Rules:
- exam_name: a short name from the title printed on this page, leaving out the board, class, subject and year, which have their own fields: a printed "Half Yearly Examination 2025 Mathematics" becomes "Half-yearly exam". If no title is printed, name it in a few words from its questions, e.g. "Life processes worksheet". These examples only show the form; never copy one. At most 40 characters.
- class_level and subject: as printed; otherwise only if the questions make them certain.
- The paper may be in English, Hindi or Tamil. Give subject, class_level and chapter in the English forms listed here, matching by meaning: गणित and கணிதம் are Maths; विज्ञान and அறிவியல் are Science. exam_name follows the title in the language it is printed.
- subject must be one of: ${subjects.map((s) => JSON.stringify(s.name)).join(', ')}. Physics, Chemistry and Biology are Science; Mathematics is Maths.
- printed_subject: the subject as printed, even when it is not in that list (e.g. "Social Science"); "" when none is printed.
- category: where the questions come from, e.g. "NCERT Exemplar", "NCERT textbook", "CBSE sample paper", "Previous year paper", "School test", "Worksheet". Reuse one of these names when it fits: ${categories.length ? categories.map((x) => JSON.stringify(x)).join(', ') : '(none yet)'}.
- chapter: only when the whole page is about one chapter, and it must be one of the chapters listed for that class and subject:
${lines.join('\n')}
- confidence: how sure you are of each answer, from 0 to 1. Use "" or null with 0 when you cannot tell. Never guess.`,
          },
          { type: 'image_url', image_url: { url: `data:${img.type};base64,${img.bytes.toString('base64')}` } },
        ],
      },
    ],
  });

  let r: Record<string, any>;
  try {
    r = parseJson<Record<string, any>>(content);
  } catch {
    throw new HttpError(502, 'ai_unreadable', 'AI could not make out this paper. Fill in its details below.');
  }
  const cf = (k: string) => conf(r.confidence?.[k]);
  const found: Record<string, Found> = {};

  const name = clip(r.exam_name, 80);
  if (name && cf('exam_name') >= 0.3) found.exam_name = { value: name, confidence: cf('exam_name') };

  const cls = Number(r.class_level);
  if (isClassNumber(cls) && cf('class_level') >= 0.8) found.class_level = { value: cls, confidence: cf('class_level') };

  const subject = subjects.find((s) => same(s.name, clip(r.subject, 40)));
  if (subject && cf('subject') >= 0.8) found.subject_id = { value: subject.id, confidence: cf('subject') };
  // A printed subject the teacher has not added yet (Social Science): the app offers to add it.
  const printed = clip(r.printed_subject, 40);
  if (!found.subject_id && printed && !subjects.some((s) => same(s.name, printed))) found.new_subject = { value: printed, confidence: cf('subject') };

  const category = clip(r.category, 60);
  if (category && cf('category') >= 0.8) {
    found.category = { value: categories.find((x) => same(x, category)) ?? category, confidence: cf('category') };
  }

  const finalClass = p.class_level ?? (found.class_level?.value as number | undefined);
  const finalSubject = p.subject_id ?? (found.subject_id?.value as string | undefined);
  const chapter = chapters.find(
    (ch) => ch.class_level === finalClass && ch.subject_id === finalSubject && same(ch.name, clip(r.chapter, 120)),
  );
  if (chapter && cf('chapter') >= 0.8) found.chapter_id = { value: chapter.id, confidence: cf('chapter') };

  // A course's paper has no class, subject or chapter: only its name and category are filled in.
  if (p.course_id) {
    delete found.class_level;
    delete found.subject_id;
    delete found.new_subject;
    delete found.chapter_id;
  }

  // Only empty details are filled: anything the teacher already chose stays.
  await pool.query(
    `update papers set exam_name = case when (name_auto or exam_name = $2) and $3::text is not null then $3 else exam_name end,
                       name_auto = case when (name_auto or exam_name = $2) and $3::text is not null then false else name_auto end,
                       class_level = coalesce(class_level, $4), subject_id = coalesce(subject_id, $5),
                       category = coalesce(category, $6), chapter_id = coalesce(chapter_id, $7), ai_details = $8
      where id = $1`,
    [id, UNNAMED, found.exam_name?.value ?? null, found.class_level?.value ?? null, found.subject_id?.value ?? null,
      found.category?.value ?? null, found.chapter_id?.value ?? null, JSON.stringify(found)],
  );
  const row = await q1(`select ${PAPER_COLS} from papers p where p.id = $1`, [id]);
  return c.json({ paper: { ...row, missing: missingOf(row) }, found: Object.keys(found) });
});

// ---------------------------------------------------------------- AI: the questions on each page

type Extracted = {
  number?: unknown; kind?: unknown; text?: unknown; options?: unknown; needs_diagram?: unknown; chapter_guess?: unknown; printed_answer?: unknown;
  unclear?: unknown; question_box?: unknown; diagram_box?: unknown; continues_on_next_page?: unknown; continues_from_previous_page?: unknown;
  difficulty?: unknown;
};

/** A box AI leaves where the page itself cannot be read (some PDFs print ■ for every subscript). */
const BOX = '■';

/** What to call the paper when talking to AI about it. */
const paperWhat = (p: { study: string | null; subject: string | null }) => (p.study != null ? `a ${p.study}${p.subject ? ` ${p.subject}` : ''} question paper` : 'a CBSE question paper');

/** One question as a page read asks for it, with its boxes written in `box`'s order. */
const questionShape = (box: string) =>
  `{"number":"<question number as printed>","kind":"mcq", "other" or "passage","text":"<question text>","options":["<a>","<b>","<c>","<d>"],"needs_diagram":true or false,"diagram_box":${box} or null,"question_box":${box},"continues_on_next_page":true or false,"continues_from_previous_page":true or false,"unclear":true or false,"chapter_guess":"<chapter>","printed_answer":"<answer printed for it, or empty>","difficulty":"easy" or "medium" or "hard"}`;

const KEY_SHAPE = '{"number":"<question number>","answer":"<the option as printed, e.g. b>"}';

/**
 * The rules every page read shares, whether the request holds one page or a few (`many`, which words the few rules that speak of "this
 * page" for a request with several). The one-page words are what the page-by-page read has always sent: tools/read-bench/prompt-snapshot.mjs
 * shows them unchanged.
 */
function readRules(chapters: string[], order: BoxOrder, maxOptions: number, many: boolean) {
  // An app that can hold five or six options is told so; an older one is told what it always was (it has four slots).
  const mcqRule =
    maxOptions > MIN_OPTIONS
      ? '"mcq" only when four to six options are printed (nearly always four; some questions print five, (a) to (e)). Give the option text without its label, in printed order: the label may be (a)/(A)/(i)/(1) or, in Hindi and Tamil papers, (क)(ख)(ग)(घ)(ङ), (अ)(ब)(स)(द), (அ)(ஆ)(இ)(ஈ)(உ). Copy every option that is printed, never dropping one or adding one. Otherwise use "other" with "options": [].'
      : '"mcq" only when exactly four options are printed. Give the option text without its label, in printed order: the label may be (a)/(A)/(i)/(1) or, in Hindi and Tamil papers, (क)(ख)(ग)(घ), (अ)(ब)(स)(द), (அ)(ஆ)(இ)(ஈ). Otherwise use "other" with "options": [].';
  const picture = many ? 'the picture of the page the question is printed on' : 'the page picture';
  const boxRule =
    order === 'yx'
      ? `Boxes are [ymin, xmin, ymax, xmax] as whole numbers from 0 to 1000 across ${picture}: 0,0 is its top left corner and 1000,1000 its bottom right corner (ymin is the top edge, xmin the left edge, ymax the bottom edge, xmax the right edge).`
      : `Boxes are fractions of ${picture}: [x1, y1, x2, y2] with 0,0 at the top left corner and 1,1 at the bottom right corner (x1 is the left edge, y1 the top edge, x2 the right edge, y2 the bottom edge).`;
  const cutRule = many
    ? 'A question can be cut by the page edge. If the last question on a page goes on over the page, set continues_on_next_page to true and give only what is printed on that page. If a page starts with the rest of a question from the page before, such as its last options, give it as the first item of that page with "number": "", the text printed there (empty when there are only options), the options printed there (even when there are fewer than four) and continues_from_previous_page true. A page lists only what is printed on it: never copy a question onto a second page.'
    : 'A question can be cut by the page edge. If the last question on this page goes on over the page, set continues_on_next_page to true and give only what is printed here. If this page starts with the rest of a question from the page before, such as its last options, give it as one item with "number": "", the text printed there (empty when there are only options), the options printed there (even when there are fewer than four) and continues_from_previous_page true.';
  const keyRule = many
    ? 'The answer_key of a page is an answer key printed on that page, such as "Answers: 1. (b) 2. (c)" or "उत्तर: 1. (ख) 2. (ग)", in printed order; [] when it has none. A page may hold only an answer key.'
    : 'answer_key is an answer key printed on this page, such as "Answers: 1. (b) 2. (c)" or "उत्तर: 1. (ख) 2. (ग)", in printed order; [] when there is none. A page may hold only an answer key.';
  const blankRule = many ? 'If a page has no questions, give "questions": [] for it.' : 'If the page has no questions, return "questions": [].';
  // A passage printed alone at the foot of a page, for questions on the next: the server hands it on to them (see carryPassages). Asked
  // for as a field of the page, the reader never gave it (2026-11-15, 36 real papers); as an item of the list it does.
  const footRule = many
    ? 'A passage, case study or set of facts printed at the end of a page whose questions all come on the next page is not a question: give it as the last item of that page, with "kind": "passage", "number": "", the passage copied exactly as its "text" and "options": [] (when the next page is one of these, start each of its questions there with it, as above). Use "passage" for nothing else.'
    : 'A passage, case study or set of facts printed at the end of this page whose questions all come on the next page is not a question: give it as the last item, with "kind": "passage", "number": "", the passage copied exactly as its "text" and "options": []. Use "passage" for nothing else.';
  return `- Copy the wording exactly. Write all maths, formulas and chemical equations in LaTeX inside $...$, e.g. $\\frac{3}{4}$, $x^2$, $\\sqrt{2}$, $90^\\circ$, $H_2O$.
- "text" is the question itself, without its number or label: leave out "1.", "Q1", "Question 1", "प्रश्न 1" and "வினா 1" (the number goes in "number").
- The paper may be in English, Hindi or Tamil, or mix them (maths terms in English inside Hindi or Tamil sentences). Transcribe each line in the language and script it is printed in: never translate, transliterate or correct it. Write every number with the digits 0 to 9, even when the page prints Hindi or Tamil digits (१२ and ௧௨ are 12).
- Some pages cannot be read in places: smudged, cut off, or printed as boxes such as ${BOX} (a PDF can show every subscript that way). Each box stands for exactly one missing character, so "t${BOX}${BOX}${BOX}" had three, such as "n+1". Restore a box only when the question's own formula or wording forces it: "t${BOX} = 3n - 4" can only be $t_n = 3n - 4$, and "t${BOX} = 7 and t${BOX}${BOX}${BOX} = 2t${BOX}" is $t_1 = 7$ and $t_{n+1} = 2t_n$. Never pick a number, letter or sign that nothing forces: "t${BOX} - t${BOX}" stays "$t_${BOX} - t_${BOX}$", because nothing says which terms. Set "unclear": true for every question where you filled anything in or kept a ${BOX}.
- ${mcqRule}
- A table printed with a question (words, numbers or formulas set out in rows and columns) is part of its text: copy it into "text" where it is printed, as a heading row, a line of dashes, then one row a line, every cell between | marks, e.g. "| Outcome | Frequency |\\n|---|---|\\n| 1 | 10 |". Copy every row and cell exactly, and only into the question it is printed with. A figure, circuit, graph or diagram is never a table: never write one with | marks.
- A passage, case study or set of facts printed once for a group of questions (such as "Read the passage and answer the questions that follow", "Case Study 2: ..." or "Answer questions 16 to 20 using the information below") belongs to each question of the group: start every one of their "text" with that passage, copied exactly, then a blank line, then the question itself, so each can be answered on its own. A key of answer choices printed for a group (such as an Assertion and Reason key) is not a passage.
- ${footRule}
- needs_diagram answers one question: could a student who sees only the "text" and "options" you give (with any table copied into them) still work out the answer? If yes, it is false, even when a figure is printed with the question or the question says "in the figure": "In the figure, AB = 5 cm, BC = 12 cm and angle B = 90°. Find AC." is false, because the words give every length it needs. If no, because the answer depends on something only a figure, graph or diagram shows (a point, angle, length or label such as x or 1 to 4 that the words never define, values read off a graph, or which picture is right), it is true, even when that figure is not printed on the page.
- ${boxRule}
- question_box covers the whole question as printed: its number, text, figure and options.
- diagram_box covers only the figure, graph or diagram printed for the question, with its labels. It never includes the question text, a table or the options. Give it whenever one is printed for the question, even when needs_diagram is false; use null when none is printed.
- ${cutRule}
- chapter_guess must be one of: ${chapters.length ? chapters.map((n) => JSON.stringify(n)).join(', ') : '(none listed, so name the chapter or topic in a few words)'}; use "" if unsure.
- Do not solve anything. printed_answer is only an answer the page itself gives for that question: "Ans: (b)", "उत्तर: (ख)", "விடை: ஆ", a ticked or circled option, or the answer written under it. Otherwise "". Give it as printed, e.g. b, 2, ख or ஆ.
- ${keyRule}
- difficulty is a quick guess at how hard the question is for a student at that level: "easy" for a fact or one step, "medium" for a few steps, "hard" for many steps or a trap. Always give one of the three, and "medium" when you cannot tell. Judge it from the question as printed, without solving it, and never let it change what you transcribe.
- Skip instructions, section headings and marks notes.
- ${blankRule}`;
}

/** The page's number is the one thing a one-page prompt must say; the box order is how its model writes boxes (see BoxOrder). */
export function readPrompt(p: { study: string | null; subject: string | null }, pageNo: number, chapters: string[], order: BoxOrder = 'xy', maxOptions = MIN_OPTIONS) {
  const what = paperWhat(p);
  // Gemini places boxes best in the order it is trained on (top, left, bottom, right, from 0 to 1000); the other models get the plain one.
  const box = order === 'yx' ? '[ymin,xmin,ymax,xmax]' : '[x1,y1,x2,y2]';
  return `This image is page ${pageNo} of ${what}.
Transcribe every question printed on this page, in order, and any answer key printed on it, as JSON:
{"questions":[${questionShape(box)}],
 "answer_key":[${KEY_SHAPE}]}
Rules:
${readRules(chapters, order, maxOptions, false)}`;
}

/** "3", "3 and 4", "3, 4 and 5". */
const listOf = (nos: number[]) => (nos.length < 2 ? nos.join('') : `${nos.slice(0, -1).join(', ')} and ${nos[nos.length - 1]}`);

/** The same reading for a request that holds several pages, each shown after a line that names it. */
export function windowPrompt(p: { study: string | null; subject: string | null }, pageNos: number[], chapters: string[], order: BoxOrder = 'yx', maxOptions = MIN_OPTIONS) {
  const box = order === 'yx' ? '[ymin,xmin,ymax,xmax]' : '[x1,y1,x2,y2]';
  return `These images are pages ${listOf(pageNos)} of ${paperWhat(p)}, in that order, each after a line that names it.
Transcribe every question printed on them, page by page and in order, and any answer key printed on them, as JSON:
{"pages":[{"page":<the page's number>,"questions":[${questionShape(box)}],
 "answer_key":[${KEY_SHAPE}]}]}
Rules:
- Give one entry in "pages" for each image, in the order given, with the number of the page it shows.
- Questions that share their choices, such as Assertion and Reason questions whose key ("choose the appropriate answer using the following key": (a) to (d) or (e)) is printed once above them, even on the page before: give every one of those questions all the options of that key, as "kind": "mcq". Never leave such a question without its options. A key covers only the questions it names ("For Questions 25-26" covers 25 and 26), and a question printed before a key belongs to the key above it, which may be on the page before: use the options of that key, not of the next one.
${readRules(chapters, order, maxOptions, true)}`;
}

/**
 * Which option the test writer says is right. It is asked to copy the option's text, which models do far
 * more reliably than naming a letter; a bare letter is still understood. Null when it cannot be told (the
 * text matches no option, or two the same), and the question then goes on without the writer's opinion.
 */
export function writerAnswer(raw: unknown, options: string[]): number | null {
  const s = asciiDigits(String(raw ?? '')).trim();
  if (!s) return null;
  const norm = (x: string) => asciiDigits(x).toLowerCase().replace(/[\s$\\{}]/g, '');
  const hits = options.map((o, i) => (norm(o) === norm(s) ? i : -1)).filter((i) => i >= 0);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return null;
  const letter = /^\(?([A-Fa-f])\)?[.:]?$/.exec(s);
  const at = letter ? letter[1].toUpperCase().charCodeAt(0) - 65 : null;
  return at != null && at < options.length ? at : null;
}

/**
 * The option an answer means: a letter, a number, i to iv, a Hindi or Tamil label ((ख), (ஆ)), or the
 * option's own text. Hindi and Tamil digits count as 0 to 9.
 */
export function answerIndex(raw: unknown, options: string[]): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  let s = asciiDigits(String(raw)).trim().toLowerCase();
  if (!s) return null;
  s = s
    .replace(/^(ans(wer)?|option|opt|सही उत्तर|उत्तर|विकल्प|சரியான விடை|விடை|பதில்)\s*[:.\-]?\s*/, '')
    .replace(/^[([{]\s*|\s*[)\]}.]+$/g, '')
    .trim();
  // A label that names an option the question has. One past the last (a "(e)" answer on a question of four) is no option, and the
  // text is tried instead, as it was before questions could have more than four.
  const roman = ['i', 'ii', 'iii', 'iv', 'v', 'vi'].indexOf(s);
  const byLabel = /^[a-f]$/.test(s) ? s.charCodeAt(0) - 97 : /^[1-6]$/.test(s) ? Number(s) - 1 : roman >= 0 ? roman : indicLabelIndex(s);
  if (byLabel != null && byLabel < options.length) return byLabel;
  const norm = (x: string) => asciiDigits(x).toLowerCase().replace(/[\s$\\{}]/g, '');
  const hits = options.map((o, i) => (norm(o) === norm(s) ? i : -1)).filter((i) => i >= 0);
  return hits.length === 1 ? hits[0] : null;
}

/** "Q 12.", "12)", "(12)", "प्र. 12" and "வினா ௧௨" are all question 12. */
const numberKey = (v: unknown) => asciiDigits(String(v ?? '')).toLowerCase().replace(/^q(uestion)?\s*/, '').replace(/[^0-9a-z]/g, '').replace(/^0+(?=\d)/, '');

/**
 * A question and its options without spacing, punctuation or LaTeX commands, so the same question
 * read twice ("$18$ seats" and "18 seats") compares equal. Letters of every script count: keeping
 * only a to z would make every Hindi or Tamil question without digits equal to every other one.
 */
export const sameKey = (text: string, options: string[] | null) =>
  asciiDigits([text, ...(options ?? [])].join('|')).toLowerCase().replace(/\\[a-z]+/g, '').replace(/[^\p{L}\p{M}\p{N}|]/gu, '');

/**
 * Skips each draft that repeats an earlier one of the same paper, as when a PDF holds its pages
 * twice. A saved copy, else the first one in the paper, is the one kept.
 */
async function skipRepeats(paperId: string, db: Db) {
  const drafts = await q<{ id: string; text: string; options: string[] | null; status: string }>(
    `select id, text, options, status from paper_drafts where paper_id = $1 and status in ('draft', 'saved')
      order by status = 'saved' desc, page_no, seq`,
    [paperId],
    db,
  );
  const first = new Map<string, string>();
  for (const d of drafts) {
    const k = sameKey(d.text, d.options);
    const kept = first.get(k);
    if (!kept) first.set(k, d.id);
    else if (d.status === 'draft') {
      await db.query(`update paper_drafts set status = 'discarded', ai_note = 'duplicate', duplicate_of = $2 where id = $1`, [d.id, kept]);
    }
  }
}

/** A page's picture, read into memory. One that has grown past the limit since it was checked is deleted. */
async function readPageImage(key: string) {
  try {
    return await readObject(key);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('The stored file is larger')) {
      await deleteObjects([key]).catch(() => {});
      throw new HttpError(413, 'too_big', 'That picture is too big. Use one under 15 MB.');
    }
    throw e;
  }
}

/**
 * Reads one page with each vision model in turn until one gives a usable reply: JSON with a list of
 * questions or an answer key. A reply with nothing on it is confirmed by the next model before the page
 * is believed to be blank. Throws the last failure when no model could read it.
 */
/** Gemini writes boxes in its own order (top, left, bottom, right, from 0 to 1000); the other models are asked for the plain one. */
const boxOrder = (model: string): BoxOrder => (isGemini(model) ? 'yx' : 'xy');

/** The answer key a page read gave, as {number, answer} pairs a person could have printed. */
const cleanKey = (raw: unknown): { number: string; answer: string }[] =>
  (Array.isArray(raw) ? raw : [])
    .map((k: any) => ({ number: clip(k?.number, 20), answer: clip(String(k?.answer ?? ''), 200) }))
    .filter((k) => k.number && k.answer)
    .slice(0, 200);

async function readPageWithAI(T: string, userId: string, promptFor: (order: BoxOrder) => string, dataUrl: string) {
  type Read = { items: Extracted[]; key: { number: string; answer: string }[]; order: BoxOrder };
  let lastError: unknown = null;
  let empty: Read | null = null;
  for (const model of VISION_MODELS) {
    let content: string;
    try {
      ({ content } = await chat({
        task: 'read_paper_page',
        userId,
        tuitionId: T,
        models: [model],
        json: true,
        // A page takes about 400 tokens and a dense one a few thousand (Hindi and Tamil several times more); Groq counts what is asked for.
        maxTokens: isGemini(model) ? 6000 : 3000,
        messages: [
          { role: 'system', content: 'You transcribe printed exam papers into JSON. You never solve questions; you only copy answers the paper prints.' },
          { role: 'user', content: [{ type: 'text', text: promptFor(boxOrder(model)) }, { type: 'image_url', image_url: { url: dataUrl } }] },
        ],
      }));
    } catch (e) {
      lastError = e;
      continue;
    }
    let whole: unknown;
    try {
      whole = parseJson<unknown>(content);
    } catch {
      lastError = new Error('The reply was not JSON.');
      continue;
    }
    const list = listIn(content, 'questions') as Extracted[];
    if (!list.length && !(whole && typeof whole === 'object' && 'questions' in (whole as object))) {
      lastError = new Error('The reply had no questions list.');
      continue;
    }
    const key = cleanKey((whole as { answer_key?: unknown })?.answer_key);
    const read: Read = { items: list.slice(0, 60), key, order: boxOrder(model) };
    if (read.items.length || read.key.length) return read;
    empty = read;
  }
  if (empty) return empty;
  throw lastError ?? new Error('No model could read this page.');
}

/**
 * Assertion and Reason questions print their choices once, in a key above the group ("For Questions 15-17, choose the appropriate
 * answer using the following key"), and no question repeats them. The page read sometimes copies the key onto each question and
 * sometimes does not (a weaker model, a page where it skips what is not a question), and a question with no options is never
 * answered. So when the read leaves Assertion and Reason questions without options, the page is looked at once more with one small
 * question: what key does it print? An ordinary page never gets this look, so it is read exactly as before. When the page has no key,
 * the page before is shown too, because a group can run over the page edge.
 */
export function keyPrompt(p: { study: string | null; subject: string | null }, pageNo: number, numbers: string[], withPrevious: boolean) {
  const pages = withPrevious ? `These images are page ${pageNo - 1} and page ${pageNo} of ${paperWhat(p)}, in that order.` : `This image is page ${pageNo} of ${paperWhat(p)}.`;
  return `${pages}
Questions ${numbers.join(', ')} on page ${pageNo} are Assertion and Reason questions. Such questions print their answer choices once, in a key above or between them, for example "For Questions 15-17, choose the appropriate answer using the following key:" followed by (a), (b), (c), (d). Find the key that covers them${withPrevious ? ' (it may be printed on either page)' : ''} as JSON:
{"shared":[{"from":"<first question number it covers>","to":"<last question number it covers, or empty when it covers every question after it>","options":["<option>","<option>","<option>","<option>"]}]}
Rules:
- "options" are all of the key's options in printed order, without their labels: the label may be (a)/(A)/(i)/(1) or, in Hindi and Tamil papers, (क)(ख)(ग)(घ)(ङ), (अ)(ब)(स)(द), (அ)(ஆ)(இ)(ஈ)(உ). Copy every one, however many the key prints (usually four, sometimes five): never drop one and never add one.
- Copy the wording exactly, in the language and script it is printed in. Write every number with the digits 0 to 9, and maths in LaTeX inside $...$.
- Only a key that is printed. If there is none, return {"shared":[]}. Never write a key from what you know of Assertion and Reason questions.`;
}

/** The key a page prints for its Assertion and Reason questions, or [] when AI finds none. A bonus: it is cut off at [deadline]. */
async function readKeyWithAI(T: string, userId: string, prompt: string, dataUrls: string[], deadline: number): Promise<Shared[]> {
  for (const model of VISION_MODELS) {
    if (deadline - Date.now() < 3000) break;
    try {
      const { content } = await chat({
        task: 'read_paper_page',
        userId,
        tuitionId: T,
        models: [model],
        json: true,
        maxTokens: isGemini(model) ? 2000 : 1500,
        deadline,
        messages: [
          { role: 'system', content: 'You transcribe printed exam papers into JSON. You never solve questions; you only copy what the paper prints.' },
          { role: 'user', content: [{ type: 'text', text: prompt }, ...dataUrls.map((url) => ({ type: 'image_url' as const, image_url: { url } }))] },
        ],
      });
      const found = cleanShared((parseJson<unknown>(content) as { shared?: unknown } | null)?.shared);
      if (found.length) return found;
    } catch {
      // This model could not say; the next one may.
    }
  }
  return [];
}

/** The page's questions, with the printed key given to any Assertion and Reason questions the read left without options (see keyPrompt). */
export async function withPrintedKeys(
  T: string,
  userId: string,
  info: { study: string | null; subject: string | null },
  pageNo: number,
  items: Extracted[],
  dataUrl: string,
  previousKey: string | null,
  maxOptions = MIN_OPTIONS,
): Promise<Extracted[]> {
  try {
    const wanting = wantingKey(items);
    if (!wanting.length) return items;
    // A bonus on top of the read: it never holds the page up for long.
    const deadline = Date.now() + 25_000;
    let shared = await readKeyWithAI(T, userId, keyPrompt(info, pageNo, wanting, false), [dataUrl], deadline);
    if (!shared.length && previousKey) {
      // A group can run over the page edge, with its key on the page before.
      const before = await readObject(previousKey);
      shared = await readKeyWithAI(T, userId, keyPrompt(info, pageNo, wanting, true), [`data:${before.type};base64,${before.bytes.toString('base64')}`, dataUrl], deadline);
    }
    return applyShared(items, shared, maxOptions).items;
  } catch {
    // The questions stay as the read gave them, for the tutor to finish.
    return items;
  }
}

/** "9", "9 and 10", "9, 10 and 11". */
const namesOf = (labels: string[]) => (labels.length < 2 ? labels.join('') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`);

/**
 * A second look at questions a page read gave no choices, on a page that is mostly multiple choice (see lib/second-look.ts): each is
 * read again on its own, its words and its choices. [tails] gives, by printed number, the words the first read ended each question
 * with: a question that starts at the foot of one column can end at the top of the next, its choices with it, and without being told
 * where the question ended the look stops at the foot of the column and says it prints no choices (paper de3ccf0f, 2026-11-16).
 */
export function choicesPrompt(
  p: { study: string | null; subject: string | null },
  pageNo: number,
  numbers: string[],
  maxOptions = MIN_OPTIONS,
  tails?: Record<string, string>,
) {
  const many = numbers.length > 1;
  const count = maxOptions > MIN_OPTIONS ? 'four to six choices (nearly always four; some questions print five, (a) to (e))' : 'four choices';
  const ends = numbers.filter((n) => tails?.[n]).map((n) => `- Question ${n}: its words end "${tails![n]}"`);
  return `This image is page ${pageNo} of ${paperWhat(p)}.
A first reading of this page gave question${many ? 's' : ''} ${namesOf(numbers)} no answer choices. Read ${many ? 'each of them' : 'it'} again, on its own, as JSON:
{"questions":[{"number":"<question number as printed>","text":"<question text>","options":["<a>","<b>","<c>","<d>"]}]}
${ends.length ? `Where the first reading found ${many ? 'each' : 'the'} question's last words:\n${ends.join('\n')}\nAny choices a question prints come right after its last words. A question can start at the foot of one column and end at the top of the next column, with its last words and its choices there.\n` : ''}Rules:
- Give only the question${many ? 's' : ''} named above, in printed order.
- "text" is the question itself, copied exactly, without its number: with any passage printed for its group at its start (then a blank line), and any table printed with it as rows between | marks (a heading row, a line of dashes, then one row a line).
- "options" are the answer choices printed for that question, in printed order, without their labels: the label may be (a)/(A)/(i)/(1) or, in Hindi and Tamil papers, (क)(ख)(ग)(घ)(ङ), (अ)(ब)(स)(द), (அ)(ஆ)(இ)(ஈ)(உ). A multiple-choice question prints ${count}. They can sit beside, under or after the question, in one or two columns, and at a slant on a photographed page: take only the ones printed for this question, never another question's.
- If the question prints no choices (it is answered in words), give "options": [].
- Copy the wording exactly, in the language and script it is printed in. Write every number with the digits 0 to 9, and maths in LaTeX inside $...$.
- Do not solve anything.`;
}

/** The questions a second look read again, or [] when AI could not say. A bonus on top of the read: it is cut off at [deadline]. */
async function rereadWithAI(T: string, userId: string, prompt: string, dataUrl: string, deadline: number): Promise<Reread[]> {
  for (const model of VISION_MODELS) {
    if (deadline - Date.now() < 3000) break;
    try {
      const { content } = await chat({
        task: 'read_paper_page',
        userId,
        tuitionId: T,
        models: [model],
        json: true,
        maxTokens: isGemini(model) ? 3000 : 2000,
        deadline,
        messages: [
          { role: 'system', content: 'You transcribe printed exam papers into JSON. You never solve questions; you only copy what the paper prints.' },
          { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl } }] },
        ],
      });
      const found = cleanRereads(listIn(content, 'questions'));
      if (found.length) return found;
    } catch {
      // This model could not say; the next one may.
    }
  }
  return [];
}

/** The page's questions, with the choices a second look found for questions the read left without them (see lib/second-look.ts). */
export async function withLostChoices(
  T: string,
  userId: string,
  info: { study: string | null; subject: string | null },
  pageNo: number,
  items: Extracted[],
  dataUrl: string,
  maxOptions = MIN_OPTIONS,
): Promise<Extracted[]> {
  try {
    const lost = lostChoices(items);
    if (!lost.length) return items;
    const prompt = choicesPrompt(info, pageNo, lost, maxOptions, lastWordsOf(items, lost));
    const rereads = await rereadWithAI(T, userId, prompt, dataUrl, Date.now() + 25_000);
    return applyRereads(items, rereads, maxOptions).items;
  } catch {
    // The questions stay as the read gave them, for the tutor to finish.
    return items;
  }
}

// ---------------------------------------------------------------- questions that run over a page edge

type JoinRow = {
  id: string; page_no: number; seq: number; status: string; number_label: string | null; kind: 'mcq' | 'other'; text: string;
  options: string[] | null; needs_diagram: boolean; ai_note: string | null; answer_checked: boolean; question_boxes: Placed[] | null;
  figure_box: Placed | null; cont_next: boolean; cont_prev: boolean; keep_apart: boolean; chapter_id: string | null; ai_chapter_guess: string | null;
};

const JOIN_COLS = `id, page_no, seq, status, number_label, kind, text, options, needs_diagram, ai_note, answer_checked, question_boxes, figure_box,
  cont_next, cont_prev, keep_apart, chapter_id, ai_chapter_guess`;

const asJson = (v: unknown) => (v == null ? null : JSON.stringify(v));

const partOf = (r: JoinRow): Part => ({
  number_label: r.number_label, kind: r.kind, text: r.text, options: r.options ?? [], needs_diagram: r.needs_diagram, unclear: r.ai_note === 'unclear',
  question_boxes: r.question_boxes, figure_box: r.figure_box, cont_next: r.cont_next, cont_prev: r.cont_prev,
});

/** What a join changes in a draft, kept in joined_from so the join can be undone. */
const fieldsOf = (r: JoinRow) => ({
  number_label: r.number_label, kind: r.kind, text: r.text, options: r.options ?? [], needs_diagram: r.needs_diagram, ai_note: r.ai_note,
  answer_checked: r.answer_checked, question_boxes: r.question_boxes, figure_box: r.figure_box, cont_next: r.cont_next, cont_prev: r.cont_prev,
});
type Fields = ReturnType<typeof fieldsOf>;
type Snapshot = { before: Fields; part: Fields & { page_no: number; seq: number; chapter_id: string | null; ai_chapter_guess: string | null } };

/** Held for the length of the transaction: the pass that joins questions and the page reads take it so they never overlap. */
const lockPaper = (cx: Db, paperId: string) => cx.query('select pg_advisory_xact_lock(hashtext($1))', [`join:${paperId}`]);

/** Puts `rest` (the next page's first item) onto `first` (the last question of the page before) and deletes `rest`. False when they cannot be one. */
async function mergeRows(first: JoinRow, rest: JoinRow, cx: Db, max: number) {
  const merged = joinParts(partOf(first), partOf(rest), max);
  if (!merged) return false;
  if (!(await q1('delete from paper_drafts where id = $1 returning id', [rest.id], cx))) return false;
  const snapshot: Snapshot = {
    before: fieldsOf(first),
    part: { ...fieldsOf(rest), page_no: rest.page_no, seq: rest.seq, chapter_id: rest.chapter_id, ai_chapter_guess: rest.ai_chapter_guess },
  };
  await cx.query(
    `update paper_drafts set text = $2, options = $3, kind = $4, needs_diagram = $5, question_boxes = $6::jsonb, figure_box = $7::jsonb,
                             cont_next = $8, joined = true, joined_from = $9::jsonb,
                             ai_note = case when $10::boolean then 'unclear' else null end,
                             answer_checked = correct_option is not null or $10::boolean
      where id = $1`,
    [first.id, merged.text, merged.options, merged.kind, merged.needs_diagram, asJson(merged.question_boxes), asJson(merged.figure_box), merged.cont_next,
      JSON.stringify(snapshot), merged.unclear],
  );
  // The row goes on as the question, so a third page of the same question can join it too.
  Object.assign(first, { text: merged.text, options: merged.options, kind: merged.kind, needs_diagram: merged.needs_diagram,
    question_boxes: merged.question_boxes, figure_box: merged.figure_box, cont_next: merged.cont_next, ai_note: merged.unclear ? 'unclear' : null });
  return true;
}

/** The longest text a question may hold, as a page read and the tutor's edits both keep to. */
const MAX_QUESTION_CHARS = 4000;

/**
 * A passage, case study or set of facts printed on one page can serve questions at the top of the next: a case study whose last
 * question is on the next page, or a passage printed alone at the foot of a page with all its questions after it. Once both pages
 * are read, the passage is put in front of each such question, as the reader does for questions printed under their passage, so each
 * can be answered on its own (which questions: carryPlan in lib/passages.ts). A question given it is marked (passage_prev) so it is
 * never given it twice, and goes back to the checks: one held as unclear for want of it, or that AI could not settle without it, is
 * looked at again with it. Questions on a page whose page before is still being read wait for it (see /papers/:id/answers). Safe to run
 * again and again. The caller holds a transaction.
 */
async function carryPassages(paperId: string, cx: Db) {
  const pages = await q<{ page_no: number; ai_status: string; passage_end: string | null }>(
    'select page_no, ai_status, passage_end from paper_pages where paper_id = $1',
    [paperId],
    cx,
  );
  const done = new Map(pages.filter((p) => p.ai_status === 'done').map((p) => [p.page_no, p]));
  const rows = await q<{
    id: string; page_no: number; number_label: string | null; text: string; status: string; cont_prev: boolean; ai_note: string | null;
    needs_diagram: boolean; edited: boolean; correct_option: number | null; passage_prev: boolean;
  }>(
    `select id, page_no, number_label, text, status, cont_prev, ai_note, needs_diagram, edited, correct_option, passage_prev
       from paper_drafts where paper_id = $1 and status in ('draft', 'saved') order by page_no, seq`,
    [paperId],
    cx,
  );
  const byPage = new Map<number, typeof rows>();
  for (const r of rows) byPage.set(r.page_no, [...(byPage.get(r.page_no) ?? []), r]);
  for (const [n, here] of byPage) {
    const before = done.get(n - 1);
    // Both pages must be read, and a page is handed its passage once (reading it again makes new drafts, which start unmarked).
    if (!before || !done.has(n) || here.some((d) => d.passage_prev)) continue;
    const plan = carryPlan(
      before.passage_end,
      (byPage.get(n - 1) ?? []).map((d) => ({ label: d.number_label, text: d.text })),
      here.map((d) => ({
        label: d.number_label,
        text: d.text,
        contPrev: d.cont_prev,
        wanting: d.ai_note === 'unclear' || d.needs_diagram,
        // A question the tutor changed, saved or marked is hers.
        edited: d.edited || d.status !== 'draft' || d.correct_option != null,
      })),
    );
    if (!plan) continue;
    for (const i of plan.give) {
      const d = here[i];
      const text = `${plan.passage}\n\n${d.text}`;
      if (text.length > MAX_QUESTION_CHARS) continue;
      // Back to the checks with its passage, unless part of it still cannot be read (a box in it) or it is half of a cut question.
      await cx.query(
        `update paper_drafts set text = $2, passage_prev = true,
                answer_checked = case when cont_next or cont_prev or position($3 in $2) > 0 then answer_checked else false end,
                ai_note = case when cont_next or cont_prev or position($3 in $2) > 0 then ai_note else null end,
                ai_picks = null, ai_votes = null, ai_confidence = null, answer_claimed_at = null, answer_tries = 0
          where id = $1 and status = 'draft' and correct_option is null and not edited`,
        [d.id, text, BOX],
      );
    }
  }
}

/**
 * Puts back together each question that ran over a page edge: the last question of a page that goes on, and the next page's
 * first item, which is the rest of it. Safe to run again and again: it does only what is not yet done, and it waits for a page
 * that has not been read yet. A cut question or a rest with no partner once the neighbouring page has been read is held for the
 * tutor ("unclear"), with its picture to check it against. The caller holds a transaction.
 */
async function joinSplits(paperId: string, cx: Db, max = MIN_OPTIONS) {
  await lockPaper(cx, paperId);
  const pages = new Map(
    (await q<{ page_no: number; ai_status: string }>('select page_no, ai_status from paper_pages where paper_id = $1', [paperId], cx)).map((p) => [p.page_no, p.ai_status]),
  );
  const rows = await q<JoinRow>(`select ${JOIN_COLS} from paper_drafts where paper_id = $1 order by page_no, seq`, [paperId], cx);
  const byPage = new Map<number, JoinRow[]>();
  for (const r of rows) byPage.set(r.page_no, [...(byPage.get(r.page_no) ?? []), r]);
  // The row that ends each page, as joins change it.
  const tail = new Map<number, JoinRow>([...byPage].map(([n, list]) => [n, list[list.length - 1]]));
  // No page, or a page that was read, has nothing more to say about a question next to it.
  const settled = (n: number) => !pages.has(n) || pages.get(n) === 'done';
  const hold = (r: JoinRow) =>
    cx.query(`update paper_drafts set ai_note = 'unclear', answer_checked = true where id = $1 and status = 'draft' and ai_note is null`, [r.id]);

  for (const n of [...byPage.keys()].sort((a, b) => a - b)) {
    const list = byPage.get(n)!;
    const rest = list[0];
    if (rest.status !== 'draft' || !rest.cont_prev || rest.keep_apart) continue;
    const first = tail.get(n - 1);
    // A page that starts with only options is the end of the question before it, whether or not that one said it went on: it may have
    // shown some of its options (it looks cut) or none (its words end the page).
    const onlyOptions = !rest.text.trim() && (rest.options?.length ?? 0) > 0;
    const wordsOnly = first?.kind === 'other' && !(first.options?.length ?? 0);
    if (first && first.status === 'draft' && (first.cont_next || looksCut(partOf(first)) || (onlyOptions && wordsOnly)) && (await mergeRows(first, rest, cx, max))) {
      list.shift();
      if (!list.length) tail.set(n, first);
      continue;
    }
    if (settled(n - 1)) await hold(rest);
  }

  // A question still cut at the bottom of its page, whose next page has been read and gave no rest of it.
  const endsOn = new Map<JoinRow, number>();
  for (const [n, r] of tail) endsOn.set(r, Math.max(endsOn.get(r) ?? 0, n));
  for (const [r, n] of endsOn) if (r.status === 'draft' && r.cont_next && settled(n + 1)) await hold(r);
}

/**
 * Takes a joined question apart again: the first part goes back to what it was and the second part comes back as a question of its
 * own on its page. With keepApart (the tutor's undo) the two are not joined again; without it (a page being read again) they can be.
 * Returns the two rows, or none when the question was not joined.
 */
async function unjoin(id: string, cx: Db, keepApart: boolean) {
  const found = await q1<{ paper_id: string }>('select paper_id from paper_drafts where id = $1', [id], cx);
  if (!found) return [];
  await lockPaper(cx, found.paper_id);
  const p = await q1<JoinRow & { paper_id: string; joined: boolean; joined_from: Snapshot | null }>('select * from paper_drafts where id = $1 for update', [id], cx);
  if (!p?.joined || !p.joined_from) return [];
  const { before: b, part } = p.joined_from;
  await cx.query(
    `update paper_drafts set number_label = $2, kind = $3, text = $4, options = $5, needs_diagram = $6, ai_note = $7, answer_checked = $8,
                             question_boxes = $9::jsonb, figure_box = $10::jsonb, cont_next = $11, cont_prev = $12, joined = false, joined_from = null
      where id = $1`,
    [id, b.number_label, b.kind, b.text, b.options, b.needs_diagram, b.ai_note, b.answer_checked, asJson(b.question_boxes), asJson(b.figure_box), b.cont_next, b.cont_prev],
  );
  const rest = await q1(
    `insert into paper_drafts (paper_id, page_no, seq, number_label, kind, text, options, chapter_id, ai_chapter_guess, needs_diagram, ai_note,
                               answer_checked, question_boxes, figure_box, cont_next, cont_prev, keep_apart)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15, $16, $17) returning *`,
    [p.paper_id, part.page_no, part.seq, part.number_label, part.kind, part.text, part.options, part.chapter_id, part.ai_chapter_guess, part.needs_diagram,
      part.ai_note, part.answer_checked, asJson(part.question_boxes), asJson(part.figure_box), part.cont_next, part.cont_prev, keepApart],
  );
  return [await q1('select * from paper_drafts where id = $1', [id], cx), rest];
}

/** What AI is told about a paper when it reads a page of it, and the chapters a question can be filed under. */
type ReadContext = {
  chapters: { id: string; name: string }[];
  /** The paper's own chapter, kept for a question AI could not place. */
  paperChapter: string | null;
};

type PageRow = { class_level: number | null; subject_id: string | null; subject: string | null; paper_chapter: string | null };

/** How a paper is spoken of to AI: its study level and subject. */
const infoOf = async (T: string, page: PageRow) => ({ study: page.class_level != null ? await studyOf(T, page.class_level) : null, subject: page.subject });

/**
 * Puts what AI read from a page into the paper: the page's unchecked drafts are replaced by these questions, the page is marked read, and
 * any question the page edge cut is joined to its other half. The caller holds a transaction. Pages are read side by side, so this takes
 * the paper's lock: two pages never join the same pair of questions at once.
 */
async function storePage(
  cx: Db,
  id: string,
  pageNo: number,
  read: { items: Extracted[]; key: { number: string; answer: string }[]; order: BoxOrder },
  ctx: ReadContext,
  maxOptions: number,
) {
  const { key, order } = read;
  for (const it of read.items) if (typeof it.text === 'string') it.text = realNewlines(it.text);
  // A passage printed alone at the foot of the page is no question: it is kept for the questions at the top of the next page (see
  // carryPassages). Any other passage item goes, as the questions under it start with it.
  const { items, passageEnd: end } = takePassages(read.items);
  const passageEnd = end ? realNewlines(asciiDigits(clip(end, 3000))).trim() || null : null;
  // The reader's known slips in a question's words: a printed key that repeats its options, a figure written as a table, a table
  // copied into a question it is not printed with (see tidyPage). Line breaks written as \n are made real first, as tables are lines.
  tidyPage(items);
  const byName = new Map(ctx.chapters.map((ch) => [ch.name.toLowerCase(), ch.id]));
  await lockPaper(cx, id);
  // A question joined from this page and the next is taken apart first, so reading a page again starts from what the pages say.
  const joinedHere = await q<{ id: string }>(
    `select id from paper_drafts where paper_id = $1 and joined and status = 'draft' and (page_no = $2 or (joined_from #>> '{part,page_no}')::int = $2)`,
    [id, pageNo],
    cx,
  );
  for (const r of joinedHere) await unjoin(r.id, cx, false);
  // The page's unchecked drafts go, and so do its repeats that were skipped for being repeats.
  await cx.query(
    `delete from paper_drafts where paper_id = $1 and page_no = $2 and (status = 'draft' or (status = 'discarded' and ai_note = 'duplicate'))`,
    [id, pageNo],
  );
  let seq = 0;
  for (const [at, it] of items.entries()) {
    // Hindi and Tamil digits become 0 to 9, which every solver and the maths renderer read. A line break written as the two
    // characters \n becomes a real one, and an option that is all maths but came without its $ marks gets them.
    const text = realNewlines(asciiDigits(clip(it.text, 4000)));
    let options = Array.isArray(it.options) ? it.options.map((o) => wrapBareMath(realNewlines(asciiDigits(clip(o, 500))))).filter(Boolean) : [];
    // A question can run over the page edge: this page holds its first part, or its first item is the rest of one from the page before
    // (AI said so, or the item is only options: nothing else can be).
    const cutNext = it.continues_on_next_page === true;
    const cutPrev = isRestOfQuestion(it.continues_from_previous_page === true, seq === 0, text, options);
    // The rest of a question can be only its last options.
    if (!text && !(cutPrev && options.length)) continue;
    const kind = it.kind === 'mcq' && isWholeList(options, maxOptions) ? 'mcq' : 'other';
    // Half a question keeps the options it has, for the join (or the tutor) to finish. So does the last one on the page when it shows
    // some options but not all four, even if AI did not say it goes on: the page edge may have cut it.
    options = storedOptions(kind, options, { cutNext, cutPrev, lastOnPage: at === items.length - 1 });
    const guess = clip(it.chapter_guess, 120);
    const printed = kind === 'mcq' ? answerIndex(it.printed_answer, options) : null;
    // Part of it could not be read (still a box in it, or AI filled something in): an answer
    // worked out from a guess would be a guess too, so AI leaves it until the teacher has checked
    // the question and says it looks right (PATCH /drafts/:id with confirmed).
    const unclear = it.unclear === true || [text, ...options].some((s) => s.includes(BOX));
    // Half a question is not answered either, until it is joined to its other half (see joinSplits).
    const held = unclear || cutNext || cutPrev;
    // Where the question is on the page, and where its figure is: the app shows and cuts from these. A figure printed with a question
    // that the words answer without it is kept too: the app shows it if it can cut it cleanly, but never holds the question back for it.
    const whole = placedQuestion(pageNo, it.question_box, order);
    // A question the reader wrote once, whole, across a page edge keeps the box of its second part too (see absorbRests).
    const more = (restBoxes.get(it) ?? []).map((r) => placedQuestion(r.page, r.box, order)).filter((b): b is Placed => b != null);
    const figure = placed(pageNo, it.diagram_box, order);
    // AI's level for it, for the tutor to keep or change; Medium when AI gave none (the insert fills that in, and says nobody judged it).
    // The rest of a question from the page before has no say in it: the join keeps the level of its first part.
    const level = cutPrev ? null : difficultyOf(it.difficulty);
    await cx.query(
      `insert into paper_drafts (paper_id, page_no, seq, number_label, kind, text, options, chapter_id, ai_chapter_guess, needs_diagram,
                                 correct_option, answer_source, answer_checked, ai_note, question_boxes, figure_box, cont_next, cont_prev,
                                 difficulty, difficulty_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb, $17, $18, coalesce($19::text, 'medium'),
               case when $19::text is null then null else 'ai' end)`,
      [id, pageNo, seq++, clip(it.number, 20) || null, kind, text, options, byName.get(guess.toLowerCase()) ?? ctx.paperChapter ?? null,
        guess || null, it.needs_diagram === true, printed, printed == null ? null : 'key', printed != null || held,
        unclear ? 'unclear' : null, asJson(whole ? [whole, ...more] : null), asJson(figure), cutNext, cutPrev, level],
    );
  }
  // Pages are read side by side, so repeats between pages are skipped by the next answers call,
  // which sees every page that has finished by then.
  await cx.query(`update paper_pages set ai_status = 'done', ai_error = null, read_at = now(), answer_key = $3, passage_end = $4 where paper_id = $1 and page_no = $2`,
    [id, pageNo, JSON.stringify(key), passageEnd]);
  await joinSplits(id, cx, maxOptions);
  await carryPassages(id, cx);
}

// ---------------------------------------------------------------- reading the pages together
//
// The app asks for a paper's pages one request each, four at a time. The first request that arrives for a paper with more than one page
// still to read takes all of them (marks each 'reading' with `whole:<time>` in ai_error, where the app never looks) and reads them a few
// pages to a request (lib/wholepaper.ts); the other requests wait for their page to be stored and then answer. A page the together-read
// does not produce, a failed request, or a switch turned off all end the same way: the page is read on its own, as it always was.

/** What a page's ai_error holds when a together-read gave up on it, so the pages after it are not tried that way again. */
const WHOLE_FAILED = 'whole-failed';
/** How long a together-read's claim on a page counts as alive; past it a page that never finished is read by whoever asks for it next. */
const CLAIM_LIVE_MS = 240_000;
/** The longest a request waits for the together-read to store its page (the app gives each request three minutes). */
const WAIT_MS = 170_000;
/** The longest one request to Gemini for a few pages may take, leaving room to read a page on its own after it. */
const WINDOW_MS = 100_000;
/** Windows read at the same time: the app reads four pages at a time, and Gemini's free plan counts requests a minute. */
const WINDOWS_AT_ONCE = 3;
/** Pictures of a window larger than this (together) are not sent in one request: Gemini takes about 20 MB, and base64 is a third bigger. */
const WINDOW_BYTES = 12 * 1024 * 1024;

const liveClaim = (marker: string | null) => {
  const m = /^whole:(\d+)$/.exec(marker ?? '');
  return !!m && Date.now() - Number(m[1]) < CLAIM_LIVE_MS;
};

/**
 * Pages are read together only when this is switched on: app_settings 'whole_paper_read' true, or the server's WHOLE_PAPER_READ=on (off
 * forces it off). It is off. Measured on 2026-11-14, three rounds of twelve papers (3 and 6 pages, English, Hindi and Tamil, a phone photo
 * copy, a real paper) against reading page by page: the same questions and options (97% of options exact, both), a question over a page
 * edge joined every time (12 of 12 against 11 of 12), boxes a little tighter (0.83 against 0.80), but a few more slips in Hindi and Tamil
 * words (98% of questions word for word against 99%) and nearly twice the time (17.7 s a paper against 9.3 s), for 40 requests against
 * 67. It stays for the day Gemini's per-minute limit, not its speed, is what holds readers back. The answer is remembered for 30 seconds.
 */
let togetherAt = { until: 0, on: false };
async function wholePaperOn(): Promise<boolean> {
  const env = (process.env.WHOLE_PAPER_READ ?? '').toLowerCase();
  if (env === 'on') return true;
  if (env === 'off') return false;
  if (Date.now() < togetherAt.until) return togetherAt.on;
  let on = false;
  try {
    const row = await q1<{ value: unknown }>(`select value from app_settings where key = 'whole_paper_read'`);
    const v = String(row?.value ?? '').toLowerCase();
    on = v === 'true' || v === 'on';
  } catch {
    on = false;
  }
  togetherAt = { until: Date.now() + 30_000, on };
  return on;
}

type Role = { kind: 'single' } | { kind: 'done' } | { kind: 'wait' } | { kind: 'read'; pages: { page_no: number; object_key: string }[]; held: Hold };

/** What this request is to do about its page: take every page still to read, wait for the request that did, or read its page on its own. */
async function claimWhole(T: string, id: string, pageNo: number): Promise<Role> {
  return tx(async (cx) => {
    await lockPaper(cx, id);
    const rows = await q<{ page_no: number; object_key: string; uploaded: boolean; ai_status: string; ai_error: string | null; fresh: boolean }>(
      `select page_no, object_key, uploaded, ai_status, ai_error, coalesce(read_at > now() - interval '10 minutes', false) as fresh
         from paper_pages where paper_id = $1 order by page_no`,
      [id],
      cx,
    );
    const mine = rows.find((r) => r.page_no === pageNo);
    if (!mine) return { kind: 'single' };
    // The app asks for the pages it found unread when it started; one the together-read has stored since is not read again.
    if (mine.ai_status === 'done') return mine.fresh ? { kind: 'done' } : { kind: 'single' };
    if (mine.ai_status === 'reading' && liveClaim(mine.ai_error)) return { kind: 'wait' };
    if (mine.ai_error === WHOLE_FAILED) return { kind: 'single' };
    const open = rows.filter((r) => r.uploaded && (r.ai_status === 'pending' || r.ai_status === 'failed') && r.ai_error !== WHOLE_FAILED);
    if (open.length < 2 || !open.some((r) => r.page_no === pageNo)) return { kind: 'single' };
    // AI credit: every page taken is set aside first (lib/credit.ts). When the credit does not cover them all, each page is read on its
    // own, where its own request pays for it or is told it cannot.
    let held: Hold;
    try {
      held = await hold(T, { pages: open.length }, cx);
    } catch (e) {
      if (e instanceof HttpError && e.code === 'no_credit') return { kind: 'single' };
      throw e;
    }
    await cx.query(`update paper_pages set ai_status = 'reading', ai_error = $2 where paper_id = $1 and page_no = any($3::int[])`, [id, `whole:${Date.now()}`, open.map((r) => r.page_no)]);
    return { kind: 'read', pages: open.map((r) => ({ page_no: r.page_no, object_key: r.object_key })), held };
  });
}

/** Waits for the together-read to store a page. False when it let the page go, or took too long: the page is then read on its own. */
async function waitForWhole(id: string, pageNo: number): Promise<boolean> {
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    const r = await q1<{ ai_status: string; ai_error: string | null }>('select ai_status, ai_error from paper_pages where paper_id = $1 and page_no = $2', [id, pageNo]);
    if (!r) return false;
    if (r.ai_status === 'done') return true;
    if (!(r.ai_status === 'reading' && liveClaim(r.ai_error))) return false;
    await new Promise((ok) => setTimeout(ok, 600));
  }
  return false;
}

/** Lets go of pages the together-read did not store, so their requests read them on their own and no later request tries it again. */
const releasePages = (id: string, nos: number[]) =>
  pool.query(
    `update paper_pages set ai_status = 'pending', ai_error = $3 where paper_id = $1 and page_no = any($2::int[]) and ai_status = 'reading' and ai_error like 'whole:%'`,
    [id, nos, WHOLE_FAILED],
  );

async function inParallel<T>(list: T[], width: number, work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, list.length) }, async () => { while (next < list.length) await work(list[next++]); }));
}

/** One request to Gemini for a few pages. Throws when it cannot answer; those pages are then read on their own. */
async function readWindow(T: string, userId: string, info: { study: string | null; subject: string | null }, nos: number[], dataUrls: string[], chapters: string[], maxOptions: number) {
  const model = VISION_MODELS.find(isGemini);
  if (!model) throw new Error('No Gemini model is set up.');
  const order = boxOrder(model);
  const { content } = await chat({
    task: 'read_paper_page',
    userId,
    tuitionId: T,
    models: [model],
    json: true,
    // Gemini charges for what it writes, not for what it is allowed: a few dense Hindi or Tamil pages need the room.
    maxTokens: 24000,
    deadline: Date.now() + WINDOW_MS,
    messages: [
      { role: 'system', content: 'You transcribe printed exam papers into JSON. You never solve questions; you only copy answers the paper prints.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: windowPrompt(info, nos, chapters, order, maxOptions) },
          ...nos.flatMap((n, i) => [{ type: 'text' as const, text: `Page ${n}:` }, { type: 'image_url' as const, image_url: { url: dataUrls[i] } }]),
        ],
      },
    ],
  });
  return { reads: parseWholePages(content, nos), order };
}

/** Reads the claimed pages a few to a request and stores each page that comes back whole. Returns the pages it stored. */
async function readTogether(T: string, userId: string, id: string, pages: { page_no: number; object_key: string }[], ctx: ReadContext, info: { study: string | null; subject: string | null }, maxOptions: number, held: Hold) {
  const stored = new Set<number>();
  const keyOf = new Map(pages.map((p) => [p.page_no, p.object_key]));
  await inParallel(planWindows(pages.map((p) => p.page_no)), WINDOWS_AT_ONCE, async (nos) => {
    try {
      const images = await Promise.all(nos.map((n) => readPageImage(keyOf.get(n)!)));
      if (images.reduce((sum, img) => sum + img.bytes.length, 0) > WINDOW_BYTES) return;
      const dataUrls = images.map((img) => `data:${img.type};base64,${img.bytes.toString('base64')}`);
      const { reads, order } = await readWindow(T, userId, info, nos, dataUrls, ctx.chapters.map((ch) => ch.name), maxOptions);
      absorbRests(nos, reads, MIN_OPTIONS);
      for (const [i, n] of nos.entries()) {
        const got = reads.get(n);
        // A page the reply left out or gave nothing on is read on its own: that read is also what confirms a page is really blank.
        if (!got || (!got.items.length && !got.key.length)) continue;
        const keyed = await withPrintedKeys(T, userId, info, n, got.items.slice(0, 60) as Extracted[], dataUrls[i], n > 1 ? pageKey(id, n - 1) : null, maxOptions);
        const items = await withLostChoices(T, userId, info, n, keyed, dataUrls[i], maxOptions);
        await tx(async (cx) => {
          await storePage(cx, id, n, { items, key: cleanKey(got.key), order }, ctx, maxOptions);
          await chargePage(cx, T, held, { paperId: id, pageNo: n, picture: pictureOf(images[i].bytes) });
        });
        stored.add(n);
      }
    } catch {
      // This request's pages that are not stored yet are read on their own.
    }
  });
  return stored;
}

/**
 * Reads the page together with the paper's other unread pages, or waits for the request that does. True when the page is read; false
 * when it is to be read on its own the usual way. Never throws: whatever goes wrong here, the usual way is still there.
 */
async function readWithWhole(T: string, userId: string, id: string, pageNo: number, page: PageRow, ctx: ReadContext, maxOptions: number): Promise<boolean> {
  try {
    const role = await claimWhole(T, id, pageNo);
    if (role.kind === 'single') return false;
    if (role.kind === 'done') return true;
    if (role.kind === 'wait') return await waitForWhole(id, pageNo);
    const nos = role.pages.map((p) => p.page_no);
    let stored = new Set<number>();
    try {
      stored = await readTogether(T, userId, id, role.pages, ctx, await infoOf(T, page), maxOptions, role.held);
    } finally {
      const left = nos.filter((n) => !stored.has(n));
      if (left.length) await releasePages(id, left).catch(() => {});
      await release(role.held);
    }
    return stored.has(pageNo);
  } catch {
    return false;
  }
}

/** Reads one page with AI and replaces that page's unchecked drafts. */
paperRoutes.post('/papers/:id/pages/:n/read', async (c) => {
  const T = tuitionOf(c).id;
  const id = uuid(c.req.param('id'), 'paper id');
  const pageNo = pageNumber(c);
  const page = await tq1(
    T,
    `select pp.*, p.class_level, p.subject_id, p.chapter_id as paper_chapter, (select name from subjects where id = p.subject_id) as subject
       from paper_pages pp join papers p on p.id = pp.paper_id where pp.paper_id = $1 and pp.page_no = $2 and p.tuition_id = @T`,
    [id, pageNo],
  );
  if (!page) throw notFound('This page');
  if (!page.uploaded) throw new HttpError(409, 'not_uploaded', 'This page has not finished uploading.');
  const chapters =
    page.class_level == null || page.subject_id == null
      ? []
      : await tq<{ id: string; name: string }>(T, 'select id, name from chapters where tuition_id = @T and class_level = $1 and subject_id = $2', [page.class_level, page.subject_id]);
  const ctx: ReadContext = { chapters, paperChapter: page.paper_chapter };
  // An app before build 13 has four slots for options, so what it asks to be read stays at four (see lib/options.ts).
  const maxOptions = maxOptionsFor(knowsMoreOptions(c));
  const userId = c.get('user').id;

  // The paper's pages are read together when they can be; this page is then already stored, or it is read on its own below.
  if ((await wholePaperOn()) && (await readWithWhole(T, userId, id, pageNo, page, ctx, maxOptions))) {
    const drafts = await q('select * from paper_drafts where paper_id = $1 and page_no = $2 order by seq', [id, pageNo]);
    const stored = await q1<{ answer_key: unknown }>('select answer_key from paper_pages where paper_id = $1 and page_no = $2', [id, pageNo]);
    return c.json({ page_no: pageNo, drafts, answer_key: Array.isArray(stored?.answer_key) ? stored.answer_key.length : 0 });
  }

  // AI credit: one page is set aside before AI reads it and charged in the transaction that stores it (lib/credit.ts). A page that
  // fails costs nothing, and reading the same picture again is free.
  const held = await hold(T, { pages: 1 });
  try {
    await pool.query(`update paper_pages set ai_status = 'reading', ai_error = null where id = $1`, [page.id]);
    let items: Extracted[];
    let key: { number: string; answer: string }[];
    // How the model that read the page wrote its boxes.
    let order: BoxOrder = 'xy';
    // Which picture was read, so the same one read again is not charged again.
    let picture = '';
    try {
      const img = await readPageImage(page.object_key);
      picture = pictureOf(img.bytes);
      const dataUrl = `data:${img.type};base64,${img.bytes.toString('base64')}`;
      const info = await infoOf(T, page);
      const promptFor = (boxes: BoxOrder) => readPrompt(info, pageNo, chapters.map((ch) => ch.name), boxes, maxOptions);
      ({ items, key, order } = await readPageWithAI(T, userId, promptFor, dataUrl));
      items = await withPrintedKeys(T, userId, info, pageNo, items, dataUrl, pageNo > 1 ? pageKey(id, pageNo - 1) : null, maxOptions);
      items = await withLostChoices(T, userId, info, pageNo, items, dataUrl, maxOptions);
    } catch (e) {
      const message = e instanceof HttpError ? e.message : 'AI could not read this page. Try a clearer photo.';
      await pool.query(`update paper_pages set ai_status = 'failed', ai_error = $2 where id = $1`, [page.id, message]);
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, 'ai_unreadable', message);
    }

    await tx(async (cx) => {
      await storePage(cx, id, pageNo, { items, key, order }, ctx, maxOptions);
      await chargePage(cx, T, held, { paperId: id, pageNo, picture });
    });
    const drafts = await q('select * from paper_drafts where paper_id = $1 and page_no = $2 order by seq', [id, pageNo]);
    return c.json({ page_no: pageNo, drafts, answer_key: key.length });
  } finally {
    await release(held);
  }
});

// ---------------------------------------------------------------- AI: answers

/**
 * Marks answers from the answer keys printed anywhere in the paper. Returns how many. A printed
 * key beats an answer AI worked out (the app answers pages while later ones, perhaps holding the
 * key, are still being read), but never a mark the teacher made.
 */
async function applyAnswerKeys(paperId: string, db: Db = pool) {
  const pages = await q<{ answer_key: { number: string; answer: string }[] | null }>(
    'select answer_key from paper_pages where paper_id = $1 order by page_no',
    [paperId],
    db,
  );
  const answers = new Map<string, string | null>();
  for (const k of pages.flatMap((pg) => pg.answer_key ?? [])) {
    const n = numberKey(k.number);
    if (!n) continue;
    // A number with two different answers (two sections both start at 1) is left alone.
    answers.set(n, answers.has(n) && answers.get(n) !== k.answer ? null : k.answer);
  }
  if (!answers.size) return 0;
  const drafts = await q(`select id, number_label, options, correct_option, answer_source, status, kind from paper_drafts where paper_id = $1`, [paperId], db);
  const mcq = drafts.filter((d) => d.kind === 'mcq' && d.status !== 'discarded');
  const count = new Map<string, number>();
  for (const d of mcq) count.set(numberKey(d.number_label), (count.get(numberKey(d.number_label)) ?? 0) + 1);
  let marked = 0;
  for (const d of mcq) {
    const n = numberKey(d.number_label);
    if (d.status !== 'draft' || !n || count.get(n) !== 1) continue;
    if (d.correct_option != null && d.answer_source !== 'ai') continue; // the teacher's mark, or a key already applied
    const i = answerIndex(answers.get(n), d.options ?? []);
    if (i == null) continue;
    await db.query(
      // The paper's own answer ends whatever AI was unsure about: no split note, no second opinion to wait for.
      `update paper_drafts set correct_option = $2, answer_source = 'key', ai_confidence = null, answer_checked = true,
              ai_note = case when ai_note in ('disagree', 'unsure', 'writer_differs') then null else ai_note end,
              ai_picks = null, ai_votes = null
        where id = $1`,
      [d.id, i],
    );
    marked++;
  }
  return marked;
}

/** Gives drafts without a chapter the one AI guessed (once the class is known), else the paper's. */
async function fillChapters(paperId: string, db: Db = pool) {
  await db.query(
    `update paper_drafts d set chapter_id = coalesce(
        (select ch.id from chapters ch join papers p on p.id = d.paper_id
          where ch.class_level = p.class_level and ch.subject_id = p.subject_id and ch.tuition_id = p.tuition_id
             and lower(ch.name) = lower(d.ai_chapter_guess) limit 1),
        (select chapter_id from papers where id = d.paper_id))
      where d.paper_id = $1 and d.status = 'draft' and d.chapter_id is null`,
    [paperId],
  );
}

/**
 * The list a model's JSON reply holds, whatever shape it chose: the object that was asked for
 * (`{"answers": [...]}`), a bare list, or a list under another name. Models reading with
 * `responseMimeType: application/json` and no schema do all three.
 */
export function listIn(content: string, key: string): any[] {
  let parsed: unknown;
  try {
    parsed = parseJson<unknown>(content);
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    if (Array.isArray(o[key])) return o[key] as any[];
    const other = Object.values(o).find(Array.isArray);
    if (other) return other as any[];
  }
  return [];
}

/** The options named in a model's reply (`"A"`, `["A","C"]`, `"A, C"`, `[]`), as numbers from 0, each once. Only letters the question has count. */
function optionsIn(v: unknown, count = MIN_OPTIONS): number[] {
  const text = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return [...new Set((text.toUpperCase().match(/\b[A-F]\b/g) ?? []).map((l) => l.charCodeAt(0) - 65).filter((i) => i < count))].sort();
}

/**
 * One model's reading of a batch: position in the batch -> every option it finds correct, and how sure it is. Asking for the
 * whole list, not for one answer, is what lets a question with two right options (or none) show itself: a model made to pick one
 * answers a faulty question as confidently as a sound one. The models are tried in order, and a model that left questions out is
 * followed by the next one, asked only for those. Throws only when every model failed outright (the caller decides what that means).
 */
async function solve(
  models: string[],
  userId: string,
  tuitionId: string,
  p: { class_level: number | null; subject: string | null; course?: string | null },
  batch: any[],
  how: { task?: string; deadline?: number; attemptMs?: number } = {},
) {
  // A course's paper has no class: its questions are checked as a careful teacher would check them.
  const who = p.class_level == null
    ? `a careful${p.subject ? ` ${p.subject}` : ''} teacher checking the answers to multiple-choice questions${p.course ? ` written for a course called ${p.course}` : ''}`
    : isClassNumber(p.class_level)
      ? `a careful CBSE${p.subject ? ` ${p.subject}` : ''} teacher checking the answers to Class ${p.class_level} multiple-choice questions`
      : `a careful${p.subject ? ` ${p.subject}` : ''} teacher checking the answers to ${await levelLabel(tuitionId, p.class_level)} multiple-choice questions`;
  const out = new Map<number, Pick>();
  let failure: unknown = null;
  for (const model of models) {
    const todo = batch.map((_, i) => i).filter((i) => !out.has(i));
    if (!todo.length) break;
    const qs = todo.map((i) => ({
      id: `q${i + 1}`,
      question: batch[i].text,
      // A, B, C, D, and E or F for a question that has more.
      options: Object.fromEntries((batch[i].options as string[]).map((o, k) => [letterOf(k), o])),
    }));
    const messages = [
      {
        role: 'system' as const,
        content: `You are ${who}. The questions may be in English, Hindi or Tamil, or mix them; you read all three equally well.`,
      },
      {
        role: 'user' as const,
        content: `Check each multiple-choice question before it goes into a test. Reply only as JSON:
{"answers":[{"id":"q1","figure":false,"correct":["A"],"confidence":0.97}]}
- "figure" is true when the question cannot be worked out from its words and options alone because it depends on a figure, graph, diagram or picture that is not given in words: it asks about points, angles, lengths, labels, numbered parts or a shape that the words never give (such as "find x" when x is only marked in a figure, angle BDC when D is never placed, or the polynomial a graph shows), about values read off a graph, or about which picture is right. Then "correct" is [].
- "figure" is false when the words and options give everything needed, even when the question says "in the figure": "In the figure, DE is parallel to BC, AD = 3 cm, DB = 2 cm and AE = 4.5 cm. Find EC." is false. It is false, too, when what is missing is not a picture (the question is unclear, or it needs a passage or table that is not given).
- "correct" lists every option that is a correct answer to the question as written. Nearly always that is exactly one letter.
- List two or more letters when more than one option is correct or would be accepted (for example both are accepted usage, or two options mean the same).
- List none ([]) when no option is correct, when the question is unclear or has no single answer, when it asks about something that is not given, or when it needs a figure you cannot see.
- Test each option on its own against the question before you decide. Do not stop at the first one that looks right.
- confidence is the probability that your list is exactly right, between 0 and 1.
Questions:
${JSON.stringify(qs)}`,
      },
    ];
    let content: string;
    let by: string;
    try {
      // A model that is slow today (the same one answers in 2 s on another call) is cut off, and the next one is asked.
      const cutOff = how.attemptMs === undefined ? how.deadline : Math.min(how.deadline ?? Infinity, Date.now() + how.attemptMs);
      ({ content, model: by } = await chat({
        task: how.task ?? 'answer_questions', userId, tuitionId, models: [model], json: true, maxTokens: 3000, reasoning: model.includes('lite') ? 'low' : 'medium', messages, deadline: cutOff,
      }));
    } catch (e) {
      failure = e;
      continue;
    }
    let got = 0;
    for (const a of listIn(content, 'answers')) {
      const i = Number(String(a?.id ?? '').replace(/^q/, '')) - 1;
      if (!todo.includes(i) || out.has(i)) continue;
      // A reply in the old shape ({"answer": "B"}) is read too: a model that ignored the list still said what it chose.
      // Whether it needs its figure (see figureOf): a model that says so has no option to give, whatever it listed.
      const figure = a?.figure === true || a?.figure === 'true' ? true : a?.figure === false || a?.figure === 'false' ? false : undefined;
      const set = figure ? [] : optionsIn(a?.correct ?? a?.answer, batch[i].options.length);
      out.set(i, { answer: set.length === 1 ? set[0] : null, confidence: conf(a?.confidence), set, by, ...(figure !== undefined ? { figure } : {}) });
      got++;
    }
    if (got > 0) failure = null; // it answered: the next model only fills in what it left out
  }
  if (!out.size && failure) throw failure;
  return out;
}

/**
 * A question the checks say cannot be answered without its figure: AI cannot see one, so it waits for the tutor, with its figure asked
 * for (a figure printed with it is cut by the app by itself). What the checks chose is dropped: they had no figure to choose with.
 * One the reader gave no figure box, in a group of questions under one passage, takes the box of the nearest question of its group
 * before it that has one: such a group shares the figure its passage speaks of (as the five questions on one graph of a wire did).
 */
async function holdForFigure(cx: Db, draftId: string) {
  const d = await q1<{ paper_id: string; page_no: number; seq: number; text: string; figure_box: Placed | null }>(
    `update paper_drafts set needs_diagram = true, answer_checked = true, answer_claimed_at = null, answer_tries = answer_tries + 1,
            ai_note = case when ai_note in ('disagree', 'unsure', 'no_option', 'unchecked') then null else ai_note end,
            ai_picks = null, ai_votes = null, ai_confidence = null
      where id = $1 and correct_option is null
      returning paper_id, page_no, seq, text, figure_box`,
    [draftId],
    cx,
  );
  if (!d || d.figure_box) return;
  const near = await q<{ text: string; figure_box: Placed }>(
    `select text, figure_box from paper_drafts where paper_id = $1 and page_no = $2 and seq < $3 and status <> 'discarded' and figure_box is not null
      order by seq desc limit 10`,
    [d.paper_id, d.page_no, d.seq],
    cx,
  );
  const mate = near.find((n) => sharedPassage(n.text, d.text) != null);
  if (mate) await cx.query('update paper_drafts set figure_box = $2::jsonb where id = $1 and figure_box is null', [draftId, asJson(mate.figure_box)]);
}

/** How long a batch of questions stays claimed by a call that has not finished with it. */
const CLAIM_MINUTES = 3;

/**
 * A question whose page before is still being read is not answered yet: that page may end with the passage it needs (see
 * carryPassages). A page that could not be read is not waited for. A condition on paper_drafts, for a query on it.
 */
const PAGE_BEFORE_READ = `not exists (select 1 from paper_pages pp where pp.paper_id = paper_drafts.paper_id and pp.page_no = paper_drafts.page_no - 1
                                        and pp.uploaded and pp.ai_status in ('pending', 'reading'))`;

/** A question AI has looked for this many times, with no model answering it, is left to the tutor. */
const MAX_ANSWER_TRIES = 2;

/**
 * The most time one model gets to answer a batch before the next is asked. Groq's answer in 1 to 5 seconds; Gemini's take 5 to 25 on
 * most calls and 40 to 60 on a busy evening, which would hold up the whole paper.
 */
const ANSWER_ATTEMPT_MS = 30_000;

/**
 * What the checks said about a question that waits for another opinion (migration 016), and how many times another opinion was
 * asked for and none came back.
 */
type Waiting = Votes & { tries: number };

/** A paper AI wrote from the tutor's request (the chat): its questions come with the writer's own answer, which is one more opinion. */
const isWritten = (p: { category: string | null; page_count: number }) => p.category === 'Made with AI' && p.page_count === 0;

/**
 * Finds answers for the next few unanswered questions: first from the paper's own answer keys, then with AI. Two different
 * models each list the options they find correct, on their own (see `solve`), and the answer is marked when at least two models
 * were heard and all of them chose the same one option (see `verdict`). A question one of them found two answers to, or none, is
 * the question's fault and is left for its replacement or the tutor. A question the models split over, or only one could be heard
 * on (the other was busy), keeps what was said and waits for another model's opinion, which is a step of its own
 * (`/second-opinion`) so the tutor does not wait for the slow, strong models. A question AI wrote in the chat keeps its writer's
 * answer as one more opinion, which can ask the tutor to check the mark but does not block it. A question no model said anything
 * about is asked again.
 *
 * The app calls this several times at once, and while pages are still being read. Each call claims its own batch (so no question
 * is answered twice), and a call that finds nothing open while pages are still coming simply asks again a moment later. `left`
 * counts the questions nobody has claimed yet; `second` counts the questions of this batch now waiting for another opinion.
 */
paperRoutes.post('/papers/:id/answers', async (c) => {
  const T = tuitionOf(c).id;
  const id = uuid(c.req.param('id'), 'paper id');
  const p = await tq1(T, `select ${PAPER_COLS} from papers p where p.id = $1 and p.tuition_id = @T`, [id]);
  if (!p) throw notFound('This paper');
  if (p.class_level == null && !p.course_id) throw new HttpError(409, 'needs_details', 'Choose the class of this paper first.');
  await tx(async (cx) => {
    await joinSplits(id, cx, maxOptionsFor(knowsMoreOptions(c)));
    await carryPassages(id, cx);
  });
  await skipRepeats(id, pool);
  const fromKey = await applyAnswerKeys(id);
  await fillChapters(id);

  const open = `paper_id = $1 and status = 'draft' and kind = 'mcq' and correct_option is null and (not answer_checked or ai_note = 'unchecked')
                and (answer_claimed_at is null or answer_claimed_at < now() - interval '${CLAIM_MINUTES} minutes')`;
  // AI cannot see a figure. A question the tutor herself says needs its figure waits for her. One the reader flagged goes to the checks,
  // which say whether its words are enough after all (see figureOf); those are asked first, so they are settled early in a paper.
  await pool.query(`update paper_drafts set answer_checked = true where ${open} and needs_diagram and figure_by = 'tutor'`, [id]);
  const batch = (
    await q<{
      id: string; text: string; options: string[]; page_no: number; seq: number; proposed_option: number | null; answer_tries: number;
      needs_diagram: boolean; figure_by: string | null;
    }>(
      // A question AI could not check last time starts again, as if it had never been looked at. One on a page whose page before is
      // still being read waits for it: that page may end with the passage it needs (see carryPassages).
      `update paper_drafts set answer_claimed_at = now(), ai_note = case when ai_note = 'unchecked' then null else ai_note end,
                              answer_tries = case when ai_note = 'unchecked' then 0 else answer_tries end
        where id in (select id from paper_drafts where ${open} and ${PAGE_BEFORE_READ} and array_length(options, 1) between ${MIN_OPTIONS} and ${MAX_OPTIONS}
                      order by needs_diagram desc, page_no, seq limit ${ANSWER_BATCH} for update skip locked)
        returning id, text, options, page_no, seq, proposed_option, answer_tries, needs_diagram, figure_by`,
      [id],
    )
  ).sort((x, y) => x.page_no - y.page_no || x.seq - y.seq);
  let byAi = 0;
  let second = 0;
  if (batch.length) {
    try {
      const userId = c.get('user').id;
      const how = { attemptMs: ANSWER_ATTEMPT_MS };
      const written = isWritten(p);
      // Each check is a call of its own: one that cannot be reached must not throw away what the other found.
      const asked = await Promise.allSettled([solve(SOLVE_MODELS, userId, T, p, batch, how), solve(CHECK_MODELS, userId, T, p, batch, how)]);
      // Neither could be reached: AI is busy or down. The batch goes back (below) for the next call and the app waits.
      if (asked.every((r) => r.status === 'rejected')) throw (asked[0] as PromiseRejectedResult).reason;
      const [x, y] = asked.map((r) => (r.status === 'fulfilled' ? r.value : new Map<number, Pick>()));
      await tx(async (cx) => {
        for (const [i, d] of batch.entries()) {
          const votes: Votes = { solver: x.get(i), checker: y.get(i) };
          // The checks say whether it needs its figure, unless the tutor has said so herself. Needing it, it waits for her with its
          // figure asked for; not needing it, the flag goes and it is answered like any other.
          const figure = d.figure_by === 'tutor' ? null : figureOf(votes);
          if (figure === true) {
            await holdForFigure(cx, d.id);
            continue;
          }
          if (figure === false && d.needs_diagram) await cx.query(`update paper_drafts set needs_diagram = false where id = $1`, [d.id]);
          const v = verdict(votes, d.proposed_option, { written });
          if (v.mark) byAi++;
          // Models that split, or only one of which was heard, leave the question waiting for another model's opinion; the card says so until it comes.
          const waits = !v.mark && v.more && v.heard > 0;
          if (waits) second++;
          // A question no model said anything about is asked again; after two tries it could not be checked, which is not a doubt about
          // the question: it is left to the tutor for now, and looked at again when the paper is next opened.
          const askAgain = !v.mark && v.heard === 0 && d.answer_tries + 1 < MAX_ANSWER_TRIES;
          const note = askAgain ? null : !v.mark && v.heard === 0 ? 'unchecked' : v.note;
          await cx.query(
            `update paper_drafts set answer_checked = $6, answer_claimed_at = case when $4::text = 'unchecked' then now() else null end,
                    answer_tries = answer_tries + 1,
                    correct_option = case when $2::smallint is null then correct_option else $2 end,
                    answer_source = case when $2::smallint is null then answer_source else 'ai' end,
                    ai_confidence = $3,
                    ai_note = case when $4::text is not null and ai_note is null then $4 else ai_note end,
                    ai_picks = case when $5::jsonb is not null then $5::jsonb else ai_picks end,
                    ai_votes = $7::jsonb
              where id = $1 and correct_option is null`,
            [
              d.id, v.mark?.answer ?? null, v.mark?.confidence ?? null, note, v.picks ? JSON.stringify(v.picks) : null, !askAgain,
              waits ? JSON.stringify({ ...votes, tries: 0 } satisfies Waiting) : null,
            ],
          );
        }
      });
    } catch (e) {
      // AI was busy or failed: give the batch back, so the next call (or the teacher's retry) takes it.
      await pool.query(`update paper_drafts set answer_claimed_at = null where id = any($1::uuid[])`, [batch.map((d) => d.id)]).catch(() => {});
      throw e;
    }
  }
  // A question held as unclear (the reader filled in a symbol it could not read, or found part of it unclear) waits for the tutor to
  // check its words before AI answers it. One the reader also said needs its figure is put to the solver now for that alone: whether
  // its words, as read, are enough. So she is not asked for a figure it does not need (a misprinted "DE ■ BC", read as DE ∥ BC with
  // every length given, came flagged). Nothing is marked, and each is asked until the solver gives its word once (answer_tries; rewording
  // or confirming it starts again). One the solver could not be heard on (busy or down: on 2026-11-15 Groq refused both gpt-oss models
  // for minutes at a time) stays claimed for a few minutes, so the app's calls do not ask it over and over, and is asked again after that.
  let looked = 0;
  if (!batch.length) {
    const held = await q<{ id: string; text: string; options: string[]; page_no: number; seq: number; proposed_option: number | null }>(
      `update paper_drafts set answer_claimed_at = now()
        where id in (select id from paper_drafts where paper_id = $1 and status = 'draft' and kind = 'mcq' and correct_option is null
                       and answer_checked and ai_note = 'unclear' and needs_diagram and figure_by is null and answer_tries = 0
                       and (answer_claimed_at is null or answer_claimed_at < now() - interval '${CLAIM_MINUTES} minutes')
                       and position($2 in text) = 0 and array_length(options, 1) between ${MIN_OPTIONS} and ${MAX_OPTIONS}
                     order by page_no, seq limit ${ANSWER_BATCH} for update skip locked)
        returning id, text, options, page_no, seq, proposed_option`,
      [id, BOX],
    );
    looked = held.length;
    if (held.length) {
      const said = await solve(SOLVE_MODELS, c.get('user').id, T, p, held, { attemptMs: ANSWER_ATTEMPT_MS }).catch(() => null);
      const figures = held.map((_, i) => (said ? figureOf({ solver: said.get(i) }) : null));
      const heard = held.filter((_, i) => figures[i] != null).map((d) => d.id);
      const enough = held.filter((_, i) => figures[i] === false).map((d) => d.id);
      if (heard.length) {
        await pool.query(
          `update paper_drafts set answer_tries = answer_tries + 1, answer_claimed_at = null,
                  needs_diagram = case when id = any($2::uuid[]) and figure_by is null then false else needs_diagram end
            where id = any($1::uuid[])`,
          [heard, enough],
        );
      }
    }
  }
  const left = await q1(`select count(*) as n from paper_drafts where ${open}`, [id]);
  return c.json({ from_key: fromKey, by_ai: byAi, tried: batch.length + looked, left: left.n, second });
});

/** How many questions one second-opinion call takes, and the most time it may spend on them (the strong models are slow). */
const SECOND_BATCH = 6;
const SECOND_MS = 55_000;

/** The stronger models take 3 to 40 seconds. Each gets this long, so the one behind it still has time when the first hangs. */
const SECOND_ATTEMPT_MS = 35_000;

/** A question nobody could give another opinion on this many times is given up on, and left to the tutor. */
const MAX_SECOND_TRIES = 2;

/**
 * The next opinion on questions that wait for one: a first check that was never heard goes back to its own model, and when both
 * were heard (and split) a stronger model is asked. The question is marked when the opinions now add up (see `verdict`). It is a
 * call of its own, made after the answers, because the strong models are slow and often busy: the tutor reviews the paper while it
 * works, and what it cannot help with stays with the tutor, with what each check chose on the card. An opinion that comes back
 * is progress and costs no try; a call nobody could answer counts as one, and after two the question is left alone. `left` counts
 * the questions still waiting that nobody has claimed.
 */
paperRoutes.post('/papers/:id/second-opinion', async (c) => {
  const T = tuitionOf(c).id;
  const id = uuid(c.req.param('id'), 'paper id');
  const p = await tq1(T, `select ${PAPER_COLS} from papers p where p.id = $1 and p.tuition_id = @T`, [id]);
  if (!p) throw notFound('This paper');
  if (p.class_level == null && !p.course_id) throw new HttpError(409, 'needs_details', 'Choose the class of this paper first.');

  const waiting = `paper_id = $1 and status = 'draft' and kind = 'mcq' and correct_option is null and ai_votes is not null
                   and (answer_claimed_at is null or answer_claimed_at < now() - interval '${CLAIM_MINUTES} minutes')`;
  const batch = (
    await q<{
      id: string; text: string; options: string[]; page_no: number; seq: number; proposed_option: number | null; ai_votes: Waiting;
      needs_diagram: boolean; figure_by: string | null;
    }>(
      `update paper_drafts set answer_claimed_at = now()
        where id in (select id from paper_drafts where ${waiting} and array_length(options, 1) between ${MIN_OPTIONS} and ${MAX_OPTIONS}
                      order by page_no, seq limit ${SECOND_BATCH} for update skip locked)
        returning id, text, options, page_no, seq, proposed_option, ai_votes, needs_diagram, figure_by`,
      [id],
    )
  ).sort((x, y) => x.page_no - y.page_no || x.seq - y.seq);
  let byAi = 0;
  const written = isWritten(p);
  const got = new Map<number, { slot: keyof Votes; pick: Pick }>();
  if (batch.length) {
    const userId = c.get('user').id;
    const deadline = Date.now() + SECOND_MS;
    const lacks = (v: Waiting): keyof Votes => (!v.solver ? 'solver' : !v.checker ? 'checker' : 'tiebreak');
    const groups = new Map<keyof Votes, number[]>();
    for (const [i, d] of batch.entries()) groups.set(lacks(d.ai_votes), [...(groups.get(lacks(d.ai_votes)) ?? []), i]);
    await Promise.all(
      [...groups].map(async ([slot, at]) => {
        // A model that has already given its opinion on these questions is not asked again: its second answer would be the same vote.
        const heard = new Set(at.flatMap((i) => [batch[i].ai_votes.solver?.by, batch[i].ai_votes.checker?.by, batch[i].ai_votes.tiebreak?.by]));
        const models = [...new Set([...(slot === 'solver' ? SOLVE_MODELS : slot === 'checker' ? CHECK_MODELS : []), ...TIEBREAK_MODELS])].filter((m) => !heard.has(m));
        if (!models.length) return;
        try {
          const read = await solve(models, userId, T, p, at.map((i) => batch[i]), { task: 'second_opinion', deadline, attemptMs: SECOND_ATTEMPT_MS });
          for (const [k, pick] of read) got.set(at[k], { slot, pick });
        } catch {
          // Nobody could be asked in time. That counts as a try below.
        }
      }),
    );
    try {
      await tx(async (cx) => {
        for (const [i, d] of batch.entries()) {
          const g = got.get(i);
          const votes: Votes = { solver: d.ai_votes.solver, checker: d.ai_votes.checker, tiebreak: d.ai_votes.tiebreak, ...(g ? { [g.slot]: g.pick } : {}) };
          // A solver that was busy the first time says now whether the question needs its figure (see /answers).
          const figure = d.figure_by === 'tutor' ? null : figureOf(votes);
          if (figure === true) {
            await holdForFigure(cx, d.id);
            continue;
          }
          if (figure === false && d.needs_diagram) await cx.query(`update paper_drafts set needs_diagram = false where id = $1`, [d.id]);
          const v = verdict(votes, d.proposed_option, { written });
          if (v.mark) byAi++;
          const tries = (d.ai_votes.tries ?? 0) + (g ? 0 : 1);
          // Finished when the opinions add up to something (a mark, or a doubt nobody can settle), or when it could not be asked twice.
          const done = v.mark != null || !v.more || tries >= MAX_SECOND_TRIES;
          // Given up on while fewer than two families had looked at it: that is not a doubt about the question, it could not be checked.
          const note = done && !v.mark && v.more && v.note === 'unsure' ? 'unchecked' : v.note;
          await cx.query(
            `update paper_drafts set answer_claimed_at = case when $4::text = 'unchecked' then now() else null end,
                    correct_option = case when $2::smallint is null then correct_option else $2 end,
                    answer_source = case when $2::smallint is null then answer_source else 'ai' end,
                    ai_confidence = $3, ai_note = $4, ai_picks = $5::jsonb, ai_votes = $6::jsonb
              where id = $1 and correct_option is null and ai_votes is not null`,
            [d.id, v.mark?.answer ?? null, v.mark?.confidence ?? null, note, v.picks ? JSON.stringify(v.picks) : null, done ? null : JSON.stringify({ ...votes, tries } satisfies Waiting)],
          );
        }
      });
    } catch (e) {
      // The claim runs out by itself after a few minutes; the next call takes these again.
      await pool.query(`update paper_drafts set answer_claimed_at = null where id = any($1::uuid[])`, [batch.map((d) => d.id)]).catch(() => {});
      throw e;
    }
  }
  const left = await q1(`select count(*) as n from paper_drafts where ${waiting}`, [id]);
  // `asked` is how many questions got a new opinion: none means everybody was busy, and a pause helps before the next call.
  return c.json({ by_ai: byAi, tried: batch.length, asked: got.size, left: left.n });
});

/**
 * A paper AI wrote has at most as many replacements as it has questions (and at least 20), however often the app asks:
 * a topic the checks can never settle must not keep the writer busy for ever.
 */
const replaceCap = (questions: number) => Math.max(20, questions);

/**
 * A question of a paper AI wrote that its checks have finished with and could not settle: no answer was marked, or the
 * checks marked another option than the one the writer meant. Not one the teacher has marked, reworded or brought back, not one
 * still waiting for its second opinion, and not one the checks could not be made on (AI was down): that says nothing of the question.
 */
const UNSETTLED_NOW = `status = 'draft' and kind = 'mcq' and not edited and answer_checked and ai_votes is null
   and (correct_option is null or ai_note = 'writer_differs') and ai_note is distinct from 'unchecked'`;

/** ...and that no call is working on right now. */
const UNSETTLED = `${UNSETTLED_NOW} and (answer_claimed_at is null or answer_claimed_at < now() - interval '${CLAIM_MINUTES} minutes')`;

/**
 * Replaces the questions AI wrote that its checks could not settle. Each is left out (it shows under Skipped, with the
 * reason) and AI writes a new one on the same request in its place, with the same number. The new questions are checked like
 * the rest, by the app calling /answers and /second-opinion again. The app asks for this after the checks, a few times over
 * (a new question can fail too), so the teacher ends up with the number of questions she asked for, each with an answer
 * the checks agree on.
 *
 * Only for a paper AI wrote, and only one that has the request it was written from (an uploaded paper's questions are the
 * paper's own). A call replaces at most one writer reply's worth, so `left` says whether to ask again. A busy writer
 * changes nothing: the questions stay as they were, for the teacher.
 */
paperRoutes.post('/papers/:id/replace', async (c) => {
  const T = tuitionOf(c).id;
  const id = uuid(c.req.param('id'), 'paper id');
  const p = await tq1<{ class_level: number | null; course_id: string | null; category: string | null; page_count: number; ai_request: string | null; subject: string | null; course: string | null }>(
    T,
    `select p.class_level, p.course_id, p.category, p.page_count, p.ai_request,
            (select name from subjects where id = p.subject_id) as subject, (select name from courses where id = p.course_id) as course
       from papers p where p.id = $1 and p.tuition_id = @T`,
    [id],
  );
  if (!p) throw notFound('This paper');
  const nothing = { replaced: 0, left: 0 };
  if (p.category !== 'Made with AI' || p.page_count !== 0 || !p.ai_request) return c.json(nothing);

  const counts = await q1<{ live: number; replaced: number }>(
    `select count(*) filter (where status <> 'discarded') as live, count(*) filter (where ai_note = 'replaced') as replaced
       from paper_drafts where paper_id = $1`,
    [id],
  );
  const room = replaceCap(Number(counts?.live ?? 0)) - Number(counts?.replaced ?? 0);
  if (room <= 0) return c.json(nothing);
  const indic = hasIndicText(p.ai_request) || namesIndicLanguage(p.ai_request);
  const batch = Math.min(indic ? INDIC_WRITE_BATCH : WRITE_BATCH, room);

  // This call's questions are claimed, so a second call (another phone of the same tuition) takes others and nothing is written twice.
  const stuck = await q<{ id: string; page_no: number; seq: number; number_label: string | null }>(
    `update paper_drafts set answer_claimed_at = now()
      where id in (select id from paper_drafts where paper_id = $1 and ${UNSETTLED} order by page_no, seq limit ${batch} for update skip locked)
      returning id, page_no, seq, number_label`,
    [id],
  );
  if (!stuck.length) return c.json(nothing);
  stuck.sort((x, y) => x.page_no - y.page_no || x.seq - y.seq);
  let replaced = 0;
  try {
    const written = await q<{ text: string }>('select text from paper_drafts where paper_id = $1 order by seq', [id]);
    const study = p.course_id ? `the course "${p.course}"` : await studyOf(T, p.class_level!);
    const { items } = await writeQuestions({
      userId: c.get('user').id, tuitionId: T, request: p.ai_request, asked: stuck.length, indic, study, subject: p.subject, classLevel: p.class_level,
      course: p.course_id != null, written,
    });
    replaced = await tx(async (cx) => {
      // Only as many as the writer gave back, and only those still unsettled: the teacher may have marked one in the meantime.
      const gone = await cx.query(
        `update paper_drafts set status = 'discarded', ai_note = 'replaced'
          where id = any($1::uuid[]) and paper_id = $2 and ${UNSETTLED_NOW} returning id`,
        [stuck.slice(0, items.length).map((s) => s.id), id],
      );
      const dropped = new Set(gone.rows.map((r) => r.id));
      let n = 0;
      for (const s of stuck) {
        if (!dropped.has(s.id)) continue;
        const it = items[n++];
        await cx.query(
          `insert into paper_drafts (paper_id, page_no, seq, number_label, kind, text, options, answer_checked, proposed_option, difficulty, difficulty_by)
           values ($1, $2, $3, $4, 'mcq', $5, $6, false, $7, coalesce($8::text, 'medium'), case when $8::text is null then null else 'ai' end)`,
          [id, s.page_no, s.seq, s.number_label, it.text, it.options, it.answer, it.difficulty],
        );
      }
      return n;
    });
  } finally {
    await pool.query(`update paper_drafts set answer_claimed_at = null where id = any($1::uuid[])`, [stuck.map((s) => s.id)]).catch(() => {});
  }
  const more = room - replaced > 0 ? await q1<{ n: number }>(`select count(*) as n from paper_drafts where paper_id = $1 and ${UNSETTLED}`, [id]) : null;
  return c.json({ replaced, left: Number(more?.n ?? 0) });
});

// ---------------------------------------------------------------- checking and saving

paperRoutes.patch('/drafts/:id', async (c) => {
  const id = uuid(c.req.param('id'), 'draft id');
  const b = await readBody(c);
  const d = await tq1(
    tuitionOf(c).id,
    'select d.* from paper_drafts d join papers p on p.id = d.paper_id where d.id = $1 and p.tuition_id = @T',
    [id],
  );
  if (!d) throw notFound('This question');
  if (d.status === 'saved') throw new HttpError(409, 'saved', 'This question is already in the question bank. Edit it there.');

  let options: string[] | null = d.options;
  if ('options' in b) {
    if (!Array.isArray(b.options) || b.options.some((o: unknown) => typeof o !== 'string')) throw bad('options must be a list of text.');
    if (b.options.length > 12) throw bad('That is too many options.');
    options = b.options.map((o: string) => o.trim());
    // A draft may still be half-read (fewer or more than four options, some empty), but what it holds must be storable and bounded.
    // (A question saved from it needs four to six: see /papers/:id/save.)
    if (options!.some((o) => hasNul(o))) throw bad('An option has a character that cannot be used.');
    if (options!.some((o) => o.length > MAX_OPTION_CHARS)) throw bad(`An option is too long (max ${MAX_OPTION_CHARS} characters).`);
  }
  const kind = 'kind' in b ? (b.kind === 'mcq' ? 'mcq' : 'other') : d.kind;
  const marking = 'correct_option' in b;
  const correct = marking ? (b.correct_option === null ? null : int(b, 'correct_option', { min: 0, max: MAX_OPTIONS - 1 })) : d.correct_option;
  // The right option is one of the question's options: a mark on a fifth needs a fifth to mark.
  if (kind === 'mcq' && correct != null && options && correct >= options.length) throw bad('The right option must be one of the options.');
  const status = 'status' in b ? (b.status === 'discarded' ? 'discarded' : 'draft') : d.status;
  const text = 'text' in b ? str(b, 'text', { max: 4000 })! : d.text;
  // A question the teacher has reworded is new to AI, and one she says "looks right" is checked by
  // her: either way its note goes, and AI may look for its answer.
  const confirmed = b.confirmed === true && d.ai_note === 'unclear';
  const reworded = confirmed || text !== d.text || kind !== d.kind || JSON.stringify(options ?? []) !== JSON.stringify(d.options ?? []);
  // The tutor says a question AI thought needs a figure does not: AI was never asked for its answer (it cannot see figures), so now it may be.
  const figureFreed = 'needs_diagram' in b && b.needs_diagram !== true && d.needs_diagram === true;
  // A question the teacher has marked, reworded or brought back is hers now: AI never replaces it (see /papers/:id/replace). So is one
  // she has said needs its figure, or does not; and that word of hers the checks never undo (figure_by; see /papers/:id/answers).
  const figureSaid = 'needs_diagram' in b && (b.needs_diagram === true) !== d.needs_diagram;
  const handled = reworded || marking || (d.status === 'discarded' && status === 'draft') || figureSaid;
  // Where the figure was cut from, so cutting it again starts there. null forgets it.
  let figure: Placed | null | undefined;
  if ('figure_box' in b) {
    figure = b.figure_box === null ? null : cleanPlaced(b.figure_box);
    if (b.figure_box !== null && !figure) throw bad('figure_box must give the page and a box of four fractions of it.');
  }
  // How hard the tutor says the question is. A question always has a level, so there is no taking it away. What she sets is final: AI's own level never overwrites it.
  let level: Difficulty | undefined;
  if ('difficulty' in b) {
    level = difficultyOf(b.difficulty) ?? undefined;
    if (!level) throw bad('How hard a question is must be easy, medium or hard.');
  }
  const row = await q1(
    `update paper_drafts set text = $2, options = $3, kind = $4, correct_option = $5, chapter_id = $6,
                             difficulty = case when $14::boolean then $15::text else difficulty end,
                             difficulty_by = case when $14::boolean then 'tutor' else difficulty_by end,
                             needs_diagram = $7, image_key = $8, status = $9, figure_box = $13::jsonb,
                             cont_next = cont_next and not $11::boolean, cont_prev = cont_prev and not $11::boolean,
                             answer_source = case when $10 then (case when $5::smallint is null then null else 'teacher' end) else answer_source end,
                             ai_confidence = case when $10 then null else ai_confidence end,
                             ai_note = case when $11 or ($10 and $5::smallint is not null and ai_note in ('disagree', 'unsure', 'writer_differs'))
                                            then null else ai_note end,
                             ai_picks = case when $11 or ($10 and $5::smallint is not null) then null else ai_picks end,
                             ai_votes = case when $11 or ($10 and $5::smallint is not null) then null else ai_votes end,
                             answer_checked = case when ($11 or $16::boolean) and $5::smallint is null then false else answer_checked end,
                             answer_tries = case when $11 then 0 else answer_tries end,
                             figure_by = case when $17::boolean then 'tutor' else figure_by end,
                             edited = edited or $12
      where id = $1 returning *`,
    [
      id,
      text,
      options,
      kind,
      correct,
      'chapter_id' in b ? await ownChapter(tuitionOf(c).id, uuidOpt(b.chapter_id, 'chapter')) : d.chapter_id,
      'needs_diagram' in b ? b.needs_diagram === true : d.needs_diagram,
      'image_key' in b ? ownImageKey(tuitionOf(c).id, b.image_key, d.image_key) : d.image_key,
      status,
      marking,
      reworded,
      handled,
      asJson(figure === undefined ? d.figure_box : figure),
      level !== undefined,
      level ?? null,
      figureFreed,
      figureSaid,
    ],
  );
  return c.json({ draft: { ...row, image_url: await maybeViewUrl(row.image_key) } });
});

/** The tutor says a question AI joined from two pages was two: it goes back to what it was, and the second part to its own page. */
paperRoutes.post('/drafts/:id/unjoin', async (c) => {
  const id = uuid(c.req.param('id'), 'draft id');
  const d = await tq1(
    tuitionOf(c).id,
    'select d.* from paper_drafts d join papers p on p.id = d.paper_id where d.id = $1 and p.tuition_id = @T',
    [id],
  );
  if (!d) throw notFound('This question');
  if (!d.joined || d.status !== 'draft') throw new HttpError(409, 'not_joined', 'This question was not joined from two pages.');
  const rows = (await tx((cx) => unjoin(id, cx, true))).filter(Boolean);
  return c.json({ drafts: await Promise.all(rows.map(async (r: any) => ({ ...r, image_url: await maybeViewUrl(r.image_key) }))) });
});

/** Saves every checked multiple-choice draft into the question bank. */
paperRoutes.post('/papers/:id/save', async (c) => {
  const T = tuitionOf(c).id;
  const id = uuid(c.req.param('id'), 'paper id');
  const paper = await tq1(T, 'select * from papers where id = $1 and tuition_id = @T', [id]);
  if (!paper) throw notFound('This paper');
  const missing = missingOf(paper);
  if (missing.includes('class_level') || missing.includes('subject_id')) {
    throw new HttpError(409, 'needs_details', 'Choose the class and subject of this paper first.');
  }
  const result = await tx(async (cx) => {
    const ready = await q(
      `select * from paper_drafts where paper_id = $1 and status = 'draft' and kind = 'mcq'
          and correct_option is not null and array_length(options, 1) between ${MIN_OPTIONS} and ${MAX_OPTIONS} and correct_option < array_length(options, 1)
          and (not needs_diagram or image_key is not null)
        order by page_no, seq for update`,
      [id],
      cx,
    );
    // A question the bank already has (the same paper uploaded twice, or two papers sharing
    // questions) is not saved again.
    // A group's paper is compared with the questions of its class and subject, a course's with the course's own.
    const bank = await tq<{ text: string; options: string[] }>(
      T,
      `select text, options from questions where tuition_id = @T and course_id is not distinct from $3::uuid
          and class_level is not distinct from $1::smallint and subject_id is not distinct from $2::uuid`,
      [paper.class_level, paper.subject_id, paper.course_id],
      cx,
    );
    const have = new Set(bank.map((x) => sameKey(x.text, x.options)));
    let already = 0;
    for (const d of ready) {
      const k = sameKey(d.text, d.options);
      if (have.has(k)) {
        await cx.query(`update paper_drafts set status = 'discarded', ai_note = 'in_bank' where id = $1`, [d.id]);
        already++;
        continue;
      }
      have.add(k);
      const qrow = await q1(
        `insert into questions (tuition_id, class_level, chapter_id, text, options, correct_option, keep_option_order, image_key, source, paper_id,
                                created_by, subject_id, course_id, difficulty, difficulty_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'paper', $9, $10, $11, $12, coalesce($13::text, 'medium'), $14) returning id`,
        [T, paper.class_level, d.chapter_id ?? paper.chapter_id, d.text, d.options, d.correct_option, mustKeepOrder(d.options), d.image_key, id,
          c.get('user').id, paper.subject_id, paper.course_id, d.difficulty, d.difficulty_by],
        cx,
      );
      await cx.query(`update paper_drafts set status = 'saved', question_id = $2 where id = $1`, [d.id, qrow.id]);
    }
    const left = await q1(
      `select count(*) as n from paper_drafts where paper_id = $1 and status = 'draft' and kind = 'mcq'`,
      [id],
      cx,
    );
    return { saved: ready.length - already, already_in_bank: already, still_to_check: left.n };
  });
  return c.json(result);
});

/** Deletes a paper, its pages and the questions saved from it. Questions a test uses stay in the bank. */
paperRoutes.delete('/papers/:id', async (c) => {
  const T = tuitionOf(c).id;
  const id = uuid(c.req.param('id'), 'paper id');
  if (!(await tq1(T, 'select 1 as x from papers where id = $1 and tuition_id = @T', [id]))) throw notFound('This paper');
  const keys = await q<{ object_key: string }>(
    `select object_key from paper_pages where paper_id = $1
     union all select image_key from paper_drafts where paper_id = $1 and image_key is not null and question_id is null`,
    [id],
  );
  const result = await tx(async (cx) => {
    const gone = await cx.query(
      `delete from questions qq where qq.paper_id = $1 and not exists (select 1 from test_questions tq where tq.question_id = qq.id)`,
      [id],
    );
    const kept = await q1('select count(*) as n from questions where paper_id = $1', [id], cx);
    await cx.query('delete from papers where id = $1', [id]);
    return { questions_deleted: gone.rowCount ?? 0, questions_kept: kept.n };
  });
  await deleteObjects(keys.map((k) => k.object_key)).catch(() => {});
  return c.json({ ok: true, ...result });
});
