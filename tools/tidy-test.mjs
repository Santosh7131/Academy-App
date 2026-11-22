// Checks for the clean-ups of a page read's question words (api/src/lib/tidy.ts), on the texts the reader really wrote on
// 2026-11-15. Run: node tools/tidy-test.mjs
import { looksFake, tablesIn, tidyPage, withoutKey } from '../api/src/lib/tidy.ts';

let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    fail++;
    console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want));
  } else console.log('ok  ', name);
};

const AR = [
  'Both A and R are true and R is the correct explanation of A.',
  'Both A and R are true, but R is not the correct explanation of A.',
  'A is true but R is false.',
  'A is false and R is true.',
];
const key = (n) => `For Questions ${n}, choose the appropriate answer using the following key:\n(a) ${AR[0]}\n(b) ${AR[1]}\n(c) ${AR[2]}\n(d) ${AR[3]}`;

// an Assertion and Reason key copied above the question
eq('key above the question comes out', withoutKey(`${key('22–24')}\n\nAssertion (A): Rusting of iron is a chemical change.\nReason (R): A new substance forms.`, AR).text,
  'Assertion (A): Rusting of iron is a chemical change.\nReason (R): A new substance forms.');
eq('key under the question, with a heading line', withoutKey(`Assertion (A): Ice floats on water.\nReason (R): Ice is less dense than water.\nAssertion and Reason\n${key('25–26')}`, AR).text,
  'Assertion (A): Ice floats on water.\nReason (R): Ice is less dense than water.');
eq('heading on the instruction line', withoutKey(`Assertion and Reason For Questions 22–24, choose the appropriate answer using the following key:\n(a) ${AR[0]}\n(b) ${AR[1]}\n(c) ${AR[2]}\n(d) ${AR[3]}\n\nAssertion (A): X.\nReason (R): Y.`, AR).text,
  'Assertion (A): X.\nReason (R): Y.');
eq('five choices, (A) labels', withoutKey(`Assertion (A): X.\nReason (R): Y.\n(A) ${AR[0]}\n(B) ${AR[1]}\n(C) ${AR[2]}\n(D) ${AR[3]}\n(E) Both A and R are false.`, [...AR, 'Both A and R are false.']).text,
  'Assertion (A): X.\nReason (R): Y.');
eq('lines that are not the options stay', withoutKey('Which are true?\n(i) Copper conducts\n(ii) Wood conducts\n(iii) Iron conducts', ['(i) and (iii)', '(ii) only', '(i) only', 'All of these']).text,
  'Which are true?\n(i) Copper conducts\n(ii) Wood conducts\n(iii) Iron conducts');
eq('Hindi labels', withoutKey('प्रश्न का पाठ\n(क) पहला\n(ख) दूसरा\n(ग) तीसरा\n(घ) चौथा', ['पहला', 'दूसरा', 'तीसरा', 'चौथा']).text, 'प्रश्न का पाठ');
eq('options repeated in the words come out too', withoutKey('Which is a vector?\n(a) mass\n(b) speed\n(c) force\n(d) time', ['mass', 'speed', 'force', 'time']).text, 'Which is a vector?');
// as the reader wrote his paper's Q15 (2026-11-15): the key in the words and its labels inside the options
{
  const five = [...AR, 'Both A and R are false.'];
  const got = withoutKey(`${key('15–17')}\n(e) ${five[4]}\n\nAssertion (A): A zygote with two X chromosomes develops into a boy.\nReason (R): ...`, five.map((o, k) => `(${'abcde'[k]}) ${o}`));
  eq('key with labelled options: words', got.text, 'Assertion (A): A zygote with two X chromosomes develops into a boy.\nReason (R): ...');
  eq('key with labelled options: labels come off the options', got.options, five);
}
eq('options keep their words when no key is found', withoutKey('Which are correct?', ['(i) and (ii)', '(ii) only', '(iii) only', '(iv) only']).options, ['(i) and (ii)', '(ii) only', '(iii) only', '(iv) only']);
eq('a text that would be emptied is kept', withoutKey(`(a) ${AR[0]}\n(b) ${AR[1]}\n(c) ${AR[2]}\n(d) ${AR[3]}`, AR).text, `(a) ${AR[0]}\n(b) ${AR[1]}\n(c) ${AR[2]}\n(d) ${AR[3]}`);

