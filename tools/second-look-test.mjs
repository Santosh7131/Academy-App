// Checks for the second look at questions a page read left without their choices (api/src/lib/second-look.ts): which questions are read
// again, and what is taken from the new read. Built on the real misread (paper 50fe7af2, page 1, one run of four). No keys, no database.
// Run: node tools/second-look-test.mjs
import { applyRereads, cleanRereads, lastWordsOf, lostChoices } from '../api/src/lib/second-look.ts';

let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    fail++;
    console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want));
  } else console.log('ok  ', name);
};
const mcq = (number, text, options = ['$0$', '$1$', '$\\frac{1}{2}$', '$-1$']) => ({ number, kind: 'mcq', text, options });
const other = (number, text, extra = {}) => ({ number, kind: 'other', text, options: [], ...extra });

// ---- the page as the bad read gave it: eight questions with choices, then three without
const page = [
  mcq('1', 'The minimum probability of an event is', ['$0$', '$1$', '$\\frac{1}{2}$', '$-1$']),
  mcq('2', 'The maximum probability of an event is', ['$0$', '$1$', '$\\frac{1}{2}$', 'none of these']),
  mcq('3', 'What is the number of outcomes when a coin is tossed?', ['$1$', '$2$', '$4$', '$6$']),
  mcq('4', 'What is the number of outcomes when a cubical dice is thrown?', ['$2$', '$3$', '$4$', '$6$']),
  mcq('5', 'The sum of all the probabilities of all the possible outcomes of a trial is', ['$0$', '$1$', '$2$', '$-1$']),
  mcq('6', 'If $P(E)$ is the probability of an event E, then', ['$0 \\le P(E) \\le 1$', '$0 < P(E) < 1$', '$0 \\le P(E) < 1$', '$0 < P(E) \\le 1$']),
  mcq('7', '$P(E) + P(\\bar{E}) =$', ['$0$', '$1$', '$2$', 'none of these']),
  mcq('8', 'A coin is tossed 100 times with the following frequencies: Head: 75, Tail: 25. Find the probability of getting a head.', ['$\\frac{1}{4}$', '$\\frac{1}{2}$', '$\\frac{3}{4}$', '$1$']),
  other('9', 'Find the probability of outcome 1'),
  other('10', 'Two coins are tossed simultaneously 1000 times and we get Two heads: 200 times One head: 600 times No head: 200 times. Find the probability of getting two heads.'),
  other('11', 'Three coins are tossed simultaneously 600 times with the following frequencies of different outcomes:'),
];
eq('the three questions left without choices are read again', lostChoices(page), ['9', '10', '11']);
eq('a question cut by the page edge is not (its choices can be on the next page)',
  lostChoices(page.map((x) => (x.number === '11' ? { ...x, continues_on_next_page: true } : x))), ['9', '10']);
eq('nor the rest of one cut on the page before', lostChoices([other('', 'deep, find its area.', { continues_from_previous_page: true }), ...page.slice(0, 8)]), []);
eq('nor an Assertion and Reason question (its key has a look of its own)',
  lostChoices([...page.slice(0, 8), other('9', 'Assertion (A): The heart has four chambers.\nReason (R): Blood flows one way.')]), []);
eq('nor a question with no number', lostChoices([...page.slice(0, 8), other('', 'Find the probability of outcome 1')]), []);
eq('a question with only some of its choices is', lostChoices([...page.slice(0, 8), { ...mcq('9', 'Find the probability of outcome 1'), options: ['$\\frac{1}{10}$', '$\\frac{1}{5}$'] }]), ['9']);
eq('a passage item is no question', lostChoices([...page.slice(0, 8), { number: '', kind: 'passage', text: 'A dice is thrown 100 times.', options: [] }]), []);
eq('a page mostly of written answers gets no look', lostChoices([...page.slice(0, 2), other('3', 'Define probability.'), other('4', 'Prove that P(E) + P(not E) = 1.'), other('5', 'Explain an impossible event.')]), []);
eq('nor a page with a single multiple-choice question', lostChoices([page[0], other('2', 'Define probability.')]), []);
eq('nor a page whose questions all came with their choices', lostChoices(page.slice(0, 8)), []);
eq('at most six are asked about', lostChoices([...page.slice(0, 8), ...['9', '10', '11', '12', '13', '14', '15'].map((n) => other(n, `Question ${n}?`))]).length, 6);

