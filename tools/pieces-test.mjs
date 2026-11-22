// Checks for the boxes a page reader gives and for putting a question that ran over a page edge back together.
// Run: node tools/pieces-test.mjs
import { cleanBox, cleanPlaced, cleanPlacedList, isRestOfQuestion, joinParts, looksCut, placed, placedQuestion, plausibleQuestionBox, storedOptions } from '../api/src/lib/pieces.ts';
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    fail++;
    console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want));
  } else console.log('ok  ', name);
};

// boxes as models write them
eq('fractions stay', cleanBox([0.1, 0.2, 0.5, 0.6]), [0.1, 0.2, 0.5, 0.6]);
eq('0 to 1000 becomes fractions', cleanBox([100, 200, 500, 600]), [0.1, 0.2, 0.5, 0.6]);
eq('wrapped in one more list', cleanBox([[0.1, 0.2, 0.5, 0.6]]), [0.1, 0.2, 0.5, 0.6]);
eq('right edge first is swapped', cleanBox([0.5, 0.2, 0.1, 0.6]), [0.1, 0.2, 0.5, 0.6]);
eq('bottom edge first is swapped', cleanBox([0.1, 0.6, 0.5, 0.2]), [0.1, 0.2, 0.5, 0.6]);
eq('outside the page is pulled in', cleanBox([-0.2, 0.1, 1.2, 0.9]), [0, 0.1, 1, 0.9]);
eq('not four numbers', cleanBox([0.1, 0.2, 0.5]), null);
eq('numbers as text', cleanBox(['0.1', '0.2', '0.5', '0.6']), null);
eq('null', cleanBox(null), null);
eq('a sliver is no box', cleanBox([0.1, 0.2, 0.11, 0.6]), null);
eq('a line is no box', cleanBox([0.1, 0.2, 0.5, 0.21]), null);
eq('NaN', cleanBox([0.1, NaN, 0.5, 0.6]), null);
eq('rounds to four places', cleanBox([0.123456, 0.2, 0.55555, 0.6]), [0.1235, 0.2, 0.5556, 0.6]);
eq('top, left, bottom, right (Gemini\'s own order) is read as left, top, right, bottom', cleanBox([116, 81, 198, 892], 'yx'), [0.081, 0.116, 0.892, 0.198]);
eq('the same in fractions', cleanBox([0.2, 0.1, 0.6, 0.5], 'yx'), [0.1, 0.2, 0.5, 0.6]);
eq('the plain order is what is read when none is said', cleanBox([100, 200, 500, 600], 'xy'), [0.1, 0.2, 0.5, 0.6]);
eq('a sliver is no box in the other order either', cleanBox([200, 100, 600, 110], 'yx'), null);
eq('placed takes the order', placed(2, [116, 81, 198, 892], 'yx'), { page: 2, box: [0.081, 0.116, 0.892, 0.198] });
eq('a question box across the page is plausible', plausibleQuestionBox([0.08, 0.1, 0.92, 0.2]), true);
eq('a thin tall sliver is not a question', plausibleQuestionBox([0.85, 0.11, 0.92, 0.95]), false);
eq('a hairline is not a question', plausibleQuestionBox([0.1, 0.2, 0.9, 0.205]), false);
eq('a question box that is a sliver is given up', placedQuestion(1, [0.854, 0.115, 0.925, 0.956]), null);
eq('a good question box is kept', placedQuestion(1, [0.08, 0.1, 0.92, 0.2]), { page: 1, box: [0.08, 0.1, 0.92, 0.2] });

// a box on a page
eq('placed', placed(2, [0.1, 0.2, 0.5, 0.6]), { page: 2, box: [0.1, 0.2, 0.5, 0.6] });
eq('placed with a bad box', placed(2, 'no'), null);
eq('cleanPlaced', cleanPlaced({ page: 3, box: [100, 200, 500, 600] }), { page: 3, box: [0.1, 0.2, 0.5, 0.6] });
eq('cleanPlaced page 0', cleanPlaced({ page: 0, box: [0.1, 0.2, 0.5, 0.6] }), null);
eq('cleanPlaced page as text', cleanPlaced({ page: '3', box: [0.1, 0.2, 0.5, 0.6] }), null);
eq('cleanPlaced not an object', cleanPlaced('x'), null);
eq('cleanPlacedList keeps good ones', cleanPlacedList([{ page: 1, box: [0.1, 0.1, 0.9, 0.5] }, { page: 2, box: 'no' }]), [{ page: 1, box: [0.1, 0.1, 0.9, 0.5] }]);
eq('cleanPlacedList of nothing', cleanPlacedList([]), null);

