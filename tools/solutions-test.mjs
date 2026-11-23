// Checks for worked solutions written by AI (api/src/lib/solutions.ts), with no server, database or model: what the model is asked,
// how its reply is read, that a solution is kept only when it reaches the marked answer, and that one naming an option by its letter
// (wrong on a student's screen, where the options are mixed up) is not. routes/solutions.ts is checked by tools/solutions-test.ts.
// Run: node tools/solutions-test.mjs
import { cleanSteps, MAX_SOLUTION, namesAnOption, optionNamed, readSolutions, solutionMessages } from '../api/src/lib/solutions.ts';

let fail = 0;
let pass = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : `\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
};

const q = (id, correct, options = ['3', '5', '15', '25'], extra = {}) => ({ id, text: `Question ${id}`, options, correct_option: correct, ...extra });

// ------------------------------------------------------------------ what the model is asked
{
  const [system, user] = solutionMessages({ study: 'Class 9 CBSE', subject: 'Maths' }, [q('a', 1), q('b', 0, ['x', 'y', 'z', 'w'], { image_key: 't/fig.png' })]);
  eq('the model is a Maths teacher for Class 9', system.content.startsWith('You are a patient Maths teacher in India who writes worked solutions for Class 9 CBSE students.'), true);
  eq('it reads and writes Hindi and Tamil', system.content.includes('English, Hindi or Tamil'), true);
  const asked = JSON.parse(user.content.slice(user.content.indexOf('Questions:\n') + 'Questions:\n'.length));
  eq('the questions go as q1 and q2, with lettered options', asked.map((x) => [x.id, Object.keys(x.options).join('')]), [['q1', 'ABCD'], ['q2', 'ABCD']]);
  eq('the marked answer is never sent', JSON.stringify(asked).includes('correct'), false);
  eq('a question with a figure says so', asked.map((x) => x.has_figure ?? false), [false, true]);
  eq('it is told never to name an option by its letter', user.content.includes('Never name an option by its letter'), true);
  eq('it is told to work it out before choosing', user.content.includes('before you look for the option that matches'), true);
  eq('LaTeX is shown with one backslash', user.content.includes('$\\frac{3}{4}$'), true);
  const course = solutionMessages({ study: null, subject: null, course: 'Spoken English' }, [q('a', 0)])[0].content;
  eq("a course's questions are for its students", course.includes('for students of a course called Spoken English.'), true);
}

// ------------------------------------------------------------------ the option a reply names
{
  const o = ['3', '5', '15', '25'];
  for (const [said, want] of [
    ['B', 1], ['b', 1], ['(b)', 1], ['(B)', 1], ['b.', 1], ['B) 5', 1], ['Option B', 1], ['option: c', 2], ['Answer: D', 3], ['15', 2], [' 25 ', 3],
    ['', null], ['A, C', null], ['E', null], ['a prime number', null], ['None of these', null], [3, null], [null, null],
  ]) eq(`"${said}" names ${want === null ? 'no option' : `option ${want}`}`, optionNamed(said, o), want);
  eq('words that are two options name neither', optionNamed('same', ['same', 'Same', 'x', 'y']), null);
}

// ------------------------------------------------------------------ naming an option by its letter
for (const [text, names] of [
  ['So the answer is (b).', true],
  ['Hence option B is correct.', true],
  ['So option (c).', true],
  ['Answer: D', true],
  ['Ans. C', true],
  ['So (b) is correct.', true],
  ['B is the right answer', true],
  ['The second option is right.', true],
  ['अतः सही उत्तर (ख) है।', true],
  ['எனவே விடை (ஆ).', true],
  ['So $x = 5$.', false],
  ['In triangle ABC, $AC^2 = AB^2 + BC^2 = 9 + 16 = 25$, so $AC = 5$ cm.', false],
  ['So the answer is a prime number: 29.', false],
  ['$f(a) = a^2$, so $f(3) = 9$.', false],
  ['In triangle ABC, B is the right angle, so AC is the longest side.', false],
  ['The transformation B maps it back.', false],
  ['There is no optional step.', false],
]) eq(`${names ? 'names an option' : 'names none'}: ${text}`, namesAnOption(text), names);

// ------------------------------------------------------------------ the text kept
eq('line breaks written as \\n become real', cleanSteps('$3x = 15$\\nSo $x = 5$.'), { steps: '$3x = 15$\nSo $x = 5$.' });
eq('a LaTeX \\neq is left alone', cleanSteps('$x \\neq 0$\\nSo $x = 5$.'), { steps: '$x \\neq 0$\nSo $x = 5$.' });
eq('Hindi and Tamil digits become plain', cleanSteps('२९ अभाज्य है। ௨௯'), { steps: '29 अभाज्य है। 29' });
eq('blank lines are squeezed and the ends trimmed', cleanSteps('  Step 1\n\n\n\nStep 2  \n'), { steps: 'Step 1\n\nStep 2' });
eq('a "Solution:" label is dropped', cleanSteps('Solution: So $x = 5$.'), { steps: 'So $x = 5$.' });
eq('an empty one is not kept', cleanSteps('   '), { why: 'empty' });
eq('nothing at all is not kept', cleanSteps(undefined), { why: 'empty' });
eq('one longer than the editor takes is not kept', cleanSteps('x'.repeat(MAX_SOLUTION + 1)), { why: 'too_long' });
eq('one as long as the editor takes is kept', 'steps' in cleanSteps('x'.repeat(MAX_SOLUTION)), true);
eq('one naming an option is not kept', cleanSteps('So the answer is (b).'), { why: 'names_option' });
eq('a NUL character is dropped (Postgres cannot store it)', cleanSteps('So\u0000 $x = 5$.'), { steps: 'So $x = 5$.' });

// ------------------------------------------------------------------ reading a reply
{
  const qs = [q('a', 1), q('b', 2), q('c', 0), q('d', 3)];
  const reply = JSON.stringify({
    solutions: [
      { id: 'q1', figure: false, steps: '$3x + 5 = 20$\n$3x = 15$\nSo $x = 5$.', answer: 'B' },
      { id: 'q2', figure: false, steps: 'Working', answer: 'A' },
      { id: 'q3', figure: true, steps: '', answer: '' },
    ],
  });
  const got = readSolutions(reply, qs);
  eq('a solution reaching the marked answer is kept', got.get('a'), { kind: 'written', steps: '$3x + 5 = 20$\n$3x = 15$\nSo $x = 5$.' });
  eq('one reaching another answer is not, and says which', got.get('b'), { kind: 'different', answer: 0 });
  eq('one needing its figure is not', got.get('c'), { kind: 'figure' });
  eq('one the reply left out is not', got.get('d'), { kind: 'unusable', why: 'no_reply' });
}
{
  const qs = [q('a', 1), q('b', 2)];
  const got = readSolutions('```json\n{"solutions":[{"id":"q2","steps":"So $\\frac{3}{4}$ of it.","answer":"(c)"},{"id":"q1","steps":"So the answer is (b).","answer":"b"}]}\n```', qs);
  eq('a reply in a code fence, with LaTeX in one backslash, is read', got.get('b'), { kind: 'written', steps: 'So $\\frac{3}{4}$ of it.' });
  eq('the right answer named by its letter in the working is not kept', got.get('a'), { kind: 'unusable', why: 'names_option' });
}
eq('an answer that reaches no option is not kept', readSolutions('{"solutions":[{"id":"q1","steps":"So 7.","answer":""}]}', [q('a', 1)]).get('a'), { kind: 'different', answer: null });
eq('a reply that is no JSON keeps nothing', [...readSolutions('Sorry, I cannot help.', [q('a', 1)]).values()], [{ kind: 'unusable', why: 'no_reply' }]);
eq('one question answered with a bare object is read', readSolutions('{"steps":"So $x = 5$.","answer":"B"}', [q('a', 1)]).get('a'), { kind: 'written', steps: 'So $x = 5$.' });
eq('a bare list is read', readSolutions('[{"id":"q1","steps":"So $x = 5$.","answer":"B"}]', [q('a', 1)]).get('a').kind, 'written');
eq('an answer for a question not asked is ignored', [...readSolutions('{"solutions":[{"id":"q9","steps":"x","answer":"B"}]}', [q('a', 1)]).values()][0], { kind: 'unusable', why: 'no_reply' });
eq('the first answer for a question counts', readSolutions('{"solutions":[{"id":"q1","steps":"So 5.","answer":"B"},{"id":"q1","steps":"So 3.","answer":"A"}]}', [q('a', 1)]).get('a'), { kind: 'written', steps: 'So 5.' });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
