// Tables written in a question's text (lib/ui/math_text.dart): the reader copies a table printed with a question as rows of cells
// between | marks, in the shapes live questions have, and the app draws it as a table instead of showing the marks.
//   flutter test test/text_table_test.dart
import 'package:tuition_app/ui/math_text.dart';
import 'package:flutter/material.dart';
import 'package:flutter_math_fork/flutter_math.dart' show Math;
import 'package:flutter_test/flutter_test.dart';

/// The four shapes found in live questions (2026-11-15): with and without the outer marks, a line of dashes with colons, formulas in
/// the cells, and no blank line round the table.
const _withMarks = 'The following table shows the birth day of 30 students of class X:\n\n| Day | Number of students |\n|---|---|\n| Sunday | 3 |\n'
    '| Monday | 6 |\n| Saturday | 4 |\n\nFind the probability that a student was born on Saturday.';
const _noMarks = r'A dice is thrown $100$ times:' '\n\nOutcome | Frequency\n---|---\n1 | 10\n2 | 20\n\nFind the probability of outcome \$1\$';
const _colons = 'The distribution of IQ:\n| IQ | No. of pupils |\n| :--- | :--- |\n| 60-70 | 2 |\n| 70-80 | 3 |\nFind the probability.';
const _formulas = 'Scores:\n\n| Scores | Number of students |\n|---|---|\n| \$400-450\$ | 15 |\n| \$|x| < 2\$ | 30 |';

Future<void> _show(WidgetTester t, String text, {double width = 400, int? maxLines}) async {
  t.view.physicalSize = Size(width, 900);
  t.view.devicePixelRatio = 1;
  addTearDown(t.view.reset);
  await t.pumpWidget(MaterialApp(home: Scaffold(body: SingleChildScrollView(child: MathText(text, style: const TextStyle(fontSize: 14), maxLines: maxLines)))));
}

