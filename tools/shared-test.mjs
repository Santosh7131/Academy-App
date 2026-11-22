// Checks for the options a page prints once above a group of questions (Assertion and Reason keys) and how they reach each question.
// Run: node tools/shared-test.mjs
import { applyShared, cleanShared, looksLikeAssertionReason, numberOf, wantingKey } from '../api/src/lib/shared.ts';
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    fail++;
    console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want));
  } else console.log('ok  ', name);
};

// question numbers as pages print them
eq('plain', numberOf('15'), 15);
eq('Q and a dot', numberOf('Q15.'), 15);
eq('in brackets', numberOf('(15)'), 15);
eq('Q. and a space', numberOf('Q. 15'), 15);
eq('Hindi word and digits', numberOf('प्रश्न १५'), 15);
eq('Tamil digits', numberOf('வினா ௧௫'), 15);
eq('a part of a question', numberOf('15(a)'), 15);
eq('a number', numberOf(7), 7);
eq('no digit', numberOf('A'), null);
eq('empty', numberOf(''), null);
eq('null', numberOf(null), null);
eq('an object', numberOf({}), null);

// the blocks a model reports
const four = ['A and R are true, R explains A', 'A and R are true, R does not explain A', 'A is true, R is false', 'A is false, R is true'];
eq('a good block', cleanShared([{ from: '15', to: '17', options: four }]), [{ from: 15, to: 17, options: four }]);
eq('numbers as numbers', cleanShared([{ from: 15, to: 17, options: four }]), [{ from: 15, to: 17, options: four }]);
eq('no end', cleanShared([{ from: '15', to: '', options: four }]), [{ from: 15, to: null, options: four }]);
eq('an end before the start is no end', cleanShared([{ from: '15', to: '12', options: four }]), [{ from: 15, to: null, options: four }]);
eq('no start is no block', cleanShared([{ from: '', to: '17', options: four }]), []);
eq('options that are not a list', cleanShared([{ from: '15', options: 'a, b, c, d' }]), []);
eq('not a list at all', cleanShared('x'), []);
eq('null', cleanShared(null), []);
eq('an item that is not an object', cleanShared([null, 4, 'x', { from: '2', options: four }]), [{ from: 2, to: null, options: four }]);
eq('options are trimmed, blanks and non-text dropped', cleanShared([{ from: '1', options: [' a ', '', 5, null, 'b'] }]), [{ from: 1, to: null, options: ['a', 'b'] }]);
eq('Hindi digits in options become 0 to 9', cleanShared([{ from: '1', options: ['१२', 'x'] }]), [{ from: 1, to: null, options: ['12', 'x'] }]);
eq('a block of any length is kept as it is', cleanShared([{ from: '1', options: [...four, 'both are false'] }])[0].options.length, 5);
eq('only twelve blocks', cleanShared(Array.from({ length: 20 }, (_, i) => ({ from: String(i + 1), options: four }))).length, 12);

// giving the options to the questions
const q = (number, extra = {}) => ({ number, kind: 'other', text: `question ${number}`, options: [], ...extra });
const block = { from: 15, to: 17, options: four };

let r = applyShared([q('14'), q('15'), q('16'), q('17'), q('18')], [block]);
eq('the questions in the range get the options', r.items.map((x) => x.options.length), [0, 4, 4, 4, 0]);
eq('and become multiple choice', r.items.map((x) => x.kind), ['other', 'mcq', 'mcq', 'mcq', 'other']);
eq('how many it gave', r.attached, 3);
eq('the options are the block\'s, in order', r.items[1].options, four);
eq('text is untouched', r.items[1].text, 'question 15');

const own = ['one', 'two', 'three', 'four'];
r = applyShared([q('15', { kind: 'mcq', options: own })], [block]);
eq('a question with its own four keeps them', r.items[0].options, own);
r = applyShared([q('15', { options: ['one', 'two'] })], [block]);
eq('a question with some of its own keeps them', r.items[0].options, ['one', 'two']);
eq('and gets nothing', r.attached, 0);

