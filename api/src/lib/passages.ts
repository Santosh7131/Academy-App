// A passage, case study or set of facts printed on one page can serve questions at the top of the next, and a page is read on its own,
// so the reader of the next page never sees it. Seen in real papers (2026-11-15): a case study whose third question is the first line of
// the next page, and a passage printed alone at the foot of a page with the graph and all five of its questions on the next. The reader
// starts every question printed under a passage with that passage (then a blank line), which these helpers lean on; a passage printed
// alone at the foot of a page it gives as an item of its own (kind "passage"). The page reader was also asked to mark the questions
// that need the page before, and never once did: the decision is made here, from what the pages say.

import { looksLikeAssertionReason } from './shared.ts';

/** The shortest passage worth carrying: anything shorter is a heading or a line of instructions. */
const MIN_PASSAGE = 40;
/** A passage printed alone at the foot of a page is a few sentences at least; a short line there is a heading or a note. */
const MIN_ALONE = 60;
const NOT_A_PASSAGE = /^\s*(section|part|instructions?|note|general instructions|directions?|for each question|in (each of )?the following questions)\b/i;

/**
 * Two statements to judge (an Assertion and a Reason, or Statement-1 and Statement-2), or the key printed above such questions. These
 * come in a section of their own (paper 52e8c52d: "SECTION B – ASSERTION AND REASON" straight after the last case study's questions),
 * never as a case study's questions.
 */
function twoStatements(text: string): boolean {
  return looksLikeAssertionReason(text) || (/statement[\s-]*(1|i|one)\b/i.test(text) && /statement[\s-]*(2|ii|two)\b/i.test(text));
}

type Item = { kind?: unknown; text?: unknown };

/**
 * A page read's items without any passage the reader gave as an item of its own. Only a passage that is the page's last item is kept
 * (returned as `passageEnd`): its questions all come on the next page. One anywhere else is dropped, as its questions under it carry it
 * already.
 */
export function takePassages<T extends Item>(items: T[]): { items: T[]; passageEnd: string | null } {
  const isPassage = (it: T) => it.kind === 'passage';
  const last = items.length ? items[items.length - 1] : null;
  const end = last && isPassage(last) && typeof last.text === 'string' ? last.text.trim() : '';
  const passageEnd = end.length >= MIN_ALONE && !NOT_A_PASSAGE.test(end) && !twoStatements(end) ? end : null;
  return { items: items.filter((it) => !isPassage(it)), passageEnd };
}

/** The passage two questions both start with: their common opening, up to the last blank line inside it. Null when they share none. */
export function sharedPassage(a: string, b: string): string | null {
  return sharedBlock(a, b);
}

function sharedBlock(a: string, b: string): string | null {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  const cut = a.slice(0, n).lastIndexOf('\n\n');
  if (cut < MIN_PASSAGE) return null;
  const block = a.slice(0, cut).trim();
  // Each of them must still be a question after it.
  if (!a.slice(cut).trim() || !b.slice(cut).trim()) return null;
  return block.length >= MIN_PASSAGE ? block : null;
}

/** Words too common to tie a question to a passage. */
const COMMON = new Set(
  ('this that these those with from have will would what which when where whose there their them then than into onto upon each every ' +
    'other some such only also more most many much very same both does done been being were about after before below above between ' +
    'given following find value values correct option options answer answers question questions number numbers total true false ' +
    'statement statements based information represent represents represented representing denote denotes denoted shown show shows ' +
    'used using take taken takes make made type kind case study passage read here').split(' '),
);

/** A text's own words: four letters or more, not common ones, with a plural's ending dropped. */
function wordsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().replace(/\\[a-z]+/g, ' ').match(/[\p{L}\p{M}]{4,}/gu) ?? []) {
    if (!COMMON.has(w)) out.add(w.replace(/(es|s)$/, ''));
  }
  return out;
}

/**
 * A question could be one of a passage's: it shares a word of its own with the passage, or has no words of its own ("Find x + y.").
 * The wire's questions after a motorboat's passage ("Name the shape in which the wire is bent") share none, which is how the motorboat's
 * passage was handed to them when the reader missed the wire's own passage at the foot of the page (paper 52e8c52d, two runs of four).
 */
function speaksOf(question: string, passage: string): boolean {
  const own = wordsOf(question);
  if (!own.size) return true;
  const there = wordsOf(passage);
  for (const w of own) if (there.has(w)) return true;
  return false;
}

/** A question that starts with a passage of its own: it shares its opening block with the question before or after it. */
function hasOwnPassage(texts: string[], i: number): boolean {
  return (i > 0 && sharedBlock(texts[i - 1], texts[i]) != null) || (i + 1 < texts.length && sharedBlock(texts[i], texts[i + 1]) != null);
}

/** A question number written the way it is printed, for comparing: "Q 10 (iii)." is "10(iii)". */
const norm = (label: string | null | undefined) =>
  String(label ?? '').toLowerCase().replace(/^\s*(q\.?|question|प्रश्न|வினா)\s*/, '').replace(/[\s.:]+/g, '').replace(/\)+$/, ')');

const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii'];

