import { fixLatexEscapes, realNewlines } from './latex-json.ts';
import { letterOf } from './options.ts';
import { asciiDigits } from './text.ts';

/**
 * Worked solutions written by AI (api/migrations/037_worked_solutions.sql, routes/solutions.ts). The model works each question out
 * on its own and is never told the answer the tutor marked, so a wrong key cannot talk it into a wrong derivation; what it writes
 * is kept only when the option it reaches is the marked one. Students see a test's options in an order of their own, so a solution
 * may name an option only by what it says, never by its letter or its place. Nothing here touches the database or a model.
 */

/** The most questions one request may ask for. One call to the model answers them all, and a few at a time keeps it quick. */
export const SOLUTIONS_PER_REQUEST = 4;

/** The longest solution kept: the question editor takes nothing longer (`solution` in routes/teacher.ts). */
export const MAX_SOLUTION = 4000;

export type SolvableQuestion = { id: string; text: string; options: string[]; correct_option: number; image_key?: string | null };

/** What came of one question: a solution to keep, or why there is none. Only a kept solution is charged. */
export type SolutionOutcome =
  | { kind: 'written'; steps: string }
  /** The working reached another option, or none (null): the marked answer may be wrong, or the working is. */
  | { kind: 'different'; answer: number | null }
  /** It cannot be worked out without a figure the model cannot see. */
  | { kind: 'figure' }
  /** Nothing usable came back for it: no reply, an empty one, one too long to keep, or one naming an option by its letter. */
  | { kind: 'unusable'; why: 'no_reply' | 'empty' | 'too_long' | 'names_option' };

/** Who the questions are for, as the model is told: a level ("Class 9 CBSE") and a subject, or a course's name. */
export type Audience = { study: string | null; subject: string | null; course?: string | null };

/** The messages that ask for the worked solutions of `qs`, which the model knows as q1, q2 and so on. */
export function solutionMessages(to: Audience, qs: SolvableQuestion[]) {
  const subject = to.subject ? ` ${to.subject}` : '';
  const pupils = to.course ? `students of a course called ${to.course}` : to.study ? `${to.study} students` : 'students';
  const asked = qs.map((q, i) => ({
    id: `q${i + 1}`,
    question: q.text,
    options: Object.fromEntries(q.options.map((o, k) => [letterOf(k), o])),
    ...(q.image_key ? { has_figure: true } : {}),
  }));
  return [
    {
      role: 'system' as const,
      content: `You are a patient${subject} teacher in India who writes worked solutions for ${pupils}. The questions may be in English, Hindi or Tamil, or mix them; you read and write all three equally well.`,
    },
    {
      role: 'user' as const,
      content: `Write the worked solution of each multiple-choice question, as you would on the board for a student who chose a wrong option. Reply only as JSON:
{"solutions":[{"id":"q1","figure":false,"steps":"...","answer":"B"}]}
- Work each question out yourself, step by step, before you look for the option that matches. Write "steps" before "answer".
- "steps" is the working in short steps, one to a line: at most 8 lines and 700 characters, in the language the question is written in. Show the method and the working a student needs, and nothing else.
- End "steps" with the result itself, such as "So $x = 5$." or "So 29 is the prime number." Never name an option by its letter or its place ("option B", "(b)", "the second option", "answer B"): each student sees the options in a different order.
- Write maths in LaTeX between single $ signs, such as $\\frac{3}{4}$, $x^2$ or $\\sqrt{2}$.
- "answer" is the letter of the option your working reaches, or "" when it reaches none of them.
- "figure" is true when the question cannot be worked out without a figure, graph or picture that is not given in words. Then "steps" and "answer" are "". A question with "has_figure" comes with a figure you cannot see: work it out only when its words give everything needed.
Questions:
${JSON.stringify(asked)}`,
    },
  ];
}

/** "[Oo][Pp]...": a word in any case, for patterns whose option letter must keep its case. */
const anyCase = (word: string) => [...word].map((ch) => (/[a-z]/i.test(ch) ? `[${ch.toUpperCase()}${ch.toLowerCase()}]` : ch)).join('');

/** A letter in brackets ("(b)", "(B)"), or a capital standing alone ("B"). A bare small letter is a word ("a prime number"). */
const LETTER = String.raw`(?:\(\s*[A-Fa-f]\s*\)|(?<![\p{L}\p{N}])[A-F](?![\p{L}\p{N}]))`;
/** After "option" a small letter standing alone is one too ("option b"). */
const ANY_LETTER = String.raw`(?:\(\s*[A-Fa-f]\s*\)|(?<![\p{L}\p{N}])[A-Fa-f](?![\p{L}\p{N}]))`;
/** Option letters as Hindi and Tamil papers print them: (क) (ख) (ग) (घ), (அ) (ஆ) (இ) (ஈ). */
const INDIC_LETTER = String.raw`\(\s*[कखगघङअआइईஅஆஇஈஉ]\s*\)`;

/** A word starting here, not inside another ("ans" in "trans", "option" in "adoption"). */
const START = String.raw`(?<!\p{L})`;

