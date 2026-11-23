// Everyone logs in with a username and password now, students too (they make their own accounts), so the password box always asks
// the phone for the full keyboard: no number pad that a password's letters cannot be typed on. A new student or tutor finds how to
// make an account on the same screen.
//   flutter test test/login_keyboard_test.dart
import 'package:tuition_app/core/google.dart';
import 'package:tuition_app/core/session.dart';
import 'package:tuition_app/features/auth/login_screen.dart';
import 'package:tuition_app/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The keyboard the phone was last asked for.
String? _asked(WidgetTester t) => (t.testTextInput.setClientArgs?['inputType'] as Map?)?['name'] as String?;

Future<void> _open(WidgetTester t) async {
  t.view.physicalSize = const Size(411 * 2.625, 900 * 2.625);
  t.view.devicePixelRatio = 2.625;
  addTearDown(t.view.reset);
  await t.pumpWidget(MaterialApp(theme: buildTheme(Brightness.light), home: const LoginScreen()));
  await t.pump(const Duration(seconds: 1)); // the boxes come in one after another
}

/// The second box: the password.
Finder get _secret => find.byType(TextField).last;

Future<void> _settle(WidgetTester t) async {
  for (var left = 400; left > 0; left -= 50) {
    await t.pump(const Duration(milliseconds: 50));
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    SharedPreferences.setMockInitialValues({});
    await session.loadPrefs();
  });

  setUp(() => GoogleAuth.pretend(null));

  testWidgets('the password box asks for the full keyboard', (t) async {
    await _open(t);
    await t.tap(_secret);
    await _settle(t);
    expect(_asked(t), 'TextInputType.visiblePassword');
  });

  testWidgets('moving to the username box and back keeps the full keyboard', (t) async {
    await _open(t);
    await t.tap(find.byType(TextField).first);
    await _settle(t);
    expect(_asked(t), 'TextInputType.visiblePassword');
    await t.tap(_secret);
    await _settle(t);
    expect(_asked(t), 'TextInputType.visiblePassword');
  });

  testWidgets('there is one login, and the ways to make an account', (t) async {
    await _open(t);
    expect(find.text('Student'), findsNothing, reason: 'students and tutors share one login now');
    expect(find.text('Tutor'), findsNothing);
    expect(find.text('New student? Make your account'), findsOneWidget);
    expect(find.text('New tutor? Create your tuition'), findsOneWidget);
  });

  testWidgets('a password that is empty is asked for before anything is sent', (t) async {
    await _open(t);
    await t.enterText(find.byType(TextField).first, 'asha');
    await t.tap(find.text('Log in'));
    await _settle(t);
    expect(find.text('Type your password.'), findsOneWidget);
  });

  testWidgets('the Google button shows only when the server has Google sign-in on', (t) async {
    await _open(t);
    expect(find.text('Continue with Google'), findsNothing);
    await t.pumpWidget(const SizedBox.shrink());
    GoogleAuth.pretend('test-client.apps.googleusercontent.com');
    await _open(t);
    expect(find.text('Continue with Google'), findsOneWidget);
  });
}
