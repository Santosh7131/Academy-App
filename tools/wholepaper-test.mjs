// Checks for reading a paper a few pages to a request: how the pages are shared out and how a reply for several pages is taken apart.
// Run: node tools/wholepaper-test.mjs
import { absorbRests, degenerate, parseWholePages, planWindows, restBoxes, WINDOW_PAGES } from '../api/src/lib/wholepaper.ts';

let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    fail++;
    console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want));
  } else console.log('ok  ', name);
};
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

// ---- the windows
eq('a request holds four pages', WINDOW_PAGES, 4);
eq('no pages, no requests', planWindows([]), []);
eq('one page is one request', planWindows([1]), [[1]]);
eq('three pages are one request', planWindows([1, 2, 3]), [[1, 2, 3]]);
eq('four pages are one request', planWindows(range(1, 4)), [range(1, 4)]);
eq('five pages are shared three and two, not four and one', planWindows(range(1, 5)), [[1, 2, 3], [4, 5]]);
eq('nine pages are three of three', planWindows(range(1, 9)), [[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
eq('twelve pages are three of four', planWindows(range(1, 12)).map((w) => w.length), [4, 4, 4]);
eq('twenty pages are five of four', planWindows(range(1, 20)).map((w) => w.length), [4, 4, 4, 4, 4]);
eq('pages in no order, with repeats, are sorted and counted once', planWindows([3, 1, 2, 2]), [[1, 2, 3]]);
eq('a request never holds pages that do not follow one another', planWindows([1, 2, 5, 6, 7]), [[1, 2], [5, 6, 7]]);
eq('a gap splits even when the pages would fit', planWindows([1, 3]), [[1], [3]]);
eq('numbers that are not pages are ignored', planWindows([0, -1, 1.5, 2]), [[2]]);
eq('a smaller window can be asked for', planWindows(range(1, 6), 2), [[1, 2], [3, 4], [5, 6]]);
eq('every page is in exactly one request', planWindows(range(1, 17)).flat(), range(1, 17));

// ---- a reply for several pages
const q = (number, text, extra = {}) => ({ number, kind: 'mcq', text, options: ['a', 'b', 'c', 'd'], ...extra });
const reply = (pages) => JSON.stringify({ pages });
const keys = (m) => [...m.keys()];

let got = parseWholePages(reply([{ page: 3, questions: [q('1', 'One?')], answer_key: [] }, { page: 4, questions: [q('2', 'Two?'), q('3', 'Three?')], answer_key: [{ number: '1', answer: 'b' }] }]), [3, 4]);
eq('both pages come back', keys(got), [3, 4]);
eq('a page keeps its questions', got.get(4).items.length, 2);
eq('a page keeps its key', got.get(4).key, [{ number: '1', answer: 'b' }]);

eq('a reply in a code fence is read', keys(parseWholePages('```json\n' + reply([{ page: 1, questions: [q('1', 'One?')] }]) + '\n```', [1])), [1]);
eq('page numbers written as text are read', keys(parseWholePages(reply([{ page: '2', questions: [q('1', 'One?')] }]), [2])), [2]);
eq('"page 2" is page 2', keys(parseWholePages(reply([{ page: 'Page 2', questions: [q('1', 'One?')] }]), [2])), [2]);
eq('a page that was not asked for is left out', keys(parseWholePages(reply([{ page: 1, questions: [q('1', 'One?')] }, { page: 9, questions: [q('2', 'Two?')] }]), [1])), [1]);
eq('a page the reply leaves out is not in the answer', keys(parseWholePages(reply([{ page: 1, questions: [q('1', 'One?')] }]), [1, 2])), [1]);
eq('the first entry for a page wins', parseWholePages(reply([{ page: 1, questions: [q('1', 'First?')] }, { page: 1, questions: [q('1', 'Second?')] }]), [1]).get(1).items[0].text, 'First?');
eq('a page with an empty list is a page with nothing on it', parseWholePages(reply([{ page: 1, questions: [] }]), [1]).get(1), { items: [], key: [] });
eq('a passage printed alone at the foot of a page comes along as the page\'s last item, for the server to hand on',
  parseWholePages(reply([{ page: 1, questions: [q('1', 'First?'), { number: '', kind: 'passage', text: 'A wire is bent into a curve.', options: [] }] }]), [1]).get(1).items.map((x) => x.kind), ['mcq', 'passage']);
eq('an entry with neither a list of questions nor a key is no page', keys(parseWholePages(reply([{ page: 1, note: 'blank' }]), [1])), []);
eq('a reply that is not JSON gives nothing', keys(parseWholePages('I could not read these pages.', [1, 2])), []);
eq('an empty reply gives nothing', keys(parseWholePages('', [1, 2])), []);
eq('a reply with no pages gives nothing', keys(parseWholePages('{"questions":"none"}', [1, 2])), []);

// a model that numbers the pages from 1 inside the request
got = parseWholePages(reply([{ page: 1, questions: [q('1', 'A?')] }, { page: 2, questions: [q('2', 'B?')] }]), [7, 8]);
eq('pages numbered from 1 are followed by position when there are as many as were sent', keys(got), [7, 8]);
eq('and each keeps its own questions', got.get(8).items[0].text, 'B?');
eq('but not when the count does not match', keys(parseWholePages(reply([{ page: 1, questions: [q('1', 'A?')] }]), [7, 8])), []);

// one page asked for, the answer is the page's own shape
eq('a reply shaped like one page is that page', keys(parseWholePages(JSON.stringify({ questions: [q('1', 'One?')], answer_key: [] }), [5])), [5]);
eq('a bare list of pages is read', keys(parseWholePages(JSON.stringify([{ page: 1, questions: [q('1', 'One?')] }]), [1])), [1]);

// LaTeX with one backslash, the way models write it
const raw = '{"pages":[{"page":1,"questions":[{"number":"1","kind":"mcq","text":"Find $\\frac{3}{4} + \\sqrt{2}$","options":["a","b","c","d"]}]}]}';
eq('LaTeX with single backslashes is kept', parseWholePages(raw, [1]).get(1).items[0].text, 'Find $\\frac{3}{4} + \\sqrt{2}$');

// a reply cut off part way keeps the pages it finished
const whole = reply([{ page: 1, questions: [q('1', 'One?')] }, { page: 2, questions: [q('2', 'Two?')] }, { page: 3, questions: [q('3', 'Three?'), q('4', 'Four?')] }]);
const cut = whole.slice(0, whole.lastIndexOf('Four?') - 3);
got = parseWholePages(cut, [1, 2, 3]);
eq('a reply cut inside its last page keeps the pages before it', keys(got), [1, 2]);
eq('and what they say', got.get(2).items[0].text, 'Two?');
eq('a reply cut inside its first page keeps nothing', keys(parseWholePages(whole.slice(0, 60), [1, 2, 3])), []);
eq('a reply cut right after a whole page keeps it', keys(parseWholePages(whole.slice(0, whole.indexOf('{"page":3') - 1), [1, 2, 3])), [1, 2]);

// a model that has lost its place
const same = (n) => Array.from({ length: n }, (_, i) => q(String(i + 1), 'What is the speed of light?'));
eq('the same question again and again is not a page', degenerate(same(9)), true);
eq('four questions are never judged', degenerate(same(4)), false);
eq('ordinary questions are fine', degenerate(Array.from({ length: 12 }, (_, i) => q(String(i + 1), `Question number ${i + 1} about topic ${'abcdefghijkl'[i]}`))), false);
eq('a page of repeated questions is left out, so it is read on its own', keys(parseWholePages(reply([{ page: 1, questions: same(9) }, { page: 2, questions: [q('1', 'Fine?')] }]), [1, 2])), [2]);
eq('two repeats on a page are only repeats', degenerate([...same(2), ...Array.from({ length: 6 }, (_, i) => q(String(i + 3), `Another one ${i}`))]), false);

// ---- a question over a page edge that the model wrote whole
const mk = (items) => ({ items, key: [] });
const item = (o) => ({ number: '16', kind: 'mcq', text: 'A candle is placed in front of a mirror. The image formed is', options: ['real', 'virtual', 'diminished', 'magnified'], continues_on_next_page: false, continues_from_previous_page: false, question_box: [10, 20, 30, 40], ...o });
const run = (a, b, nos = [2, 3]) => {
  const reads = new Map([[2, mk(a)], [3, mk(b)]]);
  absorbRests(nos, reads, 4);
  return reads;
};
let r = run([item({ continues_on_next_page: true })], [item({ number: '', text: '', continues_from_previous_page: true, question_box: [5, 6, 7, 8] }), item({ number: '17', text: 'Next?' })]);
eq('a rest that repeats a whole question is folded into it', r.get(3).items.map((x) => x.number), ['17']);
eq('the question stops saying it goes on', r.get(2).items[0].continues_on_next_page, false);
eq('and keeps the rest\'s box, with its page', restBoxes.get(r.get(2).items[0]), [{ page: 3, box: [5, 6, 7, 8] }]);

r = run([item({ options: ['real', 'virtual'], continues_on_next_page: true })], [item({ number: '', text: '', options: ['diminished', 'magnified'], continues_from_previous_page: true })]);
eq('the strict way (two options, then the other two) is left for the join', [r.get(2).items[0].options.length, r.get(3).items.length, r.get(2).items[0].continues_on_next_page], [2, 1, true]);

r = run([item({ options: ['real', 'virtual'], continues_on_next_page: true })], [item({ number: '', text: '', options: ['real', 'virtual', 'diminished', 'magnified'], continues_from_previous_page: true })]);
eq('a second page that holds the whole list gives it to the question', [r.get(2).items[0].options, r.get(3).items.length], [['real', 'virtual', 'diminished', 'magnified'], 0]);

r = run([item({ continues_on_next_page: true })], [item({ number: '', text: '', options: ['diminished', 'magnified'], continues_from_previous_page: false })]);
eq('only options at the top of a page are a rest even when not said', r.get(3).items.length, 0);

r = run([item({ continues_on_next_page: true })], [item({ number: '', text: '', options: ['real', 'virtual', 'something else'], continues_from_previous_page: true })]);
eq('a rest with an option the question lacks is left for the join', r.get(3).items.length, 1);

r = run([item({ options: ['real', 'virtual'], continues_on_next_page: true })], [item({ number: '', text: '', options: ['real', 'virtual'], continues_from_previous_page: true })]);
eq('two of four options is a first part, not a whole, even when the rest repeats them', r.get(3).items.length, 1);

r = run([item({ continues_on_next_page: true })], [item({ number: '', text: '', continues_from_previous_page: true })], [2, 4]);
eq('pages that do not follow one another are not looked at', r.get(3).items.length, 1);

r = run([item({ kind: 'other', options: [], text: 'Explain why the sky is blue and why sunsets are red.', continues_on_next_page: true })], [item({ kind: 'other', options: [], number: '', text: 'and why sunsets are red', continues_from_previous_page: true })]);
eq('words the question already has are no rest', r.get(3).items.length, 0);

r = run([item({ kind: 'other', options: [], text: 'Explain why the sky is blue', continues_on_next_page: true })], [item({ kind: 'other', options: [], number: '', text: 'and why sunsets are red', continues_from_previous_page: true })]);
eq('words the question lacks are its rest, left for the join', r.get(3).items.length, 1);

r = run([item({ continues_on_next_page: true })], [item({ number: '17', text: 'A fresh question?', continues_from_previous_page: false })]);
eq('a next page that starts with a new question is left alone', [r.get(3).items.length, r.get(2).items[0].continues_on_next_page], [1, true]);

r = run([], [item({ number: '', text: '', continues_from_previous_page: true })]);
eq('a page with nothing before the rest is left alone', r.get(3).items.length, 1);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
