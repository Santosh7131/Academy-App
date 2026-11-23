// Students make their own accounts and join with a group's or course's link: the join screen offers a link that opened the app and
// asks with it, a tutor lets everyone in at once and is told who could not be, the invite screen shows the QR code and makes a new
// link, a link's code is kept only when it is one, and the sign-up form checks what it can before sending anything.
//   flutter test test/join_links_test.dart
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:tuition_app/core/api.dart';
import 'package:tuition_app/core/google.dart';
import 'package:tuition_app/core/session.dart';
import 'package:tuition_app/features/auth/signup_screen.dart';
import 'package:tuition_app/features/student/join_screen.dart';
import 'package:tuition_app/features/teacher/invite_screen.dart';
import 'package:tuition_app/features/teacher/join_requests_screen.dart';
import 'package:tuition_app/theme.dart';
import 'package:tuition_app/ui/qr.dart';

/// What the stand-in server answers, by "METHOD /path"; and every request it was sent.
final _routes = <String, Object? Function(http.Request)>{};
final _sent = <http.Request>[];

Future<http.Response> _server(http.Request r) async {
  _sent.add(r);
  final h = _routes['${r.method} ${r.url.path}'];
  if (h == null) return http.Response('{"error":{"code":"not_found","message":"Not found."}}', 404, headers: {'content-type': 'application/json'});
  final out = h(r);
  if (out is http.Response) return out;
  return http.Response.bytes(utf8.encode(jsonEncode(out)), 200, headers: {'content-type': 'application/json'});
}

Future<void> _open(WidgetTester t, Widget screen) async {
  t.view.physicalSize = const Size(411 * 2.625, 1100 * 2.625);
  t.view.devicePixelRatio = 2.625;
  addTearDown(t.view.reset);
  await t.pumpWidget(MaterialApp(theme: buildTheme(Brightness.light), home: screen));
  await _settle(t);
}

Future<void> _settle(WidgetTester t) async {
  for (var left = 900; left > 0; left -= 50) {
    await t.pump(const Duration(milliseconds: 50));
  }
}

void _signedInAs(String role, {List<Map<String, dynamic>> tuitions = const []}) {
  api.token = 'test';
  session.user = {'id': 'u-1', 'role': role, 'username': 'kavya.i', 'display_name': 'Kavya Iyer', 'class_level': null};
  session.tuitions = tuitions;
  session.tuitionId = tuitions.isEmpty ? null : '${tuitions.first['id']}';
}

