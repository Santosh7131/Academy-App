// Questions with five or six options: the tutor's two editors show every option and can add one (up to six) or take it off again (down to
// four), the student's test gives each option its letter and sends the pick on the fifth, and the letters have no limit of four. The
// screens are the real ones, against a stub server that remembers what it was sent.
//   flutter test test/more_options_test.dart
import 'dart:convert';

import 'package:tuition_app/core/api.dart';
import 'package:tuition_app/core/options.dart';
import 'package:tuition_app/core/session.dart';
import 'package:tuition_app/features/student/test_screen.dart';
import 'package:tuition_app/features/teacher/papers_screens.dart' show DraftEditor;
import 'package:tuition_app/features/teacher/questions_screens.dart' show QuestionEditor;
import 'package:tuition_app/theme.dart';
import 'package:tuition_app/ui/icons.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

http.Response _ok(Object body, [int status = 200]) => http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json'});

String _iso(Duration from) => DateTime.now().toUtc().add(from).toIso8601String();

/// The server's side: a saved question of five options, a test of a question of five and one of six, and the last body sent on each call.
class _Server {
  final bodies = <String, Map<String, dynamic>>{};
  final chosen = <String, int?>{};
  List<String> storedOptions = const ['one', 'two', 'three', 'four', 'five'];
  int storedCorrect = 4;

  Future<http.Response> handle(http.Request r) async {
    final call = '${r.method} ${r.url.path}';
    if (r.body.isNotEmpty) bodies[call] = jsonDecode(r.body) as Map<String, dynamic>;
    switch (call) {
      case 'GET /teacher/questions/q-1':
        return _ok({
          'question': {
            'id': 'q-1', 'text': 'Which key is right?', 'options': storedOptions, 'correct_option': storedCorrect, 'solution': null, 'marks': 1,
            'course_id': null, 'class_level': 10, 'subject_id': 'sub-Maths', 'chapter_id': null, 'image_key': null, 'image_url': null, 'used_in': 0,
            'difficulty': 'medium', 'difficulty_by': null,
          },
        });
      case 'PATCH /teacher/questions/q-1':
        return _ok({'id': 'q-1', 'regraded': 0});
      case 'GET /teacher/subjects':
        return _ok({
          'subjects': [
            {'id': 'sub-Maths', 'name': 'Maths', 'is_default': true},
          ],
        });
      case 'GET /teacher/chapters':
        return _ok({'chapters': <Object?>[]});
      case 'POST /student/tests/t1/start':
        return _ok({
          'attempt': {'id': 'a1', 'server_now': _iso(Duration.zero), 'deadline_at': _iso(const Duration(minutes: 14))},
          'questions': [
            {'id': 'q1', 'n': 1, 'text': 'Which key is right?', 'image_url': null, 'options': ['one', 'two', 'three', 'four', 'five'], 'chosen': chosen['q1'], 'flagged': false},
            {'id': 'q2', 'n': 2, 'text': 'Which is the last?', 'image_url': null, 'options': ['a1', 'b1', 'c1', 'd1', 'e1', 'f1'], 'chosen': chosen['q2'], 'flagged': false},
          ],
        });
      case 'PUT /student/attempts/a1/answers':
        for (final a in (jsonDecode(r.body)['answers'] as List)) {
          chosen[a['question_id'] as String] = a['choice'] as int?;
        }
        return _ok({});
    }
    return _ok({'error': {'code': 'not_found', 'message': 'No stub for $call'}}, 404);
  }
}

late _Server _s;

void _phone(WidgetTester t, {double width = 411, double height = 2400}) {
  t.view.physicalSize = Size(width * 2, height * 2);
  t.view.devicePixelRatio = 2;
  addTearDown(t.view.reset);
}

Future<void> _pump(WidgetTester t, [int ms = 600]) async {
  for (var left = ms; left > 0; left -= 50) {
    await t.pump(const Duration(milliseconds: 50));
  }
}

Future<void> _tap(WidgetTester t, Finder f) async {
  await t.ensureVisible(f);
  await t.tap(f);
  await _pump(t, 400);
}

/// What a screen opened with a push gave back.
class _Opened {
  Object? result;
  bool closed = false;
}

Future<_Opened> _push(WidgetTester t, Widget screen) async {
  _phone(t);
  final o = _Opened();
  await t.pumpWidget(MaterialApp(
    theme: buildTheme(Brightness.light),
    home: Builder(
      builder: (context) => Scaffold(
        body: Center(
          child: TextButton(
            onPressed: () async {
              o.result = await Navigator.of(context).push<Object>(MaterialPageRoute(builder: (_) => screen));
              o.closed = true;
            },
            child: const Text('open'),
          ),
        ),
      ),
    ),
  ));
  await t.tap(find.text('open'));
  await _pump(t, 800);
  return o;
}

