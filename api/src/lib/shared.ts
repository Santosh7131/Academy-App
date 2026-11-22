// A block a page prints once above a group of questions, which every question in the group uses: the options they share.
// Assertion and Reason questions are the usual case: the four (or five) choices are printed once, under "For Questions 15-17, choose the
// appropriate answer using the following key", and no question repeats them. Pure functions with no database, so
// tools/shared-test.mjs can check them.

import { isWholeList, MIN_OPTIONS } from './options.ts';
import { asciiDigits } from './text.ts';

/** A shared block as the page reader reported it, checked. */
export type Shared = {
  /** The first question number it covers. */
  from: number;
  /** The last question number it covers, or null when it runs on to the next block or the end of the page. */
  to: number | null;
  /** Every option the block prints, in printed order, without labels. */
  options: string[];
};

const MAX_BLOCKS = 12;
/** The most options a key is cleaned to (a longer list is a model run on, and is no key anyway: applyShared uses a block of four to six). */
const MAX_KEY_OPTIONS = 8;
const MAX_OPTION_CHARS = 500;

/** A question number as a whole number: "15", "Q15.", "(15)", "प्रश्न १५" and "15(a)" are all 15; null when it has no digit. */
export function numberOf(label: unknown): number | null {
  if (typeof label !== 'string' && typeof label !== 'number') return null;
  const m = /\d{1,3}/.exec(asciiDigits(String(label)));
  return m ? Number(m[0]) : null;
}

/** The blocks a model reported, each one checked. A block with no first question or no list of options is no block. */
export function cleanShared(raw: unknown): Shared[] {
  if (!Array.isArray(raw)) return [];
  const out: Shared[] = [];
  for (const b of raw.slice(0, MAX_BLOCKS)) {
    if (!b || typeof b !== 'object') continue;
    const { from, to, options } = b as Record<string, unknown>;
    const first = numberOf(from);
    if (first == null || !Array.isArray(options)) continue;
    const list = options
      .filter((o): o is string => typeof o === 'string')
      .map((o) => asciiDigits(o.trim().slice(0, MAX_OPTION_CHARS)))
      .filter(Boolean)
      .slice(0, MAX_KEY_OPTIONS);
    const last = numberOf(to);
    out.push({ from: first, to: last != null && last >= first ? last : null, options: list });
  }
  return out;
}

const ASSERTION_WORD = /assertion|अभिकथन|கூற்று/i;
const ASSERTION_MARK = /\(\s*A\s*\)/;
const REASON_WORD = /\breason\b|कारण|காரணம்/i;
const REASON_MARK = /\(\s*R\s*\)/;

/** Whether a question's words are those of an Assertion and Reason question: an assertion and a reason, usually marked (A) and (R), in English, Hindi or Tamil. */
export function looksLikeAssertionReason(text: unknown): boolean {
  return typeof text === 'string' && (ASSERTION_WORD.test(text) || ASSERTION_MARK.test(text)) && (REASON_WORD.test(text) || REASON_MARK.test(text));
}

/**
 * The numbers, as printed, of the questions on a page that look like Assertion and Reason questions yet have no options of their own:
 * the ones whose key (printed once above them) the page read did not hand on. Empty for an ordinary page.
 */
export function wantingKey(items: { number?: unknown; text?: unknown; options?: unknown }[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    const own = Array.isArray(it.options) ? it.options.filter((o) => typeof o === 'string' && o.trim()).length : 0;
    if (own > 0 || !looksLikeAssertionReason(it.text)) continue;
    const label = typeof it.number === 'string' || typeof it.number === 'number' ? String(it.number).trim() : '';
    if (label && numberOf(label) != null) out.push(label);
  }
  return out.slice(0, 30);
}

/** The block that covers question `n`: the latest one that starts at or before it and has not ended. */
function blockFor(shared: Shared[], n: number): Shared | null {
  let best: Shared | null = null;
  for (const s of shared) {
    if (n < s.from || (s.to != null && n > s.to)) continue;
    if (!best || s.from >= best.from) best = s;
  }
  return best;
}

/**
 * Gives each question that a block covers the block's options, so the question can be answered like any other. Only a block with as
 * many options as a question can have is used: four, or up to `max` for an app that holds more (a key of five is a five-option
 * question; a key of two or of seven would lose or invent options, so those questions are left as they were, for the tutor). A
 * question that prints options of its own keeps them, however many. Returns new items; the ones it was given are not changed.
 */
export function applyShared<T extends { number?: unknown; options?: unknown; kind?: unknown }>(items: T[], shared: Shared[], max = MIN_OPTIONS): { items: T[]; attached: number } {
  if (!shared.length) return { items, attached: 0 };
  let attached = 0;
  const out = items.map((it) => {
    const n = numberOf(it.number);
    if (n == null) return it;
    const own = Array.isArray(it.options) ? it.options.filter((o) => typeof o === 'string' && o.trim()).length : 0;
    if (own > 0) return it;
    const block = blockFor(shared, n);
    if (!block || !isWholeList(block.options, max)) return it;
    attached++;
    return { ...it, options: [...block.options], kind: 'mcq' };
  });
  return { items: out, attached };
}
