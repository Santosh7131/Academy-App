// A login that never reached the server (no internet, the server out of reach) keeps the PIN or password, so trying again is one tap;
// a login the server refused clears it for a fresh try. Both show what went wrong.
//   flutter test test/login_error_test.dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:tuition_app/core/api.dart';
import 'package:tuition_app/core/session.dart';
import 'package:tuition_app/features/auth/login_screen.dart';
import 'package:tuition_app/theme.dart';

/// Whether the stand-in server is out of reach; when it is reachable it refuses every login, as it does a wrong password.
var _unreachable = true;

Future<http.Response> _server(http.Request r) async {
  if (_unreachable) throw http.ClientException('Connection refused', r.url);
  return http.Response('{"error":{"code":"wrong_login","message":"That username and password do not match."}}', 401,
      headers: {'content-type': 'application/json'});
}

Future<void> _open(WidgetTester t) async {
  t.view.physicalSize = const Size(411 * 2.625, 900 * 2.625);
  t.view.devicePixelRatio = 2.625;
  addTearDown(t.view.reset);
  await t.pumpWidget(MaterialApp(theme: buildTheme(Brightness.light), home: const LoginScreen()));
  await t.pump(const Duration(seconds: 1)); // the boxes come in one after another
}

Future<void> _settle(WidgetTester t) async {
  for (var left = 600; left > 0; left -= 50) {
    await t.pump(const Duration(milliseconds: 50));
  }
}

/// Signs in as a tutor with a password, and returns what the password box holds afterwards.
Future<String> _tryTutor(WidgetTester t) async {
  await _open(t);
  await t.tap(find.text('Tutor'));
  await _settle(t);
  await t.enterText(find.byType(TextField).first, 'asha');
  await t.enterText(find.byType(TextField).last, 'a-long-password');
  await t.tap(find.text('Log in'));
  await _settle(t);
  return t.widget<TextField>(find.byType(TextField).last).controller!.text;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    // First, so the app's one connection to the server is made with the stand-in.
    http.runWithClient(() => api.token = null, () => MockClient(_server));
    SharedPreferences.setMockInitialValues({});
    await session.loadPrefs();
  });

  testWidgets('a login that never reached the server keeps the password', (t) async {
    _unreachable = true;
    expect(await _tryTutor(t), 'a-long-password', reason: 'the tutor would have to type the password again only because the internet dropped');
    expect(find.textContaining('No internet connection'), findsOneWidget);
  });

  testWidgets('a login the server refused clears the password', (t) async {
    _unreachable = false;
    expect(await _tryTutor(t), isEmpty);
    expect(find.text('That username and password do not match.'), findsOneWidget);
  });
}
