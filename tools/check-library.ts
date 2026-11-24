// Checks every ready-made question before it can reach the app: four distinct options, the marked
// option equal to `expect` and no other option equal to it, any `verify` check true, balanced
// LaTeX, and the same right answer after options are arranged.
//
// What that proves depends on the answer. A number is worked out by code and compared with every
// option, so the marked option is proved right and the others wrong (where they read as numbers).
// A text answer (a fact or a statement) is simply the option written first: the check is that the
// options are sound, and the answer rests on the writer's review. A `verify` check proves the
// marked answer works, not that the other options are wrong. The summary counts each kind.
//
// It also lists likely repeats, to read rather than fail on: the same question again once numbers
// and names are set aside, two questions in a chapter that read nearly the same, two fact questions
// in a chapter with the same answer, and the same four text options twice.
//
// Usage: node tools/check-library.ts [--list]   (--list prints every likely repeat)
import { arrange, books } from '../api/src/ready-made/index.ts';
import type { LibraryQuestion } from '../api/src/ready-made/types.ts';

function value(opt: string): number | null {
  const s = opt
    .replace(/\$/g, '')
    .replace(/\\ /g, ' ')
    .replace(/\\text\{[^}]*\}/g, '')
    .replace(/\^\\circ|°[CF]?/g, '')
    .replace(/−/g, '-')
    .replace(/^₹\s*/, '')
    .replace(/(\d),(?=\d)/g, '$1') // 1,200 and the Indian 1,00,000
    .replace(/\s*(sq units|units|cm|mm|km|m|kg|g|mL|L|kWh|km\/h|hours|h|days|years|%|varṇa)?\s*(\^\{?[23]\}?|[²³])?$/, '')
    .trim();
  const frac = s.match(/^(-?)\\t?frac\{(\d+(?:\.\d+)?)\}\{(\d+(?:\.\d+)?)\}$/);
  if (frac) return ((frac[1] ? -1 : 1) * Number(frac[2])) / Number(frac[3]);
  // 5\sqrt{2}, -\sqrt{3}, 2\pi
  const root = s.match(/^(-?\d*(?:\.\d+)?)\\sqrt\{(\d+(?:\.\d+)?)\}$/);
  const pi = s.match(/^(-?\d*(?:\.\d+)?)\\pi$/);
  const coef = (k: string) => (k === '' ? 1 : k === '-' ? -1 : Number(k));
  if (root) return coef(root[1]) * Math.sqrt(Number(root[2]));
  if (pi) return coef(pi[1]) * Math.PI;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return null;
}

const same = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** Every $...$ closed, and braces balanced inside each piece of maths. */
function latexOk(s: string): boolean {
  const parts = s.split('$');
  if (parts.length % 2 === 0) return false;
  return parts.every((p, i) => {
    if (i % 2 === 0) return true;
    let depth = 0;
    for (const ch of p.replace(/\\[{}]/g, '')) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      if (depth < 0) return false;
    }
    return depth === 0;
  });
}

