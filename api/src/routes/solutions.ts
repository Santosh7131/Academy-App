import { Hono } from 'hono';
import { tuitionOf, type AppEnv } from '../lib/auth.ts';
import { balanceOf, chargeSolutions, hold, release } from '../lib/credit.ts';
import { tq, tq1, tx } from '../lib/db.ts';
import { chat, SOLUTION_MODELS } from '../lib/groq.ts';
import { bad, notFound, uuid } from '../lib/http.ts';
import { studyOf } from '../lib/levels.ts';
import { readSolutions, solutionMessages, SOLUTIONS_PER_REQUEST, type SolutionOutcome } from '../lib/solutions.ts';
import { readBody } from './body.ts';

// Mounted behind requireUser('teacher') in index.ts.
export const solutionRoutes = new Hono<AppEnv>();

/** How long one request may wait for the model: a few questions take seconds, a busy model is cut off before the app gives up. */
const SOLUTIONS_WAIT_MS = 100_000;

/** What came of one question, as the app is told. A question that had a solution already is left as it was. */
type Outcome = SolutionOutcome | { kind: 'has_solution' };

const outcomeOut = (id: string, o: Outcome) => ({
  id,
  outcome: o.kind,
  ...(o.kind === 'written' ? { solution: o.steps } : {}),
  ...(o.kind === 'different' ? { ai_answer: o.answer } : {}),
  ...(o.kind === 'unusable' ? { why: o.why } : {}),
});

/**
 * Worked solutions for some of a test's questions, written by AI (lib/solutions.ts): the app sends a few question ids at a time and
 * shows how far it has got. One call to the model answers them all. The price of each question that has no solution is set aside
 * first (402 when the credit does not cover it); a solution is kept only when AI's own working reached the marked answer, and is
 * charged in the transaction that saves it. The save takes a question only while it still has no solution, so a solution a tutor
 * wrote meanwhile, or one a request repeated after a lost reply already saved, stays as it is and is not charged again.
 */
solutionRoutes.post('/tests/:id/solutions', async (c) => {
  const T = tuitionOf(c).id;
  const testId = uuid(c.req.param('id'), 'test id');
  const b = await readBody(c);
  const ids = b.question_ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > SOLUTIONS_PER_REQUEST) {
    throw bad(`Send from 1 to ${SOLUTIONS_PER_REQUEST} question ids.`);
  }
  const wanted = [...new Set(ids.map((x) => uuid(x, 'question id')))];
  const test = await tq1<{ title: string; class_level: number | null; course: string | null; subject: string | null }>(
    T,
    `select t.title, t.class_level, (select name from courses where id = t.course_id) as course,
            (select name from subjects where id = t.subject_id) as subject
       from tests t where t.id = $1 and t.tuition_id = @T`,
    [testId],
  );
  if (!test) throw notFound('This test');
  const rows = await tq<{ id: string; text: string; options: string[]; correct_option: number; solution: string | null; image_key: string | null }>(
    T,
    `select qq.id, qq.text, qq.options, qq.correct_option, qq.solution, qq.image_key
       from test_questions tq join questions qq on qq.id = tq.question_id
      where tq.test_id = $1 and qq.id = any($2::uuid[]) and qq.tuition_id = @T`,
    [testId, wanted],
  );
  if (rows.length !== wanted.length) throw notFound('A question of this test');

  const outcomes = new Map<string, Outcome>();
  const todo = rows.filter((r) => {
    if (!r.solution?.trim()) return true;
    outcomes.set(r.id, { kind: 'has_solution' });
    return false;
  });
  let balance: number | null = null;
  if (todo.length) {
    const held = await hold(T, { solutions: todo.length });
    try {
      const study = test.class_level == null ? null : await studyOf(T, test.class_level);
      const { content } = await chat({
        task: 'worked_solutions', userId: c.get('user').id, tuitionId: T, models: SOLUTION_MODELS, json: true, maxTokens: 8000, reasoning: 'medium',
        deadline: Date.now() + SOLUTIONS_WAIT_MS, messages: solutionMessages({ study, subject: test.subject, course: test.course }, todo),
      });
      const read = readSolutions(content, todo);
      balance = await tx(async (cx) => {
        let saved = 0;
        for (const r of todo) {
          const o = read.get(r.id)!;
          if (o.kind !== 'written') {
            outcomes.set(r.id, o);
            continue;
          }
          const kept = await tq1(
            T,
            `update questions set solution = $2, solution_by_ai = true, updated_at = now()
              where id = $1 and tuition_id = @T and coalesce(btrim(solution), '') = '' returning id`,
            [r.id, o.steps],
            cx,
          );
          outcomes.set(r.id, kept ? o : { kind: 'has_solution' });
          if (kept) saved++;
        }
        return chargeSolutions(cx, T, held, { count: saved, testId, label: test.title });
      });
    } finally {
      await release(held);
    }
  }
  const written = [...outcomes.values()].filter((o) => o.kind === 'written').length;
  return c.json({
    solutions: wanted.map((id) => outcomeOut(id, outcomes.get(id)!)),
    written,
    credit_paise: balance ?? (await balanceOf(T)).balance,
  });
});
