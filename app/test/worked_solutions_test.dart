// Worked solutions written by AI, as a tutor asks for them on a test's page (lib/features/teacher/worked_solutions.dart): how many
// questions have one, the price before anything is written, the requests a few questions at a time, and what the tutor is told
// after: how many were written, and which questions AI could not match, by their number and letters, so the answers can be checked.
//   flutter test test/worked_solutions_test.dart
import 'dart:convert';

import 'package:tuition_app/core/api.dart';
import 'package:tuition_app/core/credit.dart';
import 'package:tuition_app/core/session.dart';
import 'package:tuition_app/features/teacher/worked_solutions.dart';
import 'package:tuition_app/theme.dart';
import 'package:tuition_app/ui/kit.dart' show SecondaryButton;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The server's side: the price it tells, what it was sent, and what it says of each question.
class _Server {
  int? solutionPaise = 40;
  final sent = <List<String>>[];

  /// What comes of each question id; anything not named is written.
  final outcomes = <String, Map<String, Object?>>{};

  /// The request (from 1) answered with 402, as when the credit runs out midway.
  int? noCreditOn;

  http.Response _ok(Object body, [int status = 200]) => http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json'});

  Future<http.Response> handle(http.Request r) async {
    if (r.method == 'GET' && r.url.path == '/teacher/credit') {
      return _ok({
        'credit': {'balance_paise': 47660, 'free_paise': 47660},
        'prices': {'page_paise': 240, 'question_paise': 60, 'solution_paise': ?solutionPaise},
      });
    }
    if (r.method == 'POST' && r.url.path == '/teacher/tests/t-1/solutions') {
      final ids = ((jsonDecode(r.body) as Map)['question_ids'] as List).cast<String>();
      sent.add(ids);
      if (sent.length == noCreditOn) {
        return _ok({'error': {'code': 'no_credit', 'message': 'This needs ₹1.60 of AI and you have ₹0.20 left. Move to Basic or Pro for AI every month.'}}, 402);
      }
      return _ok({
        'solutions': [for (final id in ids) {'id': id, ...outcomes[id] ?? {'outcome': 'written', 'solution': 'So 5.'}}],
        'written': ids.where((id) => outcomes[id] == null).length,
        'credit_paise': 47000,
      });
    }
    return _ok({'error': {'code': 'not_found', 'message': 'No stub for ${r.method} ${r.url.path}'}}, 404);
  }
}

late _Server _s;

/// Six questions; [have] of them (the first ones) have a solution already.
List<Map<String, dynamic>> _questions({int have = 0, int count = 6}) => [
      for (var i = 0; i < count; i++)
        {'id': 'q${i + 1}', 'correct_option': i % 4, if (i < have) 'has_solution': true},
    ];

Future<void> _pump(WidgetTester t, [int ms = 800]) async {
  for (var left = ms; left > 0; left -= 50) {
    await t.pump(const Duration(milliseconds: 50));
  }
}

int _written = 0;

Future<void> _show(WidgetTester t, List<Map<String, dynamic>> questions, {Future<bool> Function()? before}) async {
  setResolvedDark(false);
  t.view.physicalSize = const Size(411 * 2.625, 1600 * 2.625);
  t.view.devicePixelRatio = 2.625;
  addTearDown(t.view.reset);
  _written = 0;
  await t.pumpWidget(MaterialApp(
    theme: buildTheme(Brightness.light),
    home: Scaffold(
      body: ListView(padding: const EdgeInsets.all(16), children: [
        WorkedSolutions(testId: 't-1', questions: questions, beforeWriting: before, onWritten: () => _written++),
      ]),
    ),
  ));
  await _pump(t);
}