let failures = 0;
let total = 0;
const spread = [0, 0, 0, 0];
const known = { computed: 0, computedAllRead: 0, textWithCheck: 0, textOnly: 0 };
for (const book of books) {
  const seen = new Set<string>();
  let bookCount = 0;
  for (const chapter of book.chapters) {
    if (chapter.questions.length === 0) {
      failures++;
      console.log(`FAIL ${book.classLevel} ${book.subject} / ${chapter.name}: no questions`);
    }
    for (const [i, qq] of chapter.questions.entries()) {
      total++;
      bookCount++;
      const where = `Class ${book.classLevel} ${book.subject} / ${chapter.name} / Q${i + 1}`;
      const fail = (msg: string) => {
        failures++;
        console.log(`FAIL ${where}: ${msg}`);
      };
      if (!qq.text.trim() || !qq.solution.trim()) fail('text or solution is empty');
      if (seen.has(qq.text)) fail('duplicate question text');
      seen.add(qq.text);
      if (qq.options.length !== 4 || qq.options.some((o) => !o.trim())) fail('needs four filled-in options');
      if (new Set(qq.options).size !== 4) fail('options are not all different');
      for (const s of [qq.text, qq.solution, ...qq.options]) if (!latexOk(s)) fail(`unbalanced LaTeX in "${s.slice(0, 50)}"`);
      if (typeof qq.expect === 'number') {
        const expect = qq.expect;
        const vals = qq.options.map(value);
        const v = vals[qq.correct];
        if (v === null) fail(`marked option "${qq.options[qq.correct]}" is not a number`);
        else if (!same(v, expect)) fail(`marked ${v}, but the answer is ${expect}`);
        vals.forEach((x, k) => {
          if (k !== qq.correct && x !== null && same(x, expect)) fail(`option ${'ABCD'[k]} also equals the answer`);
        });
        known.computed++;
        // An option that cannot be read as a number is never compared with the answer, so it is not proved wrong.
        if (vals.every((x, k) => k === qq.correct || x !== null)) known.computedAllRead++;
      } else {
        if (qq.options[qq.correct] !== qq.expect) fail(`marked "${qq.options[qq.correct]}", but the answer is "${qq.expect}"`);
        qq.options.forEach((o, k) => {
          if (k !== qq.correct && o === qq.expect) fail(`option ${'ABCD'[k]} also equals the answer`);
        });
        if (qq.verify) known.textWithCheck++;
        else known.textOnly++;
      }
      if (qq.verify && !qq.verify()) fail('its verify check is false');
      const stored = arrange(qq);
      if (stored.options[stored.correct] !== qq.options[qq.correct]) fail('arranging the options lost the right answer');
      spread[stored.correct]++;
    }
  }
  console.log(`Class ${book.classLevel} ${book.subject}: ${book.chapters.length} chapters, ${bookCount} questions`);
}

// Likely repeats.

/** Names that word problems use; they are hidden like numbers, so a new name does not make a new question. */
const NAMES = new Set(
  ('asha ravi meena arjun priya kabir zoya rohan anil sunita farhan divya imran lakshmi neha vikram tara sameer gita karan riya ' +
    'aman ishaan nandini tenzin mary joseph harpreet suresh kavya krithika anjali deepak fatima gopal hari jaya manoj nisha pooja ' +
    'rahul salma usha varun yusuf')
    .split(' '),
);

/** Text as tokens, with every number and name hidden. */
function tokens(text: string): string[] {
  const t = text
    .replace(/(?<=[a-z0-9,;:]\s)[A-Z][a-zāīūṛṇṣ]+/g, ' N ') // a name or a place in mid-sentence
    .replace(/[A-Za-zāīūṛṇṣ]+/g, (w) => (NAMES.has(w.toLowerCase()) ? ' N ' : w))
    .toLowerCase()
    .replace(/\\text\{([^}]*)\}/g, ' $1 ')
    .replace(/\\(left|right|displaystyle|quad|qquad)\b|\\[,;!]/g, ' ')
    .replace(/\d+(?:[.,]\d+)*/g, ' # ');
  return t.match(/\\[a-z]+|[a-zà-ÿāīūṛṇṣ]+|#|[+\-−=×÷<>≤≥^/()°%₹√π]/g) ?? [];
}

/**
 * A question's words and its maths, apart. Two questions are alike only when both their words and their maths are, so one
 * equation asked about in two different ways is not a repeat, and the same words around different maths are not either.
 */
function parts(text: string): { words: string[]; maths: string[]; key: string } {
  const words = tokens(text.replace(/\$[^$]*\$/g, ' M '));
  const maths = tokens((text.match(/\$[^$]*\$/g) ?? []).join(' ').replace(/\$/g, ' '));
  return { words, maths, key: `${words.join(' ')} | ${maths.join(' ')}` };
}