/** The numbers that could come right after `label`: 11 after 10, (iv) after (iii), (c) after (b), 10(iv) after 10(iii). */
function nextLabels(label: string | null | undefined): string[] {
  const l = norm(label);
  const m = /^(.*?)(\(?)([0-9]+|[a-z]+)(\)?)$/.exec(l);
  if (!m) return [];
  const [, pre, open, core, close] = m;
  const out: string[] = [];
  if (/^\d+$/.test(core)) out.push(String(Number(core) + 1));
  const r = ROMAN.indexOf(core);
  if (r >= 0 && r + 1 < ROMAN.length) out.push(ROMAN[r + 1]);
  if (/^[a-z]$/.test(core) && core !== 'z') out.push(String.fromCharCode(core.charCodeAt(0) + 1));
  return out.map((c) => `${pre}${open}${c}${close}`);
}

/** `label` comes right after `prev` in the paper's numbering. */
export function continues(prev: string | null | undefined, label: string | null | undefined): boolean {
  const l = norm(label);
  return !!l && nextLabels(prev).includes(l);
}

/** The first number of a group that numbers its own questions: 1, (i), (a), or 10(i). */
export function firstLabel(label: string | null | undefined): boolean {
  return /(^|\()(1|i|a)\)?$/.test(norm(label));
}

/** A question of the page before, in page order. */
export type Before = { label: string | null; text: string };
/** A question at the top of this page, in page order. */
export type Top = {
  label: string | null;
  text: string;
  /**
   * The reader said it carries on from the page before. The rest of a question cut by the page edge has no number of its own and is
   * passed over (it is joined to its first part). One with a number had nothing to join (paper 3fa18690: "3. If the kitchen is 5 m
   * deep, find its area." under the house's case study on the page before) and is a question of its own: what the reader felt it
   * carried on from is its passage.
   */
  contPrev: boolean;
  /** The reader found it unclear or said it needs a figure: something it speaks of is missing from its words. */
  wanting: boolean;
  /** The tutor has changed it: it is left as she has it. */
  edited: boolean;
};

/**
 * The passage the page before hands on, and which of this page's questions get it: the run of questions at the top of the page that
 * have no passage of their own (after the rest of a question cut by the page edge). Null when nothing is handed on.
 *
 * The run ends at a question with a passage of its own (the next group) and at two statements to judge (a section of their own).
 *
 * - A passage printed alone at the foot of the page before (`passageEnd`): its questions all come on this page, so the run gets it, as
 *   far as the numbering runs on unbroken (a question numbered afresh starts another section).
 * - Otherwise, the passage the last questions of the page before share: only questions that carry on their numbering and that speak of
 *   what the passage speaks of (see speaksOf: a question that only follows on by number is the next group's). A group that
 *   numbers its own questions (1, 2 there, 3 here) is enough; with the paper's own numbering (16, 17 there, 18 here) the question must also
 *   be one the reader found wanting, as a question of its own that merely comes next has all it needs.
 * - A single question at the foot of the page before that starts with a passage and the number 1, (i) or (a): only the questions that
 *   carry on its numbering and that the reader found wanting.
 */
export function carryPlan(passageEnd: string | null, before: Before[], top: Top[]): { passage: string; give: number[] } | null {
  const texts = top.map((t) => t.text);
  // The run at the top of this page with no passage of its own.
  const run: number[] = [];
  for (let i = 0; i < top.length && run.length < 10; i++) {
    if (i === 0 && top[i].contPrev && !norm(top[i].label)) continue;
    if (hasOwnPassage(texts, i) || twoStatements(top[i].text)) break;
    run.push(i);
  }
  if (!run.length) return null;
  const free = (i: number) => !top[i].edited;

  if (passageEnd) {
    const give: number[] = [];
    let prev: string | null = null;
    for (const [k, i] of run.entries()) {
      if (k > 0 && !continues(prev, top[i].label)) break;
      prev = top[i].label;
      if (free(i) && !top[i].text.startsWith(passageEnd)) give.push(i);
    }
    return give.length ? { passage: passageEnd, give } : null;
  }

  const n = before.length;
  if (!n) return null;
  let passage: string | null = null;
  let from = n - 1;
  if (n >= 2) passage = sharedBlock(before[n - 2].text, before[n - 1].text);
  if (passage) {
    from = n - 2;
    while (from > 0 && before[from - 1].text.startsWith(`${passage}\n`)) from--;
  } else {
    // One question at the foot of the page, under a passage that starts a group: "Case Study 3 ... 1. ...".
    const last = before[n - 1];
    const cut = last.text.lastIndexOf('\n\n');
    const block = cut > 0 ? last.text.slice(0, cut).trim() : '';
    if (block.length >= 80 && last.text.slice(cut).trim() && firstLabel(last.label)) passage = block;
  }
  // An Assertion and Reason key shared by the last questions is no passage.
  if (!passage || twoStatements(passage)) return null;
  const single = from === n - 1;
  const ownNumbers = !single && firstLabel(before[from].label);
  const give: number[] = [];
  let prev = before[n - 1].label;
  for (const i of run) {
    if (!continues(prev, top[i].label)) break;
    prev = top[i].label;
    if (!ownNumbers && !top[i].wanting) break;
    if (!speaksOf(top[i].text, passage)) break;
    if (free(i) && !top[i].text.startsWith(passage)) give.push(i);
  }
  return give.length ? { passage, give } : null;
}