/** Ways a solution names an option by its letter or place, which is wrong on a student's screen: the options are mixed up for each. */
const OPTION_REFERENCES = [
  // "option B", "option (b)", "choice C", "options a"
  new RegExp(String.raw`${START}(?:${anyCase('option')}|${anyCase('choice')}|${anyCase('alternative')})s?\s*(?:${anyCase('no')}\.?\s*)?${ANY_LETTER}`, 'u'),
  // "answer is B", "Answer: (b)", "Ans. C"
  new RegExp(String.raw`${START}(?:${anyCase('answer')}|${anyCase('ans')}\.?)\s*(?:${anyCase('is')}|:|=|-|–)?\s*${LETTER}`, 'u'),
  // "(b) is correct.", "B is the right answer", but not "B is the right angle"
  new RegExp(
    String.raw`${LETTER}\s+${anyCase('is')}\s+(?:${anyCase('the')}\s+)?(?:${anyCase('correct')}|${anyCase('right')})(?:\s+(?:${anyCase('answer')}|${anyCase('option')}|${anyCase('choice')}|${anyCase('one')}))?(?=\s*[.!,;)]|\s*$)`,
    'um',
  ),
  // "the second option", "last choice"
  new RegExp(String.raw`${START}(?:${['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'last'].map(anyCase).join('|')})\s+(?:${anyCase('option')}|${anyCase('choice')})`, 'u'),
  // विकल्प (ख), उत्तर (B), விடை (ஆ)
  new RegExp(String.raw`(?:विकल्प|उत्तर|விடை|தேர்வு)\s*[:\-–]?\s*(?:${INDIC_LETTER}|${ANY_LETTER})`, 'u'),
];

/** Whether a solution names an option by its letter or its place rather than by what it says. Triangle ABC and f(a) are not. */
export const namesAnOption = (s: string) => OPTION_REFERENCES.some((r) => r.test(s));

/**
 * The option a reply's "answer" names, as a number from 0: a letter ("B", "(b)", "b.", "B) 25", "Option B"), or the option's own
 * words. Null when it names none, more than one ("A, C"), or a letter the question does not have.
 */
export function optionNamed(v: unknown, options: string[]): number | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  const same = (a: string) => a.replace(/\s+/g, ' ').trim().toLowerCase();
  const byWords = options.flatMap((o, i) => (same(o) === same(s) ? [i] : []));
  if (byWords.length === 1) return byWords[0];
  const m = /^(?:(?:option|answer|choice|ans)\.?\s*[:\-–]?\s*)?(?:\(\s*([A-Fa-f])\s*\)|([A-Fa-f])(?=\s*[).:]|$))/i.exec(s);
  const letter = m?.[1] ?? m?.[2];
  if (!letter) return null;
  const i = letter.toUpperCase().charCodeAt(0) - 65;
  return i < options.length ? i : null;
}

/** LaTeX commands that start with n, which a \n in front of a word may be. */
const LATEX_N = /^n(?:e|eq|u|i|ot|otin|abla|mid|sim|cong|less|gtr|leq|geq|parallel|rightarrow|leftarrow|subseteq|atural)(?![A-Za-z])/;

/**
 * Line breaks a model wrote as the two characters \n (it escaped the JSON twice), made real. lib/latex-json.ts's realNewlines leaves
 * one before a letter alone in case it is LaTeX; a solution's lines nearly all start with a word ("\nSo x = 5"), so here only the
 * LaTeX commands that start with n (\neq, \nu, \not) are left.
 */
const lineBreaks = (s: string) => realNewlines(s).replace(/\\n/g, (m, at: number, all: string) => (LATEX_N.test(all.slice(at + 1)) ? m : '\n'));

/** A solution as it is kept (line breaks real, digits plain, blank lines squeezed), or why it cannot be kept. */
export function cleanSteps(v: unknown): { steps: string } | { why: 'empty' | 'too_long' | 'names_option' } {
  if (typeof v !== 'string') return { why: 'empty' };
  const s = lineBreaks(asciiDigits(v))
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(/^(?:worked\s+)?(?:solution|steps)\s*:\s*/i, '');
  if (!s) return { why: 'empty' };
  if (s.length > MAX_SOLUTION) return { why: 'too_long' };
  if (namesAnOption(s)) return { why: 'names_option' };
  return { steps: s };
}

/** The list of answers a reply holds, whatever shape the model chose: {"solutions": [...]}, a bare list, or one bare answer. */
function answersIn(content: string, single: boolean): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fixLatexEscapes(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')));
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return [];
  const o = parsed as Record<string, unknown>;
  if (Array.isArray(o.solutions)) return o.solutions;
  const other = Object.values(o).find(Array.isArray);
  if (other) return other as unknown[];
  // Asked about one question, a model may answer with that one answer alone.
  return single && ('steps' in o || 'answer' in o || 'figure' in o) ? [{ ...o, id: 'q1' }] : [];
}

/** What came of each of `qs` in the model's reply, by question id. A question the reply leaves out is 'unusable' ('no_reply'). */
export function readSolutions(content: string, qs: SolvableQuestion[]): Map<string, SolutionOutcome> {
  const out = new Map<string, SolutionOutcome>();
  for (const a of answersIn(content, qs.length === 1)) {
    if (!a || typeof a !== 'object') continue;
    const r = a as Record<string, unknown>;
    const q = qs[Number(String(r.id ?? '').replace(/^q/i, '')) - 1];
    if (!q || out.has(q.id)) continue;
    if (r.figure === true || r.figure === 'true') {
      out.set(q.id, { kind: 'figure' });
      continue;
    }
    const answer = optionNamed(r.answer, q.options);
    if (answer !== q.correct_option) {
      out.set(q.id, { kind: 'different', answer });
      continue;
    }
    const s = cleanSteps(r.steps);
    out.set(q.id, 'steps' in s ? { kind: 'written', steps: s.steps } : { kind: 'unusable', why: s.why });
  }
  for (const q of qs) if (!out.has(q.id)) out.set(q.id, { kind: 'unusable', why: 'no_reply' });
  return out;
}