/** How many tokens must change to turn one into the other. */
function distance(a: string[], b: string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const likeness = (a: string[], b: string[]) => 1 - distance(a, b) / Math.max(a.length, b.length, 1);
const alike = (a: ReturnType<typeof parts>, b: ReturnType<typeof parts>) => Math.min(likeness(a.words, b.words), likeness(a.maths, b.maths));

/** Two questions in one chapter at least this alike are listed. Set on 24 Nov 2026 by reading what the 830 gave. */
const REPEAT_AT = 0.75;

type Ref = { where: string; qq: LibraryQuestion };
const repeats = new Map<string, string[]>();
const note = (kind: string, refs: Ref[], detail: string) =>
  repeats.set(kind, [...(repeats.get(kind) ?? []), `${refs.map((r) => r.where).join(' and ')}: ${detail}`]);
const isFact = (qq: LibraryQuestion) => typeof qq.expect === 'string' && value(qq.expect) === null;
const short = (s: string) => (s.length > 70 ? `${s.slice(0, 67)}...` : s);

const bySkeleton = new Map<string, Ref[]>();
const byOptions = new Map<string, Ref[]>();
for (const book of books) {
  for (const chapter of book.chapters) {
    const refs = chapter.questions.map((qq, i) => ({ where: `Class ${book.classLevel} ${book.subject} / ${chapter.name} / Q${i + 1}`, qq }));
    const toks = chapter.questions.map((qq) => parts(qq.text));
    const answers = new Map<string, Ref[]>();
    refs.forEach((r, i) => {
      bySkeleton.set(toks[i].key, [...(bySkeleton.get(toks[i].key) ?? []), r]);
      if (isFact(r.qq)) {
        // The same four options in any order. Numeric options are left out: four small numbers often come up again by chance.
        const opts = r.qq.options.map((o) => o.trim().toLowerCase()).sort().join(' | ');
        byOptions.set(opts, [...(byOptions.get(opts) ?? []), r]);
        const a = String(r.qq.expect).trim().toLowerCase();
        answers.set(a, [...(answers.get(a) ?? []), r]);
      }
    });
    for (const list of answers.values()) if (list.length > 1) note('two fact questions in a chapter with the same answer', list, `"${short(String(list[0].qq.expect))}"`);
    for (let i = 0; i < toks.length; i++) {
      for (let j = i + 1; j < toks.length; j++) {
        if (toks[i].key === toks[j].key) continue; // listed below as the same question
        const l = alike(toks[i], toks[j]);
        if (l >= REPEAT_AT) note('two questions in a chapter that read nearly the same', [refs[i], refs[j]], `${Math.round(l * 100)}% alike`);
      }
    }
  }
}
for (const list of bySkeleton.values()) if (list.length > 1) note('the same question once numbers and names are hidden', list, `"${short(list[0].qq.text)}"`);
for (const list of byOptions.values()) if (list.length > 1) note('the same four options', list, `"${short(list[0].qq.options.join(' / '))}"`);

const listAll = process.argv.includes('--list');
if (repeats.size) {
  console.log(`\nLikely repeats, to read (some overlap)${listAll ? '' : '; --list prints each'}:`);
  for (const [kind, list] of repeats) {
    console.log(`  ${kind}: ${list.length}`);
    if (listAll) for (const m of list) console.log(`    ${m}`);
  }
}
console.log(`\n${total} questions checked, ${failures} failure${failures === 1 ? '' : 's'}`);
console.log(
  `how each answer is known: worked out by code ${known.computed} (every wrong option read as a number in ${known.computedAllRead}), ` +
    `text with a verify check ${known.textWithCheck}, text resting on the writer's review ${known.textOnly}`,
);
console.log(`right answers stored as A/B/C/D: ${spread.join(' / ')}`);
process.exit(failures ? 1 : 0);
