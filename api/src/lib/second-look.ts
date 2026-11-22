// A page read sometimes loses the choices of questions that print them: one run in four over a photographed, sideways book page (paper
// 50fe7af2, 2026-11-15) gave three of its questions no choices at all. A multiple-choice question without its choices is stored as a
// written-answer question, where the tutor can easily miss it, and AI never answers it. So when a page that is mostly multiple choice
// gives questions without their choices, those questions are read once more, on their own (choicesPrompt in routes/papers.ts). An
// ordinary page never gets this look.
import { isWholeList, MIN_OPTIONS } from './options.ts';
import { looksLikeAssertionReason } from './shared.ts';
import { asciiDigits } from './text.ts';

type Item = { number?: unknown; kind?: unknown; text?: unknown; options?: unknown; continues_on_next_page?: unknown; continues_from_previous_page?: unknown };

/** The most questions one second look asks about. */
const MOST = 6;

const label = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');
/** A printed number, for comparing: "Q 9.", "9)" and "९" are all 9. */
const key = (v: unknown) =>
  asciiDigits(label(v)).toLowerCase().replace(/^(q(uestion)?|प्रश्न|प्र|வினா)\.?\s*/u, '').replace(/[^\p{L}\p{M}\p{N}]/gu, '');
const choicesOf = (it: { options?: unknown }) => (Array.isArray(it.options) ? it.options.filter((o): o is string => typeof o === 'string' && !!o.trim()) : []);
/** Words or choices without spacing, punctuation or LaTeX commands, so the same thing read twice compares equal. */
const squash = (s: string) => asciiDigits(s).toLowerCase().replace(/\\[a-z]+/g, '').replace(/[^\p{L}\p{M}\p{N}]/gu, '');

/** A question that came with all its choices. */
const whole = (it: Item) => it.kind === 'mcq' && choicesOf(it).length >= MIN_OPTIONS;

/**
 * The printed numbers of the questions a page read gave no choices (or too few), when the page is mostly multiple choice: the ones to
 * read again. Left out: a question cut by the page edge (its choices can be on the other page), Assertion and Reason questions (their
 * key is looked for on its own, see withPrintedKeys), a question with no number (the look could not name it), and passages.
 */
export function lostChoices(items: Item[]): string[] {
  const questions = items.filter((it) => it.kind !== 'passage');
  const lost = questions.filter(
    (it) =>
      choicesOf(it).length < MIN_OPTIONS &&
      it.continues_on_next_page !== true &&
      it.continues_from_previous_page !== true &&
      key(it.number) !== '' &&
      !looksLikeAssertionReason(it.text),
  );
  const mcq = questions.filter(whole).length;
  if (!lost.length || mcq < 2 || mcq < lost.length) return [];
  return lost.slice(0, MOST).map((it) => label(it.number));
}

/**
 * The last words the read gave each of [numbers] (about the last 100 characters, from a word start), so the second look knows where each
 * question ended: on a page of two columns a question can end at the top of the next column, its choices with it.
 */
export function lastWordsOf(items: Item[], numbers: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of numbers) {
    const it = items.find((x) => label(x.number) === n);
    const words = typeof it?.text === 'string' ? it.text.replace(/\s+/g, ' ').trim() : '';
    if (words) out[n] = words.length > 100 ? `…${words.slice(-100).replace(/^\S*\s/, '')}` : words;
  }
  return out;
}

/** A question as the second look read it: its printed number, its words and its choices. */
export type Reread = { number: string; text: string; options: string[] };

/** The second look's list, each entry checked: a number, words (which may be empty) and its choices. */
export function cleanRereads(raw: unknown): Reread[] {
  return (Array.isArray(raw) ? raw : [])
    .flatMap((r: any) => {
      const number = label(r?.number);
      if (!number) return [];
      const options = (Array.isArray(r?.options) ? r.options : []).filter((o: unknown): o is string => typeof o === 'string').map((o: string) => o.trim()).filter(Boolean);
      return [{ number, text: typeof r?.text === 'string' ? r.text.trim() : '', options: options.slice(0, 10) }];
    })
    .slice(0, 20);
}

/**
 * The page's questions with what the second look found. A question that came without its choices takes the ones read now when they are
 * a whole list (four to `max`) and are not another question's choices on the page (a look that strayed to a neighbour). Its words are
 * replaced only when the new ones hold all of the old (more of the question was read, such as the table it was printed with); everything
 * else stays as the first read gave it.
 */
export function applyRereads<T extends Item>(items: T[], rereads: Reread[], max = MIN_OPTIONS): { items: T[]; fixed: number } {
  if (!rereads.length) return { items, fixed: 0 };
  const asked = new Set(lostChoices(items).map(key));
  const taken = items.filter(whole).map((it) => squash(choicesOf(it).join('|')));
  let fixed = 0;
  const out = items.map((it) => {
    const k = key(it.number);
    if (!asked.has(k) || choicesOf(it).length >= MIN_OPTIONS) return it;
    const r = rereads.find((x) => key(x.number) === k);
    if (!r || !isWholeList(r.options, max)) return it;
    const mine = squash(r.options.join('|'));
    if (taken.includes(mine)) return it;
    taken.push(mine);
    fixed++;
    const before = typeof it.text === 'string' ? it.text : '';
    const text = r.text && squash(r.text).includes(squash(before)) ? r.text : before;
    return { ...it, kind: 'mcq', options: [...r.options], text };
  });
  return { items: out, fixed };
}
