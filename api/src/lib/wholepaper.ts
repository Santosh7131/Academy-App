// Reading a paper a few pages to a request instead of one request for each page: the model sees the pages next to each other, so a key
// printed once above a group of questions, or a question that runs over a page edge, is in front of it when it writes the question.
// Pure functions with no database and no network, so tools/wholepaper-test.mjs can check them.
import { fixLatexEscapes } from './latex-json.ts';

/** The most pages one request holds. A page takes about 800 tokens to write and a dense Hindi or Tamil one several times that. */
export const WINDOW_PAGES = 4;

/**
 * The pages to read, split into the requests that read them. A request holds only pages that follow one another, and the pages are
 * shared out evenly (nine pages are three of three, not four, four and one), so no request is much slower than the others.
 */
export function planWindows(pageNos: readonly number[], max = WINDOW_PAGES): number[][] {
  const sorted = [...new Set(pageNos)].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
  const runs: number[][] = [];
  for (const n of sorted) {
    const run = runs[runs.length - 1];
    if (run && run[run.length - 1] === n - 1) run.push(n);
    else runs.push([n]);
  }
  const out: number[][] = [];
  for (const run of runs) {
    const count = Math.ceil(run.length / Math.max(max, 1));
    const base = Math.floor(run.length / count);
    const extra = run.length % count;
    let at = 0;
    for (let i = 0; i < count; i++) {
      const size = base + (i < extra ? 1 : 0);
      out.push(run.slice(at, at + size));
      at += size;
    }
  }
  return out;
}

/** What a request read from one page: its question items and the answer key it prints, both as the model wrote them. */
export type PageRead = { items: unknown[]; key: unknown[] };

const tryParse = (text: string): unknown => {
  try {
    return JSON.parse(fixLatexEscapes(text));
  } catch {
    return undefined;
  }
};

/**
 * A reply that was cut off part way (the model ran out of room) still holds the pages it finished: the text is cut back to the start
 * of its last page entry and closed. Null when not even a first page is whole.
 */
function salvage(text: string): unknown {
  // Cut right after a whole page: closing the list is all it needs.
  const closed = tryParse(`${text.replace(/[\s,]+$/, '')}]}`);
  if (closed !== undefined) return closed;
  const starts = [...text.matchAll(/\{\s*"page"\s*:/g)].map((m) => m.index ?? 0);
  for (let k = starts.length - 1; k >= 1; k--) {
    const tried = tryParse(`${text.slice(0, starts[k]).replace(/[\s,]+$/, '')}]}`);
    if (tried !== undefined) return tried;
  }
  return undefined;
}

const pageNumber = (v: unknown) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v.replace(/\D+/g, ''), 10) : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * The box of the second part of a question that a together-read folded into one (see absorbRests). Kept beside the item, not in it, so
 * nothing a model writes can put a box there.
 */
export const restBoxes = new WeakMap<object, { page: number; box: unknown }[]>();

type Item = { text?: unknown; options?: unknown; kind?: unknown; continues_on_next_page?: unknown; continues_from_previous_page?: unknown; question_box?: unknown };

const sameWords = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
const wordsOf = (options: unknown) => (Array.isArray(options) ? options.map(sameWords).filter(Boolean) : []);

/**
 * Seeing both pages, a model often writes a question that runs over a page edge whole, and then lists its rest on the next page too,
 * with what it has already given: the whole question on the page it starts on, or the whole list of options on the page it ends on.
 * Such a rest says nothing new, so it is folded into the question (its box is kept in restBoxes, for the question's picture). A rest that
 * holds an option or words the question lacks is left alone, for the join that reads pages one by one use (joinSplits in routes/papers.ts).
 * `reads` is changed in place: the rest leaves its page's items and the question stops saying it goes on.
 */
export function absorbRests(nos: readonly number[], reads: Map<number, PageRead>, minOptions: number) {
  for (const [i, n] of nos.entries()) {
    if (nos[i + 1] !== n + 1) continue;
    const here = reads.get(n)?.items as Item[] | undefined;
    const after = reads.get(n + 1)?.items as Item[] | undefined;
    const first = here?.[here.length - 1];
    const rest = after?.[0];
    if (!first || !rest || !after) continue;
    const have = wordsOf(first.options);
    const more = wordsOf(rest.options);
    const firstText = sameWords(first.text);
    const restText = sameWords(rest.text);
    // The first item of a page is the rest of a question when it says so, or when it is only options.
    if (rest.continues_from_previous_page !== true && !(restText === '' && more.length > 0)) continue;
    const restCovered = restText === '' || firstText.includes(restText);
    if (more.every((o) => have.includes(o)) && restCovered && (first.kind !== 'mcq' || have.length >= minOptions)) {
      // The question was already whole on its first page: two of four options is a first part, not a whole.
    } else if (have.length > 0 && have.every((o) => more.includes(o)) && more.length >= minOptions && restCovered) {
      // The whole list of options is on the second page: it is the question's.
      first.options = rest.options;
    } else continue;
    after.shift();
    first.continues_on_next_page = false;
    if (rest.question_box != null) restBoxes.set(first, [{ page: n + 1, box: rest.question_box }]);
  }
}

/** The same question over and over, as a model that has lost its place writes it. Real pages never repeat a question this way. */
export function degenerate(items: readonly unknown[]): boolean {
  if (items.length < 5) return false;
  const texts = items.map((it) => String((it as { text?: unknown } | null)?.text ?? '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ''));
  return new Set(texts).size < texts.length * 0.7;
}

/**
 * The pages of a reply: page number -> its items and key. A page the reply does not hold, or holds as nonsense, is left out, and the
 * caller reads that page on its own. A model that numbers the pages from 1 inside the request instead of by the numbers it was given
 * is followed by position, when that is clear (as many entries as pages).
 */
export function parseWholePages(text: string, wanted: readonly number[]): Map<number, PageRead> {
  const cleaned = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const root = tryParse(cleaned) ?? salvage(cleaned);
  let entries: unknown[] = [];
  if (Array.isArray(root)) entries = root;
  else if (root && typeof root === 'object') {
    const o = root as Record<string, unknown>;
    if (Array.isArray(o.pages)) entries = o.pages;
    else if (wanted.length === 1 && (Array.isArray(o.questions) || Array.isArray(o.answer_key))) entries = [{ page: wanted[0], ...o }];
  }
  const usable = entries.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && (Array.isArray((e as any).questions) || Array.isArray((e as any).answer_key)));
  const out = new Map<number, PageRead>();
  const take = (n: number, o: Record<string, unknown>) => {
    if (out.has(n)) return;
    const items = Array.isArray(o.questions) ? o.questions : [];
    if (degenerate(items)) return;
    out.set(n, { items, key: Array.isArray(o.answer_key) ? o.answer_key : [] });
  };
  for (const o of usable) {
    const n = pageNumber(o.page);
    if (n != null && wanted.includes(n)) take(n, o);
  }
  if (!out.size && usable.length === wanted.length) usable.forEach((o, i) => take(wanted[i], o));
  return out;
}