r = applyShared([q('15')], [{ from: 15, to: 17, options: [...four, 'both are false'] }]);
eq('a key of five is not used for an app that holds four: the question would lose one', r.items[0].options, []);
eq('and stays not multiple choice', r.items[0].kind, 'other');
r = applyShared([q('15'), q('16'), q('17')], [{ from: 15, to: 17, options: [...four, 'both are false'] }], 6);
eq('a key of five is used for an app that holds up to six', r.items.map((x) => x.options.length), [5, 5, 5]);
eq('and each question is multiple choice', r.items.map((x) => x.kind), ['mcq', 'mcq', 'mcq']);
r = applyShared([q('15')], [{ from: 15, to: 17, options: [...four, 'e', 'f', 'g'] }], 6);
eq('a key of seven is not used even then', r.items[0].options, []);
r = applyShared([q('15')], [{ from: 15, to: 17, options: four.slice(0, 3) }], 6);
eq('a key of three is not used even then', r.items[0].options, []);
r = applyShared([q('15'), q('18')], [{ from: 15, to: 17, options: [...four, 'both are false'] }, { from: 18, to: null, options: four }], 6);
eq('a five-option key and a four-option key in one page, each to its own questions', r.items.map((x) => x.options.length), [5, 4]);
r = applyShared([q('15')], [{ from: 15, to: 17, options: four.slice(0, 3) }]);
eq('a key of three is not used', r.items[0].options, []);
r = applyShared([q('15')], [{ from: 15, to: 17, options: [] }]);
eq('a block with no options is not used', r.attached, 0);

r = applyShared([q('18'), q('19'), q('20')], [{ from: 18, to: null, options: four }]);
eq('a block with no end covers what follows', r.items.map((x) => x.options.length), [4, 4, 4]);
const second = ['p', 'q', 'r', 's'];
r = applyShared([q('15'), q('16'), q('18'), q('19')], [{ from: 15, to: null, options: four }, { from: 18, to: null, options: second }]);
eq('a later block takes over from where it starts', r.items.map((x) => x.options[0]), [four[0], four[0], 'p', 'p']);
r = applyShared([q('15'), q('16'), q('17')], [{ from: 15, to: 16, options: four }]);
eq('a block with an end stops there', r.items.map((x) => x.options.length), [4, 4, 0]);

r = applyShared([q('Q15.'), q('(16)'), q('17(a)'), q('')], [block]);
eq('numbers as printed are understood', r.items.map((x) => x.options.length), [4, 4, 4, 0]);
r = applyShared([{ text: 'no number' }, q(null)], [block]);
eq('a question with no number is left alone', r.attached, 0);

const before = [q('15')];
const copy = JSON.stringify(before);
applyShared(before, [block]);
eq('the items it was given are not changed', JSON.stringify(before), copy);
eq('no blocks means the same items', applyShared(before, []).items === before, true);

// which questions are worth asking the page for a key
eq('English, marked (A) and (R)', looksLikeAssertionReason('Assertion (A): Alkenes are more reactive than alkanes.\nReason (R): Alkenes contain a double bond.'), true);
eq('only the marks', looksLikeAssertionReason('(A) The sun is a star. (R) It gives light.'), true);
eq('Hindi words', looksLikeAssertionReason('अभिकथन (A): ... कारण (R): ...'), true);
eq('Tamil words', looksLikeAssertionReason('கூற்று (A): ... காரணம் (R): ...'), true);
eq('a reason asked for is not one', looksLikeAssertionReason('Give a reason why iron rusts.'), false);
eq('an assertion alone is not one', looksLikeAssertionReason('Assertion (A): Alkenes are reactive.'), false);
eq('a plain question', looksLikeAssertionReason('A body of mass 5 kg moves with a velocity of 4 m/s. Its kinetic energy is'), false);
eq('lower-case labels are not the marks', looksLikeAssertionReason('Choose (a) or (r) as shown.'), false);
eq('not text', looksLikeAssertionReason(null), false);

const arq = (number, extra = {}) => ({ number, kind: 'other', text: `Assertion (A): a${number}. Reason (R): r${number}.`, options: [], ...extra });
eq('the questions that look like Assertion and Reason and have no options', wantingKey([arq('15'), arq('16'), q('3')]), ['15', '16']);
eq('one with options of its own is not wanting', wantingKey([arq('15', { options: four })]), []);
eq('options that are blank do not count', wantingKey([arq('15', { options: ['', ' '] })]), ['15']);
eq('a question with no number is skipped', wantingKey([arq(''), arq(null)]), []);
eq('numbers are kept as printed', wantingKey([arq('Q15.'), arq('१५')]), ['Q15.', '१५']);
eq('an ordinary page wants nothing', wantingKey([q('1'), q('2')]), []);
eq('only thirty', wantingKey(Array.from({ length: 40 }, (_, i) => arq(String(i + 1)))).length, 30);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
