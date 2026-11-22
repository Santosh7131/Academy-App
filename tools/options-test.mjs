// Checks for how many options a question can have: the limits, which pages an app is sent, and what a join makes of a question of five.
// Run: node tools/options-test.mjs
import { isWholeList, letterOf, MAX_OPTIONS, maxOptionsFor, MIN_OPTIONS, MORE_OPTIONS_BUILD, usesMoreOptions } from '../api/src/lib/options.ts';
import { joinParts, looksCut } from '../api/src/lib/pieces.ts';
import { mustKeepOrder } from '../api/src/lib/questions.ts';

let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    fail++;
    console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want));
  } else console.log('ok  ', name);
};

eq('the limits are four to six', [MIN_OPTIONS, MAX_OPTIONS], [4, 6]);
eq('an app that holds four is read for four', maxOptionsFor(false), 4);
eq('an app that holds more is read for six', maxOptionsFor(true), 6);
eq('four is whole', isWholeList(['a', 'b', 'c', 'd']), true);
eq('five is whole', isWholeList(['a', 'b', 'c', 'd', 'e']), true);
eq('six is whole', isWholeList(['a', 'b', 'c', 'd', 'e', 'f']), true);
eq('three is not', isWholeList(['a', 'b', 'c']), false);
eq('seven is not', isWholeList(['a', 'b', 'c', 'd', 'e', 'f', 'g']), false);
eq('five is not whole for an app that holds four', isWholeList(['a', 'b', 'c', 'd', 'e'], 4), false);
eq('letters', [0, 1, 4, 5].map(letterOf), ['A', 'B', 'E', 'F']);
eq('a letter past F is a number, not a crash', letterOf(6), '7');
eq('the build that first holds more is 13', MORE_OPTIONS_BUILD, 13);

// what an app from before is never sent
const four = ['a', 'b', 'c', 'd'];
const five = ['a', 'b', 'c', 'd', 'e'];
eq('a question of four may go to any app', usesMoreOptions({ question: { options: four, correct_option: 3 } }), false);
eq('a question of five may not', usesMoreOptions({ question: { options: five } }), true);
eq('a list of drafts with one of five in it may not', usesMoreOptions({ drafts: [{ options: four }, { options: four }, { options: five }] }), true);
eq('a mark on the fifth may not (a results page has no options list of its own)', usesMoreOptions({ questions: [{ correct_option: 4 }] }), true);
eq('a mark on the fourth may', usesMoreOptions({ questions: [{ correct_option: 3 }] }), false);
eq('a pick on the fifth may not', usesMoreOptions({ answers: [{ chosen_option: 4 }] }), true);
eq('the picks for five options may not', usesMoreOptions({ q: { option_counts: [1, 2, 3, 4, 5] } }), true);
eq('the picks for four may', usesMoreOptions({ q: { option_counts: [1, 2, 3, 4] } }), false);
eq('a count of students that happens to be five is no option', usesMoreOptions({ summary: { correct: 5, submitted: 7, chosen: 6, n: 9 } }), false);
eq('nothing at all', usesMoreOptions(null), false);
eq('a plain list of words', usesMoreOptions(['a', 'b', 'c', 'd', 'e']), false);
eq('deep inside', usesMoreOptions({ a: { b: { c: [{ options: five }] } } }), true);

// a question of five cut by the page edge
const part = (o) => ({ number_label: '4', kind: 'other', text: '', options: [], needs_diagram: false, unclear: false, question_boxes: null, figure_box: null, cont_next: false, cont_prev: false, ...o });
const cutAtE = [part({ text: 'Pick the key.', options: four, cont_next: true }), part({ number_label: null, text: '', options: ['e'], cont_prev: true })];
eq('four and the fifth join for an app that holds more', (() => { const j = joinParts(...cutAtE, 6); return [j?.kind, j?.options.length, j?.unclear]; })(), ['mcq', 5, false]);
eq('four and the fifth do not join for an app that holds four', joinParts(...cutAtE, 4), null);
eq('four and four do not join even for an app that holds more', joinParts(part({ text: 'q', options: four, cont_next: true }), part({ options: four, cont_prev: true }), 6), null);
eq('three and three join to six', (() => { const j = joinParts(part({ text: 'q', options: ['a', 'b', 'c'], cont_next: true }), part({ number_label: null, options: ['d', 'e', 'f'], cont_prev: true }), 6); return [j?.kind, j?.options.length]; })(), ['mcq', 6]);
eq('four options are not "cut"', looksCut({ options: four }), false);
eq('five options are not "cut"', looksCut({ options: five }), false);

// options that point at each other keep their order, whichever letters they name
eq('both (a) and (e) keeps its order', mustKeepOrder(['x', 'Both (a) and (e)']), true);
eq('(e) or (f) keeps its order', mustKeepOrder(['(e) or (f)']), true);
eq('plain options may be shuffled', mustKeepOrder(['one', 'two', 'three', 'four', 'five']), false);

console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);
