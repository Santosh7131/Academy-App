// A group's or course's join link that opens the app reaches the real router as Android hands it over: the whole address with the
// app's own scheme, or just its path. Either way the link's code is kept, and a phone that is not signed in shows the login with
// the invitation on it.
//   flutter test test/join_link_route_test.dart
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:tuition_app/core/api.dart';
import 'package:tuition_app/core/google.dart';
import 'package:tuition_app/core/session.dart';
import 'package:tuition_app/router.dart';
import 'package:tuition_app/theme.dart';

const _link = {'code': 'KR7Q4MPAXZ', 'code_shown': 'KR7Q4-MPAXZ', 'tuition': {'name': 'Priya Maths Classes'}, 'kind': 'group', 'label': '9th Maths', 'joining_open': true};

Future<http.Response> _server(http.Request r) async {
  if (r.method == 'GET' && r.url.path == '/join/KR7Q4MPAXZ') {
    return http.Response.bytes(utf8.encode(jsonEncode({'link': _link})), 200, headers: {'content-type': 'application/json'});
  }
  return http.Response('{"error":{"code":"not_found","message":"Not found."}}', 404, headers: {'content-type': 'application/json'});
}

/// Hands the router an address the way the Android embedding does when a link opens the app that is already running.
Future<void> _open(WidgetTester t, String location) async {
  final message = const JSONMethodCodec().encodeMethodCall(MethodCall('pushRouteInformation', {'location': location, 'state': null}));
  await t.binding.defaultBinaryMessenger.handlePlatformMessage('flutter/navigation', message, (_) {});
}

Future<void> _settle(WidgetTester t) async {
  for (var left = 1200; left > 0; left -= 50) {
    await t.pump(const Duration(milliseconds: 50));
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    // First, so the app's one connection to the server is made with the stand-in.
    http.runWithClient(() => api.token = null, () => MockClient(_server));
    SharedPreferences.setMockInitialValues({});
    await session.loadPrefs();
  });

  setUp(() {
    GoogleAuth.pretend(null);
    api.token = null;
    session.user = null;
    session.restored = true;
    session.splashDone = true;
    session.dropJoin();
  });

  for (final location in ['com.tuitiontests.app.dev://app/join/KR7Q4-MPAXZ', '/join/KR7Q4-MPAXZ']) {
    testWidgets('a link opened as $location is kept, and the login shows the invitation', (t) async {
      t.view.physicalSize = const Size(411 * 2.625, 900 * 2.625);
      t.view.devicePixelRatio = 2.625;
      addTearDown(t.view.reset);
      await t.pumpWidget(MaterialApp.router(theme: buildTheme(Brightness.light), routerConfig: buildRouter()));
      await _settle(t);
      expect(find.text('Welcome back'), findsOneWidget, reason: 'signed out, with no link yet');

      await _open(t, location);
      await _settle(t);
      expect(session.pendingJoin, 'KR7Q4MPAXZ');
      expect(find.text('You are invited'), findsOneWidget);
      expect(find.text('Priya Maths Classes'), findsOneWidget);
      expect(find.text('9th Maths'), findsOneWidget);
      await t.pumpWidget(const SizedBox.shrink());
    });
  }

  testWidgets('a link that starts the app is kept too', (t) async {
    t.view.physicalSize = const Size(411 * 2.625, 900 * 2.625);
    t.view.devicePixelRatio = 2.625;
    addTearDown(t.view.reset);
    // A link that starts the app arrives as the platform's first route, which the router takes over its own first page.
    t.binding.platformDispatcher.defaultRouteNameTestValue = 'com.tuitiontests.app.dev://app/join/KR7Q4-MPAXZ';
    addTearDown(t.binding.platformDispatcher.clearDefaultRouteNameTestValue);
    await t.pumpWidget(MaterialApp.router(theme: buildTheme(Brightness.light), routerConfig: buildRouter()));
    await _settle(t);
    expect(session.pendingJoin, 'KR7Q4MPAXZ');
    expect(find.text('You are invited'), findsOneWidget);
    await t.pumpWidget(const SizedBox.shrink());
  });
}
