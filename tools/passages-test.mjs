// Checks for handing a passage on to the questions at the top of the next page (api/src/lib/passages.ts), on the two layouts seen in
// real papers and on the layouts that must be left alone. No keys, no database.
// Run: node tools/passages-test.mjs
import { carryPlan, continues, firstLabel, takePassages } from '../api/src/lib/passages.ts';

let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    fail++;
    console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want));
  } else console.log('ok  ', name);
};
const top = (label, text, o = {}) => ({ label, text, contPrev: false, wanting: false, edited: false, ...o });
const before = (label, text) => ({ label, text });

// ---- the reader's passage items
const storm = 'Due to heavy storm, an electric wire got bent in a mathematical shape. The shape of the bent wire is represented by the following graph. Answer the questions based on the graph.';
const q = (number, text) => ({ number, kind: 'mcq', text, options: ['a', 'b', 'c', 'd'] });
let t = takePassages([q('9', 'Nine?'), q('10', 'Ten?'), { number: '', kind: 'passage', text: ` ${storm} `, options: [] }]);
eq('a passage at the foot of the page is taken out of the questions', t.items.map((x) => x.number), ['9', '10']);
eq('and kept, for the next page', t.passageEnd, storm);
t = takePassages([{ kind: 'passage', text: storm }, q('1', 'One?'), q('2', 'Two?')]);
eq('a passage anywhere else is dropped: its questions carry it', [t.items.length, t.passageEnd], [2, null]);
eq('a short line at the foot is no passage', takePassages([q('1', 'One?'), { kind: 'passage', text: 'Answer all the questions.' }]).passageEnd, null);
eq('nor is a section heading', takePassages([q('1', 'One?'), { kind: 'passage', text: 'Section B: each question carries one mark. Questions 21 to 30 are short answer questions.' }]).passageEnd, null);
eq('a page with no passage item is left as it is', takePassages([q('1', 'One?')]), { items: [q('1', 'One?')], passageEnd: null });

// ---- numbering
eq('11 comes after 10', continues('10', '11'), true);
eq('"Q 11." comes after "10."', continues('10.', 'Q 11.'), true);
eq('(iv) comes after (iii)', continues('(iii)', '(iv)'), true);
eq('10(iv) comes after 10(iii)', continues('10(iii)', '10 (iv)'), true);
eq('(c) comes after (b)', continues('(b)', '(c)'), true);
eq('12 does not come after 10', continues('10', '12'), false);
eq('1 does not come after 3', continues('3', '1'), false);
eq('nothing comes after no number', continues(null, '1'), false);
eq('1, (i), (a) and 10(i) start a group', ['1', '(i)', 'a', '10(i)', 'Q1.'].map(firstLabel), [true, true, true, true, true]);
eq('11, (iv) and (b) do not', ['11', '(iv)', '(b)', '10(ii)'].map(firstLabel), [false, false, false, false]);

// ---- a passage printed alone at the foot of the page (paper 52e8c52d)
const wire = [
  top('11', 'Name the shape in which the wire is bent', { wanting: true }),
  top('12', 'How many zeroes are there for the polynomial representing the shape of the wire?', { wanting: true }),
  top('13', 'The zeroes of the polynomial represented by the wire are', { wanting: true }),
  top('14', 'The expression of the polynomial representing the wire is', { wanting: true }),
  top('15', 'The value of the polynomial at $x = -1$ is'),
  top('16', 'A highway underpass is parabolic in shape. Answer the following questions based on the given information.\n\nIf the highway overpass is represented by a polynomial, its zeroes are'),
  top('17', 'A highway underpass is parabolic in shape. Answer the following questions based on the given information.\n\nNumber of zeroes of the polynomial representing the underpass is'),
];
eq('every question at the top up to the next passage gets it, the one the reader missed too', carryPlan(storm, [], wire), { passage: storm, give: [0, 1, 2, 3, 4] });
eq('a question the tutor changed is left as she has it', carryPlan(storm, [], wire.map((x, i) => (i === 1 ? { ...x, edited: true } : x)))?.give, [0, 2, 3, 4]);
eq('a question that has it already is not given it twice', carryPlan(storm, [], wire.map((x, i) => (i < 5 ? { ...x, text: `${storm}\n\n${x.text}` } : x))), null);
eq('the rest of a question cut by the page edge is passed over', carryPlan(storm, [], [top('', '', { contPrev: true }), ...wire.slice(0, 2)])?.give, [1, 2]);
eq('a page that starts with a passage of its own gets nothing', carryPlan(storm, [], wire.slice(5)), null);