void main() {
  group('splitTables', () {
    test('a table with marks at both ends is cut out of the text round it', () {
      final parts = splitTables(_withMarks);
      expect(parts, hasLength(3));
      expect(parts[0], 'The following table shows the birth day of 30 students of class X:');
      expect(parts[1], [
        ['Day', 'Number of students'],
        ['Sunday', '3'],
        ['Monday', '6'],
        ['Saturday', '4'],
      ]);
      expect(parts[2], 'Find the probability that a student was born on Saturday.');
    });

    test('a table without the outer marks, and one with colons in its line of dashes, are tables too', () {
      expect(splitTables(_noMarks)[1], [
        ['Outcome', 'Frequency'],
        ['1', '10'],
        ['2', '20'],
      ]);
      final colons = splitTables(_colons);
      expect(colons, hasLength(3));
      expect(colons[1], [
        ['IQ', 'No. of pupils'],
        ['60-70', '2'],
        ['70-80', '3'],
      ]);
      expect(colons[2], 'Find the probability.');
    });

    test('a | inside a formula stays in its cell', () {
      expect((splitTables(_formulas)[1] as List)[2], [r'$|x| < 2$', '30']);
    });

    test('a row the reader gave a cell short is filled out so the columns line up', () {
      expect(splitTables('| a | b | c |\n|---|---|---|\n| 1 | 2 |').single, [
        ['a', 'b', 'c'],
        ['1', '2', ''],
      ]);
    });

    test("a preview of a case-study question shows the question first, then its group's passage", () {
      const passage = "Johan and Jayant are very close friends. They decided to go to Ranikhet with their families in separate cars. Johan's car "
          'travels at a speed of \$x\$ km/hr while Jayant\'s car travels 5 km/hr faster than Johan\'s car.';
      expect(previewOf('$passage\n\nThe speed of Johan\'s car is (in km/hr)'), startsWith("The speed of Johan's car is (in km/hr) · Johan and Jayant"));
      expect(previewOf('CASE STUDY 1: TEST SCORES\n\n$passage\n\nHow fast is Jayant?'), "How fast is Jayant? · CASE STUDY 1: TEST SCORES $passage",
          reason: 'as the reader writes it, with the case study heading first');
      expect(previewOf('A short line.\n\nThe question'), 'A short line.\n\nThe question', reason: 'a short first paragraph is no passage');
      expect(previewOf('One line\nand the next'), 'One line\nand the next');
      expect(previewOf(_withMarks), startsWith('The following table shows'), reason: 'a table question keeps its order, its table run into the line');
    });

    test('a case-study question comes apart into its passage and its question, for a printed test to set the passage once', () {
      const passage = "Johan and Jayant are very close friends. They decided to go to Ranikhet with their families in separate cars. Johan's car "
          'travels at a speed of \$x\$ km/hr while Jayant\'s car travels 5 km/hr faster than Johan\'s car.';
      final p = passageOf('CASE STUDY 1: TEST SCORES\n\n$passage\n\nHow fast is Jayant?');
      expect(p?.passage, 'CASE STUDY 1: TEST SCORES\n\n$passage');
      expect(p?.question, 'How fast is Jayant?');
      expect(passageOf('A short line.\n\nThe question'), isNull, reason: 'a short first paragraph is no passage');
      expect(passageOf('One line\nand the next'), isNull);
      expect(passageOf(_withMarks), isNull, reason: 'nor is a table');
    });

    test('text with no table comes back as it was, | marks and all', () {
      expect(splitTables('Find |x| if x = -3'), ['Find |x| if x = -3']);
      expect(splitTables(r'If $|x - 2| = 5$, then x is'), [r'If $|x - 2| = 5$, then x is']);
      expect(splitTables('One | two\nthree'), ['One | two\nthree'], reason: 'no line of dashes, no table');
      expect(splitTables('Line one\n\nLine two'), ['Line one\n\nLine two']);
    });
  });

  group('MathText with a table', () {
    testWidgets('draws the table with its heading and cells, and the text round it', (t) async {
      await _show(t, _withMarks);
      expect(find.byType(Table), findsOneWidget);
      final table = t.widget<Table>(find.byType(Table));
      expect(table.children, hasLength(4));
      expect(table.children.first.children, hasLength(2));
      expect(find.textContaining('Number of students'), findsOneWidget);
      expect(find.textContaining('Saturday'), findsNWidgets(2), reason: 'in the table and in the question under it');
      expect(find.textContaining('|'), findsNothing, reason: 'no | marks left on the screen');
      expect(t.takeException(), isNull);
    });

    testWidgets('a table wider than a narrow phone slides sideways instead of running off the screen', (t) async {
      await _show(t, 'Consider the data:\n\n| Class | 65–85 | 85–105 | 105–125 | 125–145 | 145–165 | 165–185 | 185–205 |\n'
          '|---|---|---|---|---|---|---|---|\n| Frequency | 4 | 5 | 13 | 20 | 14 | 7 | 4 |\n\nThe difference is', width: 320);
      expect(find.byType(Table), findsOneWidget);
      expect(t.takeException(), isNull, reason: 'no overflow');
      expect(find.ancestor(of: find.byType(Table), matching: find.byWidgetPredicate((w) => w is SingleChildScrollView && w.scrollDirection == Axis.horizontal)), findsOneWidget);
    });

    testWidgets('formulas in cells are set as formulas', (t) async {
      await _show(t, _formulas);
      expect(find.byType(Table), findsOneWidget);
      expect(find.textContaining(r'$'), findsNothing, reason: 'no formula left as its source');
      expect(t.takeException(), isNull);
    });

    testWidgets('a preview cut to a few lines runs the table into the line', (t) async {
      await _show(t, _withMarks, maxLines: 2);
      expect(find.byType(Table), findsNothing);
      expect(find.textContaining('Day, Number of students; Sunday, 3; Monday, 6'), findsOneWidget);
    });

    testWidgets('a grid printed without headings is drawn without a blank shaded row on top', (t) async {
      // As the reader typed Q12 of a real book page (2026-11-15): coin tosses noted down as rows of numbers, with no heading.
      const grid = 'Each time the number of heads was noted down as follows:\n\n| | | | | | |\n|---|---|---|---|---|---|\n| 0 | 1 | 2 | 2 | 1 | 2 |\n'
          '| 3 | 1 | 3 | 0 | 1 | 3 |\n\nFind the probability of getting no head.';
      await _show(t, grid);
      final table = t.widget<Table>(find.byType(Table));
      expect(table.children, hasLength(2), reason: 'the two rows of numbers, and no blank heading row');
      expect(table.children.first.decoration, isNull, reason: 'no row is shaded as a heading');
      expect(t.takeException(), isNull);
      await _show(t, grid, maxLines: 2);
      expect(find.textContaining('0, 1, 2, 2, 1, 2; 3, 1, 3'), findsOneWidget, reason: 'the preview line starts with the numbers, not with blank cells');
    });

    testWidgets('text with no table is one piece of text, as before', (t) async {
      await _show(t, r'What is $\frac{2}{5} + \frac{1}{5}$?');
      expect(find.byType(Table), findsNothing);
      expect(find.byType(Column), findsNothing);
    });

    testWidgets(r'maths written between $$ and $$ is drawn as maths, with no dollar signs left showing', (t) async {
      await _show(t, r'Solve: $$x^2 - 5x + 6 = 0$$ and give both roots, or $x = 2$.');
      final text = t.widget<RichText>(find.byType(RichText).first).text.toPlainText();
      expect(text.contains(r'$'), isFalse, reason: text);
      expect(find.byType(Math), findsNWidgets(2));
    });
  });
}