Future<void> _writeAll(WidgetTester t, String button, {String confirm = 'Write them'}) async {
  await t.tap(find.text(button));
  await _pump(t);
  await t.tap(find.text(confirm));
  await _pump(t, 1500);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    SharedPreferences.setMockInitialValues({});
    await session.loadPrefs();
    http.runWithClient(() => api.token = 'test', () => MockClient((r) => _s.handle(r)));
    session.user = {'id': 'u-1', 'role': 'teacher', 'username': 'priya', 'display_name': 'Priya', 'class_level': null};
    session.tuitions = [
      {'id': 't-1', 'name': 'Priya Maths Classes', 'role': 'owner', 'status': 'active'},
    ];
    session.tuitionId = 't-1';
    session.tuitionName = 'Priya Maths Classes';
  });

  setUp(() {
    _s = _Server();
    credit.set(null);
  });

  group('how many have one', () {
    testWidgets('none yet: all of them can be written, at the price of each', (t) async {
      await _show(t, _questions());
      expect(find.text('0 of 6 questions have a worked solution'), findsOneWidget);
      expect(find.text('Students see it after they hand the test in.'), findsOneWidget);
      expect(find.text('Write all 6 with AI · ₹2.40'), findsOneWidget);
    });

    testWidgets('some: the others', (t) async {
      await _show(t, _questions(have: 2));
      expect(find.text('2 of 6 questions have a worked solution'), findsOneWidget);
      expect(find.text('Write the other 4 with AI · ₹1.60'), findsOneWidget);
    });

    testWidgets('all but one: the last one', (t) async {
      await _show(t, _questions(have: 5));
      expect(find.text('5 of 6 questions have a worked solution'), findsOneWidget);
      expect(find.text('Write the last one with AI · ₹0.40'), findsOneWidget);
    });

    testWidgets('one of one: "has"', (t) async {
      await _show(t, [
        {'id': 'q1', 'correct_option': 0, 'has_solution': true},
        {'id': 'q2', 'correct_option': 1},
      ]);
      expect(find.text('1 of 2 questions has a worked solution'), findsOneWidget);
    });

    testWidgets('a solution sent as text counts as one', (t) async {
      await _show(t, [
        {'id': 'q1', 'correct_option': 0, 'solution': 'So 5.'},
        {'id': 'q2', 'correct_option': 1, 'solution': '   '},
      ]);
      expect(find.text('1 of 2 questions has a worked solution'), findsOneWidget);
    });

    testWidgets('every question: nothing to write', (t) async {
      await _show(t, _questions(have: 6));
      expect(find.text('Every question has a worked solution'), findsOneWidget);
      expect(find.byType(SecondaryButton), findsNothing);
    });

    testWidgets('a server before worked solutions tells no price, and none is shown', (t) async {
      _s.solutionPaise = null;
      await _show(t, _questions());
      expect(find.text('Write all 6 with AI'), findsOneWidget);
    });
  });

  group('writing them', () {
    testWidgets('it asks first, with the price of each and the most it can cost', (t) async {
      await _show(t, _questions());
      await t.tap(find.text('Write all 6 with AI · ₹2.40'));
      await _pump(t);
      expect(find.text('Write 6 worked solutions with AI?'), findsOneWidget);
      expect(
        find.text('AI works each question out on its own and keeps a solution only when it reaches the answer you marked. '
            'Each one kept costs ₹0.40 of AI credit, up to ₹2.40 in all, and the ones it cannot match cost nothing.'),
        findsOneWidget,
      );
      await t.tap(find.text('Cancel'));
      await _pump(t);
      expect(_s.sent, isEmpty, reason: 'nothing is written until the tutor says so');
    });

    testWidgets('four questions to a request, and it says what was written', (t) async {
      await _show(t, _questions(have: 0));
      await _writeAll(t, 'Write all 6 with AI · ₹2.40');
      expect(_s.sent, [
        ['q1', 'q2', 'q3', 'q4'],
        ['q5', 'q6'],
      ]);
      expect(find.text('Wrote 6 worked solutions.'), findsOneWidget);
      expect(find.text('Every question has a worked solution'), findsOneWidget, reason: 'the count follows what was written');
      expect(_written, 1, reason: 'the page loads its questions again');
    });

    testWidgets('only the questions without one are sent', (t) async {
      await _show(t, _questions(have: 4));
      await _writeAll(t, 'Write the other 2 with AI · ₹0.80');
      expect(_s.sent, [
        ['q5', 'q6'],
      ]);
    });

    testWidgets('the ones AI could not match are named by number, with its letter and the one marked', (t) async {
      _s.outcomes['q2'] = {'outcome': 'different', 'ai_answer': 2};
      _s.outcomes['q5'] = {'outcome': 'different', 'ai_answer': null};
      _s.outcomes['q3'] = {'outcome': 'figure'};
      _s.outcomes['q6'] = {'outcome': 'figure'};
      _s.outcomes['q4'] = {'outcome': 'unusable', 'why': 'names_option'};
      await _show(t, _questions());
      await _writeAll(t, 'Write all 6 with AI · ₹2.40');
      expect(
        find.text('Wrote 1 worked solution.\n\n'
            'AI reached a different answer for question 2 (it reached C; B is marked), question 5 (it matched no option; A is marked). '
            'Check those answers: once the answer marked is the one AI reaches, it writes the solution.\n\n'
            'Questions 3 and 6 need their figures, which AI cannot see.\n\n'
            'AI could not write a usable one for question 4. You can try again.'),
        findsOneWidget,
      );
      expect(find.text('1 of 6 questions has a worked solution'), findsOneWidget);
      expect(find.text('Write the other 5 with AI · ₹2.00'), findsOneWidget, reason: 'the rest can be tried again');
    });

    testWidgets('one a tutor wrote meanwhile counts as having one', (t) async {
      _s.outcomes['q1'] = {'outcome': 'has_solution'};
      await _show(t, _questions(count: 2));
      await _writeAll(t, 'Write both with AI · ₹0.80');
      expect(find.text('Wrote 1 worked solution.'), findsOneWidget);
      expect(find.text('Every question has a worked solution'), findsOneWidget);
    });

    testWidgets('when the credit runs out it stops, keeping what was written, and says why', (t) async {
      _s.noCreditOn = 2;
      await _show(t, _questions());
      await _writeAll(t, 'Write all 6 with AI · ₹2.40');
      expect(_s.sent.length, 2);
      expect(find.text('Wrote 4 worked solutions.\n\nStopped: This needs ₹1.60 of AI and you have ₹0.20 left. Move to Basic or Pro for AI every month.'), findsOneWidget);
      expect(find.text('4 of 6 questions have a worked solution'), findsOneWidget);
    });

    testWidgets('a single question is written with "Write it"', (t) async {
      await _show(t, _questions(count: 1));
      await _writeAll(t, 'Write it with AI · ₹0.40', confirm: 'Write it');
      expect(_s.sent, [
        ['q1'],
      ]);
      expect(find.text('Wrote 1 worked solution.'), findsOneWidget);
    });

    testWidgets('nothing is written when the page could not get ready (a draft that could not be saved)', (t) async {
      await _show(t, _questions(), before: () async => false);
      await _writeAll(t, 'Write all 6 with AI · ₹2.40');
      expect(_s.sent, isEmpty);
    });
  });
}