// ---- the same paper, page 3: the last case study's five questions, then "SECTION B – ASSERTION AND REASON" with its key printed once
const bridge = 'A suspension bridge is a type of bridge in which the deck is hung below suspension cables on vertical suspenders. The suspension cables are in parabolic shape.\n\nA parabola is the curve representing $p(x) = ax^2 + bx + c$.';
const statements = (n, a, r) => top(n, `Statement-1 (A): ${a}\nStatement-2 (R): ${r}`);
const page3b = [
  top('21', 'If the suspension cable is represented by the polynomial $x^2 - 8x - 20$, then its zeroes are', { wanting: true }),
  top('22', 'A quadratic polynomial the sum and product of whose zeroes are $-4$ and $-12$, respectively, is'),
  top('23', 'A quadratic polynomial whose one zero is $-2$ and the sum of zeroes is 2, is'),
  top('24', 'A quadratic polynomial whose zeroes are reciprocal of the zeroes of $6x^2 - 7x - 3$, is'),
  top('25', 'If the parabola representing quadratic polynomial $ax^2 + bx + c$ touches x-axis, then'),
  statements('26', 'If the equations have a common root and $a + b \\ne 0$, then $a - b = 1$.', 'A common root of two equations satisfies both the equations.'),
  statements('27', 'If the roots are equal in magnitude and opposite in sign, then p, r, q are in A.P.', 'The sum of the roots of $ax^2 + bx + c = 0$ is $b/a$.'),
];
eq('the case study\'s questions get it, the Assertion and Reason section after them does not', carryPlan(bridge, [], page3b), { passage: bridge, give: [0, 1, 2, 3, 4] });
eq('nor does a section that numbers its questions afresh', carryPlan(bridge, [], [...page3b.slice(0, 2), top('1', 'The degree of the polynomial $x^3 + 1$ is')])?.give, [0, 1]);
eq('Assertion and Reason questions at the top of a page get no passage', carryPlan(bridge, [], page3b.slice(5)), null);
const key = 'For each question, choose the correct option:\n(a) Statement-1 and Statement-2 are True; Statement-2 is a correct explanation for Statement-1.\n(b) Statement-1 and Statement-2 are True; Statement-2 is not a correct explanation for Statement-1.\n(c) Statement-1 is True; Statement-2 is False.\n(d) Statement-1 is False; Statement-2 is True.';
eq('the key printed above Assertion and Reason questions is no passage', takePassages([q('25', 'Twenty-five?'), { kind: 'passage', text: key }]).passageEnd, null);
eq('even worded without an opening line', takePassages([q('25', 'Twenty-five?'), { kind: 'passage', text: key.split('\n').slice(1).join('\n') }]).passageEnd, null);

// ---- a case study whose last question is at the top of the next page (paper 3fa18690)
const house = 'CASE STUDY 2: HOUSE LAYOUT\n\nA rectangular house is 15 m wide. Across the upper section are a bedroom of width x m, a bathroom of width 2 m and a kitchen of width y m. The upper bedroom and kitchen are each 5 m deep. The two bedrooms together with the kitchen have a total area of 95 sq. m. The lower bedroom is also x m wide and 5 m deep.';
const taxi = 'CASE STUDY 3: TAXI FARES\n\nTaxi fares include a fixed charge and an additional charge for each kilometre travelled.';
const page2 = [
  before('2', 'CASE STUDY 1: EXAMINATION\n\nA student scored 65 marks in a test of 100 questions, losing a quarter mark for each wrong answer.\n\nHow many questions did the student answer correctly?'),
  before('3', 'CASE STUDY 1: EXAMINATION\n\nA student scored 65 marks in a test of 100 questions, losing a quarter mark for each wrong answer.\n\nHow many questions did the student answer incorrectly?'),
  before('1', `${house}\n\nWhich pair of equations represents the given information?`),
  before('2', `${house}\n\nFind the width of the upper bedroom (x).`),
];
const page3 = [
  top('3', 'If the kitchen is 5 m deep, find its area.', { wanting: true }),
  top('1', `${taxi}\n\nIf x is the fixed charge, which equations are correct?`),
  top('2', `${taxi}\n\nWhat is the fixed charge in City A?`),
];
eq('the question that carries on the group\'s own numbering gets the group\'s passage', carryPlan(null, page2, page3), { passage: house, give: [0] });
eq('even when the reader did not find it wanting', carryPlan(null, page2, page3.map((x, i) => (i === 0 ? { ...x, wanting: false } : x)))?.give, [0]);
eq('a question that does not carry on the numbering gets nothing', carryPlan(null, page2, [top('5', 'If the kitchen is 5 m deep, find its area.', { wanting: true }), ...page3.slice(1)]), null);
eq('one the reader said carries on from the page before, but numbered as a question of its own, gets it (a run read it so)',
  carryPlan(null, page2, [top('3', 'If the kitchen is 5 m deep, find its area.', { contPrev: true, wanting: true }), ...page3.slice(1)]), { passage: house, give: [0] });