// joining
const part = (o) => ({ number_label: '4', kind: 'other', text: '', options: [], needs_diagram: false, unclear: false, question_boxes: null, figure_box: null, cont_next: false, cont_prev: false, ...o });

const cutInTheOptions = joinParts(
  part({ text: 'A lens forms a sharp image 15 cm away. Its power is nearly', options: ['6.67 D', '0.15 D'], cont_next: true, question_boxes: [{ page: 1, box: [0.1, 0.7, 0.9, 0.95] }] }),
  part({ number_label: null, options: ['1.5 D', '15 D'], cont_prev: true, question_boxes: [{ page: 2, box: [0.1, 0.05, 0.9, 0.15] }] }),
);
eq('options cut in two: text kept', cutInTheOptions?.text, 'A lens forms a sharp image 15 cm away. Its power is nearly');
eq('options cut in two: four options in order', cutInTheOptions?.options, ['6.67 D', '0.15 D', '1.5 D', '15 D']);
eq('options cut in two: multiple choice now', cutInTheOptions?.kind, 'mcq');
eq('options cut in two: not unclear', cutInTheOptions?.unclear, false);
eq('options cut in two: number kept', cutInTheOptions?.number_label, '4');
eq('options cut in two: both pictures', cutInTheOptions?.question_boxes?.map((b) => b.page), [1, 2]);
eq('options cut in two: no longer cut', [cutInTheOptions?.cont_next, cutInTheOptions?.cont_prev], [false, false]);

const cutInTheWords = joinParts(
  part({ text: 'A body of mass 2 kg moves at 3 m/s. Its kinetic', cont_next: true }),
  part({ number_label: null, text: 'energy is', options: ['9 J', '6 J', '3 J', '12 J'], cont_prev: true }),
);
eq('words cut in two: joined with one space', cutInTheWords?.text, 'A body of mass 2 kg moves at 3 m/s. Its kinetic energy is');
eq('words cut in two: four options', cutInTheWords?.options.length, 4);
eq('words cut in two: multiple choice', cutInTheWords?.kind, 'mcq');

const onlyOptions = joinParts(part({ text: 'Which is right?', options: ['a', 'b'], cont_next: true }), part({ number_label: null, text: '', options: ['c', 'd'], cont_prev: true }));
eq('rest with no words: text is not doubled or padded', onlyOptions?.text, 'Which is right?');

const lost = joinParts(part({ text: 'Which is right?', options: ['a', 'b'], cont_next: true }), part({ number_label: null, options: ['c'], cont_prev: true }));
eq('three options between them: joined but unclear', [lost?.kind, lost?.options.length, lost?.unclear], ['other', 3, true]);

eq('more than four options cannot be one question', joinParts(part({ text: 'q', options: ['a', 'b', 'c'], cont_next: true }), part({ options: ['d', 'e'], cont_prev: true })), null);
eq('nothing to say cannot be a question', joinParts(part({ text: '', cont_next: true }), part({ text: '', cont_prev: true })), null);

const figureOnTheRest = joinParts(part({ text: 'See the figure.', cont_next: true }), part({ number_label: null, options: ['a', 'b', 'c', 'd'], needs_diagram: true, figure_box: { page: 2, box: [0.1, 0.1, 0.6, 0.4] }, cont_prev: true }));
eq('a figure on the second page comes with it', [figureOnTheRest?.needs_diagram, figureOnTheRest?.figure_box?.page], [true, 2]);
const figureOnTheFirst = joinParts(
  part({ text: 'See the figure.', needs_diagram: true, figure_box: { page: 1, box: [0.1, 0.1, 0.6, 0.4] }, cont_next: true }),
  part({ number_label: null, options: ['a', 'b', 'c', 'd'], needs_diagram: true, figure_box: { page: 2, box: [0.1, 0.1, 0.6, 0.4] }, cont_prev: true }),
);
eq('two figures: the first one is kept', figureOnTheFirst?.figure_box?.page, 1);

eq('unclear on either part carries over', joinParts(part({ text: 'q', unclear: true, cont_next: true }), part({ options: ['a', 'b', 'c', 'd'], cont_prev: true }))?.unclear, true);
eq('a third page can follow', joinParts(part({ text: 'a', cont_next: true }), part({ text: 'b', cont_prev: true, cont_next: true }))?.cont_next, true);

eq('looksCut: two options', looksCut({ options: ['a', 'b'] }), true);
eq('looksCut: none', looksCut({ options: [] }), false);
eq('looksCut: four', looksCut({ options: ['a', 'b', 'c', 'd'] }), false);

