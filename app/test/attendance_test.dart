// Attendance, as a tutor takes it (lib/features/teacher/attendance_screens.dart): a class's register for a day with everyone
// here until the tutor taps the ones who are away, what is sent when it is saved, a register already taken read back and
// changed, other days, a student who left the class, taking a register away, the month's list, the button on a class's
// page, and the message a parent is sent.
//   flutter test test/attendance_test.dart
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:tuition_app/core/api.dart';
import 'package:tuition_app/core/format.dart' as f;
import 'package:tuition_app/core/session.dart';
import 'package:tuition_app/features/teacher/attendance_screens.dart';
import 'package:tuition_app/theme.dart';

const _today = '2026-11-23';

Map<String, dynamic> _student(String id, String name, {bool? present, bool inClass = true}) =>
    {'id': id, 'display_name': name, 'username': name.toLowerCase(), 'present': present, 'in_class': inClass};

/// The server's side: one class's registers by day, and what it was sent.
class _Server {
  /// Each day's register: null when not taken, else who took it.
  final taken = <String, Map<String, dynamic>?>{};

  /// Each day's marks: student id to here (true) or away (false).
  final marks = <String, Map<String, bool>>{};

  /// The class now; [left] were on a register and have left the class since.
  List<Map<String, dynamic>> students = [_student('s1', 'Asha'), _student('s2', 'Ravi'), _student('s3', 'Meena')];
  List<Map<String, dynamic>> left = [];

  final puts = <Map<String, dynamic>>[];
  final deletes = <String>[];
  final gets = <String>[];

  http.Response _ok(Object body, [int status = 200]) => http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json'});

  Future<http.Response> handle(http.Request r) async {
    final day = r.url.queryParameters['day'] ?? _today;
    if (r.method == 'GET' && r.url.path == '/teacher/attendance') {
      gets.add(r.url.query);
      final m = marks[day];
      return _ok({
        'day': day,
        'today': _today,
        'register': taken[day],
        'students': [
          for (final s in students) {...s, 'present': m?[s['id']]},
          if (m != null)
            for (final s in left) {...s, 'present': m[s['id']] ?? false, 'in_class': false},
        ],
      });
    }
    if (r.method == 'PUT' && r.url.path == '/teacher/attendance') {
      final b = Map<String, dynamic>.from(jsonDecode(r.body));
      puts.add(b);
      final d = '${b['day']}';
      final away = (b['absent'] as List).cast<String>();
      marks[d] = {for (final s in students) '${s['id']}': !away.contains(s['id'])};
      taken[d] = {'taken_at': '2026-11-23T03:35:00Z', 'taken_by': 'Priya'};
      return _ok({
        'day': d,
        'present': students.length - away.length,
        'absent': [for (final s in students) if (away.contains(s['id'])) {'id': s['id'], 'display_name': s['display_name']}],
      });
    }
    if (r.method == 'DELETE' && r.url.path == '/teacher/attendance') {
      deletes.add(day);
      taken.remove(day);
      marks.remove(day);
      return _ok({'ok': true});
    }
    if (r.method == 'GET' && r.url.path == '/teacher/attendance/month') {
      final month = r.url.queryParameters['month'] ?? '2026-11';
      return _ok({
        'month': month,
        'today': _today,
        'days': month == '2026-11'
            ? [
                {'day': '2026-11-23', 'present': 18, 'absent': 2},
                {'day': '2026-11-21', 'present': 20, 'absent': 0},
              ]
            : <Object>[],
      });
    }
    return _ok({'error': {'code': 'not_found', 'message': 'No stub for ${r.method} ${r.url.path}'}}, 404);
  }
}

late _Server _s;

Future<void> _pump(WidgetTester t, [int ms = 800]) async {
  for (var left = ms; left > 0; left -= 50) {
    await t.pump(const Duration(milliseconds: 50));
  }
}

const _group = ClassRef.group(9, 'sub-maths');