eq('the rest of a cut question, with no number, is still passed over', carryPlan(null, page2, [top('', 'deep, find its area.', { contPrev: true }), ...page3.slice(1)]), null);
eq('a page whose last question has no passage hands nothing on', carryPlan(null, [...page2, before('3', 'What is 2 + 2?')], page3), null);

// ---- the paper's own numbering: only a question the reader found wanting
const shop = 'A shop sells pens at Rs. 12 each and notebooks at Rs. 30 each, and gives a tenth off any bill above Rs. 200.';
const page5 = [before('16', `${shop}\n\nWhat do 5 pens cost?`), before('17', `${shop}\n\nWhat do 4 notebooks cost?`)];
eq('a question of its own that merely comes next is left alone', carryPlan(null, page5, [top('18', 'What is the value of $\\sqrt{49}$?'), top('19', 'Solve $2x = 6$.')]), null);
eq('one the reader found wanting gets the passage', carryPlan(null, page5, [top('18', 'What is the bill for 10 pens and 4 notebooks?', { wanting: true }), top('19', 'Solve $2x = 6$.')]), { passage: shop, give: [0] });
const ar = 'Questions 8 and 9 consist of statements of an Assertion (A) and a Reason (R). Choose the right answer from the key below.';
eq('an Assertion and Reason note shared by two questions is not handed to a whole question after it',
  carryPlan(null, [before('8', `${ar}\n\nAssertion (A): All decomposers are parasites.`), before('9', `${ar}\n\nAssertion (A): The heart has four chambers.`)], [top('10', 'Which organ pumps blood?')]), null);
eq('nor to a wanting one',
  carryPlan(null, [before('8', `${ar}\n\nAssertion (A): All decomposers are parasites.`), before('9', `${ar}\n\nAssertion (A): The heart has four chambers.`)], [top('10', 'Which of these is shown in the figure?', { wanting: true })]), null);

// ---- 52e8c52d page 1 to 2 when the reader misses the wire's passage at the foot of page 1 (two runs of four did)
const boat = 'The speed of a motorboat is $20$ km/hr. For covering the distance of $15$ km, the boat took $1$ hour more for upstream than downstream.';
const page1 = [before('9', `${boat}\n\nThe speed of the current is`), before('10', `${boat}\n\nTime taken by the motorboat to cover $15$ km upstream is`)];
eq('the wire\'s questions are not handed the motorboat\'s passage, though their numbers follow on and they are wanting', carryPlan(null, page1, wire.slice(0, 5)), null);
eq('a question of the motorboat\'s own that follows on is handed it',
  carryPlan(null, [before('8', page1[0].text), before('9', page1[1].text)], [top('10', 'The speed of the current is', { wanting: true }), ...wire.slice(0, 2)]), { passage: boat, give: [0] });
eq('one with no words of its own that carries on a group is handed it', carryPlan(null, page2, [top('3', 'Find $x + y$.'), ...page3.slice(1)])?.give, [0]);

// ---- one question at the foot of the page under a passage that starts a group
const one = [before('1', `${house}\n\nWhich pair of equations represents the given information?`)];
eq('a single question under a passage hands it only to a wanting question that carries on its numbering',
  carryPlan(null, one, [top('2', 'Find the width of the upper bedroom (x).', { wanting: true })]), { passage: house, give: [0] });
eq('not to a whole question', carryPlan(null, one, [top('2', 'Find the width of the upper bedroom (x).')]), null);
const dice = [before('1', 'A dice is thrown 100 times with the frequencies for the outcomes 1 to 6 as given in the following table:\n\n| Outcome | Frequency |\n|---|---|\n| 1 | 10 |\n| 2 | 20 |')];
eq('a table question at the foot of a page hands nothing to the next question', carryPlan(null, dice, [top('2', 'The probability of an impossible event is')]), null);
eq('a first page hands nothing on', carryPlan(null, [], page3), null);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