// ---- what the second look read
const dice = 'A dice is thrown $100$ times with the frequencies for the outcomes $1, 2, 3, 4, 5$ and $6$ as given in the following table:\n| Outcome | Frequency |\n|---|---|\n| 1 | 10 |\n| 2 | 20 |\n| 3 | 10 |\n| 4 | 20 |\n| 5 | 25 |\n| 6 | 15 |\nFind the probability of outcome 1';
const reread = [
  { number: '9', text: dice, options: ['$\\frac{1}{10}$', '$\\frac{1}{5}$', '$\\frac{1}{4}$', '$\\frac{1}{2}$'] },
  { number: '10', text: 'Two coins are tossed 1000 times. Find the probability of two heads.', options: ['$\\frac{1}{4}$', '$\\frac{1}{5}$', '$\\frac{1}{2}$', '$\\frac{1}{3}$'] },
  { number: '11', text: 'Three coins are tossed simultaneously 600 times with the following frequencies of different outcomes:', options: [] },
];
const done = applyRereads(page, reread, 6);
const q = (n) => done.items.find((x) => x.number === n);
eq('the choices read again are taken, and the question is multiple choice again', [q('9').kind, q('9').options, q('10').kind, done.fixed], ['mcq', reread[0].options, 'mcq', 2]);
eq('words that hold all of the old ones and more (its table) replace them', q('9').text, dice);
eq('words that do not hold all of the old ones are kept as first read', q('10').text, page[9].text);
eq('a question still read without choices stays as it was', q('11'), page[10]);
eq('the questions that had their choices are untouched', done.items.slice(0, 8), page.slice(0, 8));
eq('choices that are another question\'s on the page are not taken (the look strayed)',
  applyRereads(page, [{ number: '9', text: '', options: page[7].options }], 6).fixed, 0);
eq('nor the same choices for two questions', applyRereads(page, [{ ...reread[0] }, { number: '10', text: '', options: reread[0].options }], 6).fixed, 1);
eq('three choices are not a whole list', applyRereads(page, [{ number: '9', text: '', options: ['a', 'b', 'c'] }], 6).fixed, 0);
eq('five are, for an app that holds five', applyRereads(page, [{ number: '9', text: '', options: ['a', 'b', 'c', 'd', 'e'] }], 6).fixed, 1);
eq('but not for an older app that holds four', applyRereads(page, [{ number: '9', text: '', options: ['a', 'b', 'c', 'd', 'e'] }], 4).fixed, 0);
eq('a question the look was not asked about is never changed', applyRereads(page, [{ number: '3', text: 'Something else', options: ['w', 'x', 'y', 'z'] }], 6).items, page);
eq('"Q 9." in the reply is question 9', applyRereads(page, [{ ...reread[0], number: 'Q 9.' }], 6).fixed, 1);
eq('nothing read again: the page is as it was', applyRereads(page, [], 6), { items: page, fixed: 0 });

// ---- where each question ended, told to the look (paper de3ccf0f: the question ends at the top of the next column, its choices there)
eq('a short question is given whole', lastWordsOf(page, ['9']), { 9: 'Find the probability of outcome 1' });
const words = lastWordsOf(page, ['10'])['10'];
eq('a long one by its last words, from the start of a word', [words.startsWith('…'), words.length <= 101, page[9].text.endsWith(words.slice(1)), /^…\S/.test(words) && page[9].text.includes(` ${words.slice(1)}`)], [true, true, true, true]);
eq('line breaks and runs of spaces are one space', lastWordsOf([other('3', 'Table:\n| a | b |\n\n|  1 | 2 |')], ['3']), { 3: 'Table: | a | b | | 1 | 2 |' });
eq('a number not on the page, or a question without words, is left out', lastWordsOf([other('3', '  '), ...page], ['3', '12']), {});

// ---- the reply
eq('a reply entry with no number is dropped, options are trimmed, junk is ignored',
  cleanRereads([{ number: '', options: ['a'] }, { number: 9, text: ' x ', options: [' a ', 2, '', 'b'] }, 'junk', null]), [{ number: '9', text: 'x', options: ['a', 'b'] }]);
eq('a reply that is no list gives nothing', cleanRereads({ questions: 'none' }), []);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
