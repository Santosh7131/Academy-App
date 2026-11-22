// Clean-ups for the words a page read writes into a question, for the reader's known slips, each seen on real or test pages
// (2026-11-15): a printed answer key copied into the question's words, a table copied into a question it is not printed with,
// and a figure written out as a "table". Each removes only what is already said elsewhere (the options, another question) or
// is not a table; nothing a page prints is lost.

import { OPTION_LABEL as LABEL } from './options.ts';

const BOX = '■';
const RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const TABLE_WORD = /\btables?\b|तालिका|அட்டவணை/i;
const KEY_HEADING = /^\s*assertion\s*(and|&|–|-|—)?\s*reason\b/i;

/** A line's cells between | marks; a | inside $...$ stays in its cell. */
function cellsOf(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let math = false;
  for (const ch of line) {
    if (ch === '$') math = !math;
    if (ch === '|' && !math) {
      cells.push(cell);
      cell = '';
    } else cell += ch;
  }
  cells.push(cell);
  const t = line.trim();
  if (t.startsWith('|')) cells.shift();
  if (t.endsWith('|') && cells.length) cells.pop();
  return cells.map((c) => c.trim());
}

/** The tables written in a text's lines: a row of cells, a line of dashes, then a row a line. `to` is the line after the last row. */
export function tablesIn(lines: string[]): { from: number; to: number; rows: string[][] }[] {
  const out: { from: number; to: number; rows: string[][] }[] = [];
  for (let i = 0; i < lines.length; ) {
    if (lines[i].includes('|') && i + 1 < lines.length && RULE.test(lines[i + 1])) {
      const rows = [cellsOf(lines[i])];
      let j = i + 2;
      for (; j < lines.length && lines[j].includes('|') && lines[j].trim(); j++) rows.push(cellsOf(lines[j]));
      out.push({ from: i, to: j, rows });
      i = j;
    } else i++;
  }
  return out;
}

const filled = (c: string) => c.split(BOX).join('').trim() !== '';

/**
 * A "table" that is no table: one column, or rows that are mostly empty (the boxes of a drawn circuit count as empty), or rows of one
 * cell each. A real table, even one printed without headings, has its rows filled.
 */
export function looksFake(rows: string[][]): boolean {
  const width = Math.max(...rows.map((r) => r.length));
  if (width < 2) return true;
  const data = rows.slice(1);
  if (!data.length) return true;
  const full = data.reduce((n, r) => n + r.filter(filled).length, 0);
  return full / (data.length * width) < 0.5 || data.every((r) => r.filter(filled).length <= 1);
}

/** A text cut down to its letters and digits, for comparing what a read wrote twice: case, spacing, marks and LaTeX commands aside. */
export const squash = (s: string) => s.toLowerCase().replace(/\$/g, '').replace(/\\[a-z]+/g, '').replace(/[^\p{L}\p{M}\p{N}]/gu, '');