// tables that are no tables
const rowsOf = (t) => tablesIn(t.split('\n'))[0].rows;
eq('a drawn circuit is no table', looksFake(rowsOf('| | | |\n|---|---|---|\n| | $6\\ \\Omega$ | |\n| A | ■■■■ | B |\n| | $3\\ \\Omega$ | |')), true);
eq('one column is no table', looksFake(rowsOf('| $6\\ \\Omega$ |\n|---|---\n| $3\\ \\Omega$ |')), true);
eq('rows of one cell are no table', looksFake(rowsOf('| | |\n|---|---|\n| $6\\ \\Omega$ |\n| $3\\ \\Omega$ |')), true);
eq('a real table is a table', looksFake(rowsOf('| Outcome | Frequency |\n|---|---|\n| 3 heads | 150 |\n| 2 heads | 200 |')), false);
eq('a grid printed without headings is a table', looksFake(rowsOf('| | | |\n|---|---|---|\n| 0 | 1 | 2 |\n| 3 | 1 | 3 |')), false);
eq('a one-row table is a table', looksFake(rowsOf('| Class | 65–85 | 85–105 |\n|---|---|---|\n| Frequency | 4 | 5 |')), false);

const page = (items) => {
  tidyPage(items);
  return items.map((it) => it.text);
};
eq('a circuit drawn as a table goes from a figure question', page([{ text: 'In the circuit shown, the equivalent resistance between A and B is\n\n| | | |\n|---|---|---|\n| | 6 | |\n| A | ■■■■ | B |\n| | 3 | |', needs_diagram: true, options: ['2', '3', '6', '9'] }]),
  ['In the circuit shown, the equivalent resistance between A and B is']);
eq('a garbled table keeps its words in a question without a figure',
  page([{ text: 'A coin is tossed 100 times with the following frequencies:\n| Head | Frequency |\n|---|---|\n| Head : 75, Tail : 25 | |\nFind the probability of getting a head.', options: ['1/4', '1/2', '3/4', '1'] }]),
  ['A coin is tossed 100 times with the following frequencies:\nHead : 75, Tail : 25\nFind the probability of getting a head.']);
const boiling = '| Liquid | P | Q | R | S |\n|---|---|---|---|---|\n| Boiling point (°C) | 78 | 100 | 35 | 118 |';
eq('a table copied into another question stays with the one that speaks of it', page([
  { text: `In the circuit shown, the equivalent resistance between A and B is\n\n${boiling}`, needs_diagram: true, options: [] },
  { text: `The table gives the boiling points of four liquids. Which liquid has the highest?\n\n${boiling}`, options: [] },
]), ['In the circuit shown, the equivalent resistance between A and B is', `The table gives the boiling points of four liquids. Which liquid has the highest?\n\n${boiling}`]);
const marks = '| Marks | Students |\n|---|---|\n| 0–10 | 4 |\n| 10–20 | 6 |';
eq('a case study table shared by questions that do not say "table" stays in each', page([
  { text: `The marks of a class are given below.\n\n${marks}\n\nHow many students scored under 10?`, options: [] },
  { text: `The marks of a class are given below.\n\n${marks}\n\nHow many students are there?`, options: [] },
]), [`The marks of a class are given below.\n\n${marks}\n\nHow many students scored under 10?`, `The marks of a class are given below.\n\n${marks}\n\nHow many students are there?`]);
eq('a page without tables or keys is left as it is', page([{ text: 'What is $|x|$ if $x = -3$?', options: ['3', '-3', '0', '9'] }]), ['What is $|x|$ if $x = -3$?']);

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exit(fail ? 1 : 0);