Future<void> _openQuestionEditor(WidgetTester t) async {
  _phone(t);
  final router = GoRouter(routes: [
    GoRoute(path: '/', builder: (c, _) => Scaffold(body: Center(child: TextButton(onPressed: () => c.push<bool>('/edit'), child: const Text('open editor'))))),
    GoRoute(path: '/edit', builder: (_, _) => const QuestionEditor(id: 'q-1')),
  ]);
  await t.pumpWidget(MaterialApp.router(theme: buildTheme(Brightness.light), routerConfig: router));
  await _pump(t, 200);
  await _tap(t, find.text('open editor'));
  await _pump(t, 800);
}

Map<String, dynamic> _draft(List<String> options, {int? correct}) =>
    {'id': 'd1', 'page_no': 3, 'number_label': '15', 'kind': 'mcq', 'text': 'Assertion (A): a zygote with two X chromosomes develops into a boy.', 'options': options, 'correct_option': correct};

String _field(WidgetTester t, int i) => t.widget<EditableText>(find.byType(EditableText).at(i)).controller.text;

const _five = ['Both true, R explains A', 'Both true, R does not explain A', 'A true, R false', 'A false, R true', 'Both false'];

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

  setUp(() => _s = _Server());

  group('the letters and the limits', () {
    test('an option has a letter up to F', () {
      expect([for (var i = 0; i < 6; i++) optionLetter(i)], ['A', 'B', 'C', 'D', 'E', 'F']);
    });
    test('past F it is a number, never a crash', () {
      expect(optionLetter(6), '7');
      expect(optionLetter(-1), '0');
    });
    test('the counts are said in words', () {
      expect([for (var n = 4; n <= 6; n++) optionCountWord(n)], ['four', 'five', 'six']);
      expect(optionCountWord(9), '9');
    });
    test('four to six, the same as the server', () {
      expect([minOptions, maxOptions], [4, 6]);
    });
  });

  group('the editor for what AI read from a paper', () {
    testWidgets('a question of five opens with five options, and offers a sixth', (t) async {
      await _push(t, DraftEditor(draft: _draft(_five, correct: 3)));
      expect([for (var i = 1; i <= 5; i++) _field(t, i)], _five);
      expect(find.byType(EditableText), findsNWidgets(6), reason: 'the question and five options');
      expect(find.text('E'), findsOneWidget, reason: 'option E has its circle');
      expect(find.text('Add option F'), findsOneWidget);
      expect(find.text('Add option E'), findsNothing);
      expect(find.byIcon(Ph.x), findsOneWidget, reason: 'the last one can be taken off');
    });

    testWidgets('a question of four offers a fifth, and no option can be taken off', (t) async {
      await _push(t, DraftEditor(draft: _draft(['a', 'b', 'c', 'd'])));
      expect(find.byType(EditableText), findsNWidgets(5));
      expect(find.text('Add option E'), findsOneWidget);
      expect(find.byIcon(Ph.x), findsNothing, reason: 'four is the fewest');
    });

    testWidgets('a fifth is added, must be filled in, and is given back with the right answer on it', (t) async {
      final o = await _push(t, DraftEditor(draft: _draft(['a', 'b', 'c', 'd'])));
      await _tap(t, find.text('Add option E'));
      expect(find.byType(EditableText), findsNWidgets(6));
      expect(find.text('Option E'), findsOneWidget, reason: 'the new box says which one it is');
      expect(find.text('Add option F'), findsOneWidget);
      expect(find.text('Fill in all five options.'), findsOneWidget, reason: 'the new one is empty');
      await t.enterText(find.byType(EditableText).at(5), 'e is right');
      await _pump(t, 100);
      expect(find.text('Fill in all five options.'), findsNothing);
      await _tap(t, find.text('E'));
      await _tap(t, find.text('Save question'));
      final r = o.result as Map<String, dynamic>;
      expect(r['options'], ['a', 'b', 'c', 'd', 'e is right']);
      expect(r['correct_option'], 4);
      expect(r['kind'], 'mcq');
    });

    testWidgets('a sixth can be added too, and then there is no more to add', (t) async {
      final o = await _push(t, DraftEditor(draft: _draft(_five)));
      await _tap(t, find.text('Add option F'));
      expect(find.byType(EditableText), findsNWidgets(7));
      expect(find.textContaining('Add option'), findsNothing, reason: 'six is the most');
      await t.enterText(find.byType(EditableText).at(6), 'sixth');
      await _pump(t, 100);
      await _tap(t, find.text('Save question'));
      expect((o.result as Map)['options'], [..._five, 'sixth']);
    });

    testWidgets('taking the fifth off clears the mark on it, and four are given back', (t) async {
      final o = await _push(t, DraftEditor(draft: _draft(_five, correct: 4)));
      await _tap(t, find.byIcon(Ph.x));
      expect(find.byType(EditableText), findsNWidgets(5));
      expect(find.text('Add option E'), findsOneWidget);
      await _tap(t, find.text('Save question'));
      final r = o.result as Map<String, dynamic>;
      expect(r['options'], _five.sublist(0, 4));
      expect(r.containsKey('correct_option'), isTrue, reason: 'the mark changed');
      expect(r['correct_option'], isNull, reason: 'the fifth was the right one, and it is gone');
    });

    testWidgets('taking the fifth off keeps a mark on another option', (t) async {
      final o = await _push(t, DraftEditor(draft: _draft(_five, correct: 1)));
      await _tap(t, find.byIcon(Ph.x));
      await _tap(t, find.text('Save question'));
      final r = o.result as Map<String, dynamic>;
      expect(r['options'], _five.sublist(0, 4));
      expect(r.containsKey('correct_option'), isFalse, reason: 'the mark did not change');
    });

    testWidgets('saving a question of five without touching it gives back all five', (t) async {
      final o = await _push(t, DraftEditor(draft: _draft(_five, correct: 4)));
      await _tap(t, find.text('Save question'));
      expect((o.result as Map)['options'], _five);
    });

    testWidgets('an option taken off and added again starts empty', (t) async {
      await _push(t, DraftEditor(draft: _draft(_five)));
      await _tap(t, find.byIcon(Ph.x));
      await _tap(t, find.text('Add option E'));
      expect(_field(t, 5), '', reason: 'what was in the old fifth is gone');
    });
  });

  group('the editor for a question in the bank', () {
    testWidgets('a saved question of five opens with its five options and the fifth marked', (t) async {
      await _openQuestionEditor(t);
      expect(find.text('Option E'), findsOneWidget);
      expect(find.text('Add option F'), findsOneWidget);
      expect(find.byIcon(Ph.check), findsOneWidget, reason: 'the fifth is the right one');
    });

    testWidgets('saved without a change, it still has five options and the same right answer', (t) async {
      await _openQuestionEditor(t);
      await _tap(t, find.text('Save question'));
      final b = _s.bodies['PATCH /teacher/questions/q-1']!;
      expect(b['options'], _s.storedOptions);
      expect(b['correct_option'], 4);
    });

    testWidgets('a sixth is added and saved', (t) async {
      await _openQuestionEditor(t);
      await _tap(t, find.text('Add option F'));
      await t.enterText(find.byType(EditableText).at(6), 'six');
      await _pump(t, 100);
      await _tap(t, find.text('Save question'));
      final b = _s.bodies['PATCH /teacher/questions/q-1']!;
      expect((b['options'] as List).length, 6);
      expect((b['options'] as List).last, 'six');
    });

    testWidgets('a question of five brought down to four is saved with four, and says which is right', (t) async {
      _s.storedCorrect = 4;
      await _openQuestionEditor(t);
      await _tap(t, find.byIcon(Ph.x));
      expect(find.text('Tap the circle next to the right answer.'), findsOneWidget, reason: 'the fifth was the right one');
      await _tap(t, find.text('B'));
      await _tap(t, find.text('Save question'));
      final b = _s.bodies['PATCH /teacher/questions/q-1']!;
      expect(b['options'], _s.storedOptions.sublist(0, 4));
      expect(b['correct_option'], 1);
    });

    testWidgets('a saved question of four has no fifth until one is added', (t) async {
      _s.storedOptions = const ['a', 'b', 'c', 'd'];
      _s.storedCorrect = 0;
      await _openQuestionEditor(t);
      expect(find.text('Option E'), findsNothing);
      expect(find.text('Add option E'), findsOneWidget);
    });
  });

  group('the student\'s test', () {
    testWidgets('a question of five and one of six show a letter on every option', (t) async {
      _phone(t, height: 3000);
      final router = GoRouter(routes: [GoRoute(path: '/', builder: (_, _) => const TestScreen(testId: 't1'))]);
      await t.pumpWidget(MaterialApp.router(theme: buildTheme(Brightness.light), routerConfig: router));
      await _pump(t, 1500);
      expect(find.text('five'), findsOneWidget);
      for (final letter in ['A', 'B', 'C', 'D', 'E']) {
        expect(find.text(letter), findsWidgets, reason: 'option $letter of the first question');
      }
      expect(find.bySemanticsLabel(RegExp('Option E: five')), findsOneWidget);
    });

    testWidgets('choosing the fifth sends 4, and the pick is shown as chosen', (t) async {
      final semantics = t.ensureSemantics();
      _phone(t, height: 3000);
      final router = GoRouter(routes: [GoRoute(path: '/', builder: (_, _) => const TestScreen(testId: 't1'))]);
      await t.pumpWidget(MaterialApp.router(theme: buildTheme(Brightness.light), routerConfig: router));
      await _pump(t, 1500);
      await t.tap(find.text('five'));
      await _pump(t, 1500);
      expect(_s.chosen['q1'], 4);
      expect(find.bySemanticsLabel(RegExp('Option E: five, chosen')), findsOneWidget);
      semantics.dispose();
    });
  });
}