/** Lines with blank lines at either end and runs of blank lines cut down to one. */
function tidyLines(lines: string[]): string {
  const out: string[] = [];
  for (const l of lines) {
    if (!l.trim() && (!out.length || !out[out.length - 1].trim())) continue;
    out.push(l);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join('\n');
}

/**
 * The words without a printed key of choices that repeats the question's own options, line for line and in order (with the line
 * before it that ends in ":", such as "For Questions 15–17, choose the appropriate answer using the following key:", and an
 * "Assertion and Reason" heading just above that), and the options without the key's labels when they were copied with them
 * ("(a) Both A and R are true ..."). The options already hold the key; anything else is left as it is.
 */
export function withoutKey(text: string, options: string[]): { text: string; options: string[] } {
  const plain = options.map((o) => o.replace(LABEL, ''));
  const opts = plain.map(squash);
  if (opts.length < 3 || opts.some((o) => !o)) return { text, options };
  const lines = text.split('\n');
  for (let s = 0; s + opts.length <= lines.length; s++) {
    const run = opts.every((o, k) => LABEL.test(lines[s + k]) && squash(lines[s + k].replace(LABEL, '')) === o);
    if (!run) continue;
    let from = s;
    if (from > 0 && lines[from - 1].trim().endsWith(':')) from--;
    if (from > 0 && KEY_HEADING.test(lines[from - 1]) && lines[from - 1].trim().length <= 40) from--;
    const left = tidyLines([...lines.slice(0, from), ...lines.slice(s + opts.length)]);
    // Options that carry the key's labels lose them: the app draws its own A, B, C, D.
    const labelled = options.every((o, k) => LABEL.test(o) && o.match(LABEL)![0].replace(/[^\p{L}\p{N}]/gu, '').toLowerCase() === lines[s + k].match(LABEL)![0].replace(/[^\p{L}\p{N}]/gu, '').toLowerCase());
    return { text: left.trim() ? left : text, options: labelled ? plain.map((o) => o.trim()) : options };
  }
  return { text, options };
}

type Item = { text?: unknown; options?: unknown; needs_diagram?: unknown };

/**
 * Tidies the words of a page's questions in place: a printed key that repeats a question's options comes out of its words; a "table"
 * that is no table (see looksFake) goes, its filled cells kept as lines unless the question needs its figure (the figure holds them);
 * and a table written into more than one question of the page stays only with the questions that speak of a table (all keep it when
 * none does).
 */
export function tidyPage(items: Item[]) {
  const texts = items.map((it) => (typeof it.text === 'string' ? it.text : null));
  items.forEach((it, i) => {
    if (texts[i] == null || !Array.isArray(it.options) || !it.options.every((o) => typeof o === 'string')) return;
    const out = withoutKey(texts[i]!, it.options as string[]);
    texts[i] = out.text;
    it.options = out.options;
  });
  // Fake tables out.
  items.forEach((it, i) => {
    const text = texts[i];
    if (text == null || !text.includes('|')) return;
    const lines = text.split('\n');
    const blocks = tablesIn(lines).filter((b) => looksFake(b.rows));
    for (const b of blocks.reverse()) {
      const data = b.rows.slice(1).map((r) => r.filter(filled).join(' ')).filter(Boolean);
      const keep = it.needs_diagram === true ? [] : data.length ? data : b.rows[0].filter(filled).length ? [b.rows[0].filter(filled).join(' ')] : [];
      lines.splice(b.from, b.to - b.from, ...keep);
    }
    texts[i] = tidyLines(lines);
  });
  // A table in more than one question stays with its own.
  const seen = new Map<string, number[]>();
  texts.forEach((text, i) => {
    if (text == null) return;
    for (const b of tablesIn(text.split('\n'))) {
      const k = JSON.stringify(b.rows.map((r) => r.map(squash)));
      seen.set(k, [...(seen.get(k) ?? []), i]);
    }
  });
  for (const [k, at] of seen) {
    const owners = [...new Set(at)];
    if (owners.length < 2) continue;
    const speak = owners.filter((i) => {
      const lines = texts[i]!.split('\n');
      const outside = lines.filter((_, n) => !tablesIn(lines).some((b) => n >= b.from && n < b.to)).join(' ');
      return TABLE_WORD.test(outside);
    });
    // When none of them speaks of a table (a case study's shared table, under a passage that does not use the word), all keep it.
    if (!speak.length) continue;
    const keep = new Set(speak);
    for (const i of owners) {
      if (keep.has(i)) continue;
      const lines = texts[i]!.split('\n');
      for (const b of tablesIn(lines).reverse()) {
        if (JSON.stringify(b.rows.map((r) => r.map(squash))) === k) lines.splice(b.from, b.to - b.from);
      }
      texts[i] = tidyLines(lines);
    }
  }
  items.forEach((it, i) => {
    if (texts[i] != null) it.text = texts[i];
  });
}
