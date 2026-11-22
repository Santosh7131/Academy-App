// How many options a question can have, and what an app that came before the limit was lifted must never be sent.
// Pure functions with no database, so tools/options-test.mjs can check them.

import { APP_NAME } from './brand.ts';

/**
 * The fewest options a multiple-choice question has. A page read that finds fewer has cut the question off or misread it, so that
 * question is held for the tutor instead of being served with an option missing.
 */
export const MIN_OPTIONS = 4;

/** The most options a question has: papers print four, and some print five (an Assertion and Reason key of (a) to (e)) or six. */
export const MAX_OPTIONS = 6;

/**
 * An option's printed label at the start of a line: (a) to (f), (i) to (vi), (1) to (6), "a." or "1)", and in Hindi and Tamil papers
 * (क) to (ङ), (अ) (ब) (स) (द) or (अ) (आ) (इ) (ई), and (அ) to (உ).
 */
export const OPTION_LABEL = /^\s*(?:\(\s*(?:[a-f]|[ivx]{1,3}|[1-6]|[क-ङ]|[अआइईउबसद]|[அஆஇஈஉ])\s*\)|(?:[a-f]|[ivx]{1,3}|[1-6])\s*[.)])\s*/i;

/** The letters the apps give the options, in order. */
export const OPTION_LETTERS = 'ABCDEF';

/**
 * The first build of the app that shows and edits more than four options. An older app has four slots and four letters: a fifth option
 * would be dropped when a tutor saved the question, or would stop a student's screen from drawing.
 */
export const MORE_OPTIONS_BUILD = 13;

/**
 * What an app from before MORE_OPTIONS_BUILD is told when it asks for a question with more than four options. The code that goes with it
 * is needs_newer_app, not update_required: that one sends an app to its full-screen "please update" page, and one test is not worth the
 * whole app.
 */
export const NEEDS_NEWER_APP =
  'This has a question with more than four options, which this version of ' + APP_NAME + ' cannot show. Please install the newest version, then open it again. Your tutor can send it to you.';

/** The most options a page read may give a question for an app: the old four, or the new limit. */
export const maxOptionsFor = (knowsMore: boolean) => (knowsMore ? MAX_OPTIONS : MIN_OPTIONS);

/** Whether a list of options is a whole question's: at least the fewest, and no more than the app can hold. */
export const isWholeList = (options: readonly unknown[], max = MAX_OPTIONS) => options.length >= MIN_OPTIONS && options.length <= max;

/** The letter of option `i` (0 is A). Past the last letter it is the number, so a bug shows as a strange label and not as a crash. */
export const letterOf = (i: number) => OPTION_LETTERS[i] ?? String(i + 1);

const MARKS = new Set(['correct_option', 'proposed_option', 'chosen_option']);

/**
 * Whether something an app sends back to a person holds what an app before MORE_OPTIONS_BUILD cannot show: a question with more than
 * four options, the count of picks for each of them, or a mark on an option beyond the fourth. Looks through the whole reply, so a
 * route that is added later is covered without anyone remembering to.
 */
export function usesMoreOptions(v: unknown, depth = 0): boolean {
  if (v === null || typeof v !== 'object' || depth > 12) return false;
  if (Array.isArray(v)) return v.some((x) => usesMoreOptions(x, depth + 1));
  for (const [k, x] of Object.entries(v)) {
    if ((k === 'options' || k === 'option_counts') && Array.isArray(x) && x.length > MIN_OPTIONS) return true;
    if (MARKS.has(k) && typeof x === 'number' && x >= MIN_OPTIONS) return true;
    if (usesMoreOptions(x, depth + 1)) return true;
  }
  return false;
}