const _link = {'code': 'KR7Q4MPAXZ', 'code_shown': 'KR7Q4-MPAXZ', 'tuition': {'name': 'Priya Maths Classes'}, 'kind': 'group', 'label': '9th Maths', 'joining_open': true};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    // First, so the app's one connection to the server is made with the stand-in.
    http.runWithClient(() => api.token = null, () => MockClient(_server));
    SharedPreferences.setMockInitialValues({});
    await session.loadPrefs();
  });

  setUp(() {
    _routes.clear();
    _sent.clear();
    GoogleAuth.pretend(null);
    session.dropJoin();
  });

  test('only a link\'s code is kept, in capitals, without its dash', () async {
    session.holdJoin('kr7q4-mpaxz');
    expect(session.pendingJoin, 'KR7Q4MPAXZ');
    session.dropJoin();
    session.holdJoin('KR7-4MQ'); // a tuition's code is never in a link
    expect(session.pendingJoin, isNull);
    session.holdJoin('../../etc/passwd');
    expect(session.pendingJoin, isNull);
    session.holdJoin('O0I1O0I1O0'); // letters a code never has
    expect(session.pendingJoin, isNull);
  });

  testWidgets('a link that opened the app is offered, and asking with it sends its code', (t) async {
    _signedInAs('student');
    _routes['GET /join/KR7Q4MPAXZ'] = (_) => {'link': _link};
    _routes['POST /student/join'] = (_) => {'tuition': {'id': 't-1', 'name': 'Priya Maths Classes'}, 'status': 'pending', 'asked': {'kind': 'group', 'label': '9th Maths'}};
    _routes['GET /auth/me'] = (_) => {
          'user': session.user,
          'tuition_name': 'Priya Maths Classes',
          'tuitions': [{'id': 't-1', 'name': 'Priya Maths Classes', 'role': 'student', 'status': 'pending', 'class_level': null}],
        };
    session.holdJoin('KR7Q4MPAXZ');
    await _open(t, const JoinScreen());
    expect(find.text('Priya Maths Classes'), findsOneWidget);
    expect(find.text('9th Maths'), findsOneWidget);
    await t.tap(find.text('Ask to join').first);
    await _settle(t);
    final asked = _sent.lastWhere((r) => r.url.path == '/student/join');
    expect(jsonDecode(asked.body), {'code': 'KR7Q4MPAXZ'});
    expect(find.textContaining('Asked to join 9th Maths at Priya Maths Classes'), findsOneWidget);
    expect(session.pendingJoin, isNull, reason: 'a link once used is not offered again');
    await t.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('a link that stopped working says so, and OK forgets it', (t) async {
    _signedInAs('student');
    _routes['GET /join/KR7Q4MPAXZ'] = (_) => http.Response(
        '{"error":{"code":"unknown_link","message":"This link has stopped working. Ask your tutor for the new one."}}', 404,
        headers: {'content-type': 'application/json'});
    session.holdJoin('KR7Q4MPAXZ');
    await _open(t, const JoinScreen());
    expect(find.text('This link has stopped working. Ask your tutor for the new one.'), findsOneWidget);
    await t.tap(find.text('OK'));
    await _settle(t);
    expect(session.pendingJoin, isNull);
    await t.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('let all in lets everyone in, and says who is still waiting and why', (t) async {
    _signedInAs('teacher', tuitions: [{'id': 't-1', 'name': 'Priya Maths Classes', 'role': 'owner', 'status': 'active'}]);
    var waiting = true;
    _routes['GET /teacher/join-requests'] = (_) => {
          'requests': <Object>[],
          'link_requests': waiting
              ? [
                  {'id': 'r-1', 'student_id': 's-1', 'display_name': 'Kavya Iyer', 'asked_at': DateTime.now().toIso8601String(), 'kind': 'group', 'label': '9th Maths', 'place': 'pending'},
                  {'id': 'r-2', 'student_id': 's-2', 'display_name': 'Rahul Menon', 'asked_at': DateTime.now().toIso8601String(), 'kind': 'group', 'label': '10th Maths', 'place': 'active'},
                ]
              : <Object>[],
        };
    _routes['POST /teacher/link-requests/accept-all'] = (_) {
      waiting = false;
      return {
        'accepted': 1,
        'left': [{'id': 'r-2', 'name': 'Rahul Menon', 'reason': 'Rahul Menon is in another class here.'}],
      };
    };
    await _open(t, const JoinRequestsScreen());
    expect(find.textContaining('9th Maths · new · asked today'), findsOneWidget);
    expect(find.textContaining('10th Maths · in your tuition'), findsOneWidget);
    await t.tap(find.text('Let all 2 in'));
    await _settle(t);
    expect(find.text('Rahul Menon is in another class here.'), findsOneWidget);
    expect(_sent.any((r) => r.url.path == '/teacher/link-requests/accept-all'), isTrue);
    await t.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('the invite screen shows the QR code and the code, and a new link replaces the old', (t) async {
    _signedInAs('teacher', tuitions: [{'id': 't-1', 'name': 'Priya Maths Classes', 'role': 'owner', 'status': 'active'}]);
    _routes['GET /teacher/courses/c-1/link'] = (_) => {'link': {'code': 'KR7Q4MPAXZ', 'code_shown': 'KR7Q4-MPAXZ', 'url': 'https://join.example.com/j/KR7Q4MPAXZ'}};
    _routes['POST /teacher/courses/c-1/link/new'] = (_) => {'link': {'code': 'MPAXZKR7Q4', 'code_shown': 'MPAXZ-KR7Q4', 'url': 'https://join.example.com/j/MPAXZKR7Q4'}};
    await _open(t, const InviteScreen(courseId: 'c-1', name: 'Spoken English'));
    expect(find.byType(QrBox), findsOneWidget);
    expect(t.widget<QrBox>(find.byType(QrBox)).data, 'https://join.example.com/j/KR7Q4MPAXZ');
    expect(find.text('Code KR7Q4-MPAXZ'), findsOneWidget);
    await t.tap(find.text('Make a new link'));
    await _settle(t);
    await t.tap(find.text('Make a new link').last); // the card's button
    await _settle(t);
    expect(find.text('Code MPAXZ-KR7Q4'), findsOneWidget);
    expect(t.widget<QrBox>(find.byType(QrBox)).data, 'https://join.example.com/j/MPAXZKR7Q4');
    await t.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('student sign-up checks the password before sending anything', (t) async {
    api.token = null;
    session.user = null;
    await _open(t, const StudentSignUpScreen());
    final boxes = find.byType(TextField);
    await t.enterText(boxes.at(0), 'Kavya Iyer');
    await t.enterText(boxes.at(1), 'kavya.i');
    await t.enterText(boxes.at(2), 'short');
    await t.tap(find.text('Make account'));
    await _settle(t);
    expect(find.text('The password needs 8 or more characters.'), findsOneWidget);
    expect(_sent.where((r) => r.url.path == '/auth/signup-student'), isEmpty);
    await t.pumpWidget(const SizedBox.shrink());
  });

  test('a QR code for a link has the modules a phone camera needs', () {
    final image = qrFor('https://join.example.com/j/KR7Q4MPAXZ');
    expect(image.moduleCount, greaterThanOrEqualTo(21));
    // The three finder squares in the corners are dark at their corners.
    expect(image.isDark(0, 0) && image.isDark(0, image.moduleCount - 1) && image.isDark(image.moduleCount - 1, 0), isTrue);
  });
}