/// The register screen inside a router, with the month's list a push away.
Future<void> _show(WidgetTester t, {String? day, ClassRef ref = _group}) async {
  setResolvedDark(false);
  t.view.physicalSize = const Size(411 * 2.625, 1400 * 2.625);
  t.view.devicePixelRatio = 2.625;
  addTearDown(t.view.reset);
  final router = GoRouter(initialLocation: ref.link('9th Maths', day: day), routes: [
    GoRoute(
      path: '/t/attendance',
      builder: (_, s) => AttendanceScreen(ref: ref, name: s.uri.queryParameters['name'] ?? '', day: s.uri.queryParameters['day']),
    ),
    GoRoute(
      path: '/t/attendance/month',
      builder: (_, s) => AttendanceMonthScreen(ref: ref, name: s.uri.queryParameters['name'] ?? '', month: s.uri.queryParameters['month']),
    ),
  ]);
  await t.pumpWidget(MaterialApp.router(theme: buildTheme(Brightness.light), routerConfig: router));
  await _pump(t);
}

Future<void> _tap(WidgetTester t, Finder finder, [int ms = 800]) async {
  await t.ensureVisible(finder);
  await t.pump();
  await t.tap(finder);
  await _pump(t, ms);
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

  setUp(() => _s = _Server());

  group('taking a register', () {
    testWidgets('not taken yet: everyone is here until tapped', (t) async {
      await _show(t);
      expect(find.text('Not taken yet. Everyone is marked here; tap anyone who is away.'), findsOneWidget);
      expect(find.text('Here'), findsNWidgets(3));
      expect(find.text('Save · 3 here, 0 away'), findsOneWidget);
    });

    testWidgets('tapping a student marks them away, and back', (t) async {
      await _show(t);
      await _tap(t, find.text('Ravi'));
      expect(find.text('Away'), findsOneWidget);
      expect(find.text('Save · 2 here, 1 away'), findsOneWidget);
      await _tap(t, find.text('Ravi'));
      expect(find.text('Away'), findsNothing);
      expect(find.text('Save · 3 here, 0 away'), findsOneWidget);
    });

    testWidgets('saving sends the class, the day and the ones away, then offers to tell their parents', (t) async {
      await _show(t);
      await _tap(t, find.text('Ravi'));
      await _tap(t, find.text('Save · 2 here, 1 away'), 1500);
      expect(_s.puts, [
        {'class_level': 9, 'subject_id': 'sub-maths', 'day': _today, 'absent': ['s2']},
      ]);
      expect(find.text('TELL PARENTS'), findsOneWidget, reason: 'a section heading is in capitals');
      expect(find.text('Away today'), findsOneWidget, reason: "the server's today is the register's day");
      expect(find.text('Saved · 2 here, 1 away'), findsOneWidget);
      expect(find.textContaining('Taken by Priya at'), findsOneWidget);
    });

    testWidgets('a course sends its course id', (t) async {
      await _show(t, ref: const ClassRef.course('c-1'));
      await _tap(t, find.text('Save · 3 here, 0 away'), 1500);
      expect(_s.puts.single['course_id'], 'c-1');
      expect(_s.puts.single.containsKey('class_level'), isFalse);
      expect(find.text('Saved. Everyone was here.'), findsOneWidget);
    });

    testWidgets('nobody in the class: nothing to save', (t) async {
      _s.students = [];
      await _show(t);
      expect(find.text('Nobody is in this class yet. Invite students with its link, then take the register.'), findsOneWidget);
      expect(find.textContaining('Save'), findsNothing);
    });
  });

  group('a register already taken', () {
    setUp(() {
      _s.taken[_today] = {'taken_at': '2026-11-23T03:35:00Z', 'taken_by': 'Priya'};
      _s.marks[_today] = {'s1': true, 's2': false, 's3': true};
    });

    testWidgets('reads back as saved, and changes only once a mark is tapped', (t) async {
      await _show(t);
      expect(find.text('Saved · 2 here, 1 away'), findsOneWidget);
      expect(find.text('Away'), findsOneWidget);
      await _tap(t, find.text('Asha'));
      expect(find.text('Save · 1 here, 2 away'), findsOneWidget);
    });

    testWidgets('a student who left the class stays on it as marked, and cannot be changed', (t) async {
      _s.left = [_student('s4', 'Kiran')];
      _s.marks[_today] = {..._s.marks[_today]!, 's4': false};
      await _show(t);
      await t.ensureVisible(find.text('NO LONGER IN THIS CLASS'));
      expect(find.text('Kiran'), findsOneWidget);
      await _tap(t, find.text('Kiran'));
      expect(find.text('Saved · 2 here, 1 away'), findsOneWidget, reason: 'tapping someone who left changes nothing');
    });

    testWidgets('it can be taken away, after asking', (t) async {
      await _show(t);
      await _tap(t, find.text('Take this register away'));
      expect(find.text('Take this register away?'), findsOneWidget);
      await _tap(t, find.text('Take it away'), 1200);
      expect(_s.deletes, [_today]);
      expect(find.text('Not taken yet. Everyone is marked here; tap anyone who is away.'), findsOneWidget);
    });
  });

  group('other days', () {
    testWidgets('the day after today cannot be opened; the day before can', (t) async {
      await _show(t);
      await _tap(t, find.bySemanticsLabel('The day after'));
      expect(_s.gets.last.contains('day='), isFalse, reason: 'today is as far as it goes');
      await _tap(t, find.bySemanticsLabel('The day before'));
      expect(_s.gets.last, contains('day=2026-11-22'));
    });

    testWidgets('marks not saved are not lost without asking', (t) async {
      await _show(t);
      await _tap(t, find.text('Ravi'));
      await _tap(t, find.bySemanticsLabel('The day before'));
      expect(find.text('Leave without saving?'), findsOneWidget);
      await _tap(t, find.text('Cancel'));
      expect(find.text('Save · 2 here, 1 away'), findsOneWidget);
    });

    testWidgets("the month's registers, each opening its day", (t) async {
      await _show(t);
      await _tap(t, find.text("See this month's registers"), 1200);
      expect(find.text('November 2026'), findsOneWidget);
      expect(find.text('2 registers taken. Students were here 95% of the time.'), findsOneWidget);
      expect(find.text('18 here · 2 away'), findsOneWidget);
      await _tap(t, find.text(f.dayTitle(DateTime(2026, 11, 21))), 1200);
      expect(_s.gets.last, contains('day=2026-11-21'));
    });

    testWidgets('a month with none says so, and next month cannot be opened', (t) async {
      await _show(t);
      await _tap(t, find.text("See this month's registers"), 1200);
      await _tap(t, find.bySemanticsLabel('The month before'), 1200);
      expect(find.text('October 2026'), findsOneWidget);
      expect(find.text('No registers taken this month.'), findsOneWidget);
    });
  });

  group('around it', () {
    testWidgets("a class's page says how today stands", (t) async {
      Future<void> button(Map<String, dynamic>? today, String label) async {
        await t.pumpWidget(MaterialApp(
          theme: buildTheme(Brightness.light),
          home: Scaffold(body: Center(child: AttendanceButton(today: today, onTap: () {}))),
        ));
        expect(find.text(label), findsOneWidget);
      }

      await button({'taken': false, 'present': 0, 'absent': 0}, 'Take attendance');
      await button({'taken': true, 'present': 18, 'absent': 2}, 'Attendance · 18 of 20 here today');
    });

    test("a parent's message names the child, the class, the day and the tuition", () {
      expect(
        awayMessage(student: 'Ravi', className: '9th Maths', day: '2026-11-21', today: '2026-11-23'),
        'Dear parent, Ravi was not at 9th Maths on ${f.shortDate(DateTime(2026, 11, 21))}. Please let us know if anything is wrong.\n\nPriya Maths Classes',
      );
      expect(awayMessage(student: 'Ravi', className: '9th Maths', day: '2026-11-23', today: '2026-11-23'), startsWith('Dear parent, Ravi was not at 9th Maths today, '));
    });

    test('links carry the class and the day', () {
      expect(const ClassRef.group(9, 'm').link('9th Maths', day: '2026-11-21'), '/t/attendance?class=9&subject=m&name=9th%20Maths&day=2026-11-21');
      expect(const ClassRef.course('c').link('Spoken English', month: '2026-11'), '/t/attendance/month?course=c&name=Spoken%20English&month=2026-11');
      expect(const ClassRef.course('c').query, 'course_id=c');
      expect(const ClassRef.group(9, 'm').body, {'class_level': 9, 'subject_id': 'm'});
    });
  });
}