// a question cut at the foot of a page that AI did not flag (his Q9: the stem and (a) to (c) on page 1, "(d) None of these" on page 2)
const pageEnd = { cutNext: false, cutPrev: false, lastOnPage: true };
eq('the last question on a page keeps three options when AI did not say it goes on', storedOptions('other', ['a', 'b', 'c'], pageEnd), ['a', 'b', 'c']);
eq('a question in the middle of a page does not', storedOptions('other', ['a', 'b', 'c'], { ...pageEnd, lastOnPage: false }), []);
eq('the last one with no options keeps none', storedOptions('other', [], pageEnd), []);
eq('the last one with four options is a question like any other', storedOptions('other', ['a', 'b', 'c', 'd'], pageEnd), []);
eq('a question AI flagged keeps what it has', storedOptions('other', ['a'], { cutNext: true, cutPrev: false, lastOnPage: false }), ['a']);
eq('the rest of a question keeps what it has', storedOptions('other', ['d'], { cutNext: false, cutPrev: true, lastOnPage: false }), ['d']);
eq('a multiple choice question keeps its options', storedOptions('mcq', ['a', 'b', 'c', 'd'], { cutNext: false, cutPrev: false, lastOnPage: false }), ['a', 'b', 'c', 'd']);
eq('AI says it is the rest', isRestOfQuestion(true, false, 'words', []), true);
eq('only options at the top of a page is the rest even when AI did not say so', isRestOfQuestion(false, true, '', ['None of these']), true);
eq('only options in the middle of a page is not', isRestOfQuestion(false, false, '', ['None of these']), false);
eq('words at the top of a page are a question of their own', isRestOfQuestion(false, true, 'Which is right?', ['a']), false);
eq('nothing at all is not the rest of anything', isRestOfQuestion(false, true, '  ', []), false);
const q9 = joinParts(part({ number_label: '9', text: 'n-pentane and isopentane represent', options: ['Structural isomers', 'Homologous', 'Same compound'] }), part({ number_label: null, text: '', options: ['None of these'], cont_prev: true }));
eq('Q9 joined: four options, multiple choice, nothing unclear', [q9?.kind, q9?.options.length, q9?.unclear, q9?.text], ['mcq', 4, false, 'n-pentane and isopentane represent']);

// the rest of a question as the reader wrote it on 2026-11-15
const kural = joinParts(
  part({ number_label: '16', text: 'கற்க கசடறக் கற்பவை கற்றபின் என்ற குறள் எந்த நூலில் உள்ளது?', options: ['நாலடியார்', 'திருக்குறள்'] }),
  part({ number_label: null, text: '(इ) ஆத்திசூடி\n(ஈ) புறநானூறு', cont_prev: true }),
);
eq('last options written as labelled lines go into the options', [kural?.kind, kural?.options, kural?.text, kural?.unclear],
  ['mcq', ['நாலடியார்', 'திருக்குறள்', 'ஆத்திசூடி', 'புறநானூறு'], 'கற்க கசடறக் கற்பவை கற்றபின் என்ற குறள் எந்த நூலில் உள்ளது?', false]);
const candle = joinParts(
  part({ number_label: '16', text: 'A candle is placed 30 cm in front of a concave mirror of focal length 15 cm. The image formed is', options: ['real, inverted and of the same size', 'virtual, erect and magnified'], cont_next: true }),
  part({ number_label: null, text: 'real, inverted and diminished', options: ['real, inverted and diminished', 'virtual, erect and diminished'], cont_prev: true }),
);
eq('an option written once more as the words of the rest is dropped', [candle?.kind, candle?.options.length, candle?.text],
  ['mcq', 4, 'A candle is placed 30 cm in front of a concave mirror of focal length 15 cm. The image formed is']);
eq('labelled lines with no options before them stay words (they may be statements)',
  joinParts(part({ text: 'Which of these are true?', cont_next: true }), part({ number_label: null, text: '(i) Copper conducts\n(ii) Wood conducts', options: ['(i) only', '(ii) only', 'both', 'neither'], cont_prev: true }))?.text,
  'Which of these are true? (i) Copper conducts\n(ii) Wood conducts');
eq('labelled lines with options of their own stay words', joinParts(part({ text: 'Which are true?', options: [], cont_next: true }), part({ number_label: null, text: '(i) X\n(ii) Y', options: ['a', 'b', 'c', 'd'], cont_prev: true }))?.text, 'Which are true? (i) X\n(ii) Y');

console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);
