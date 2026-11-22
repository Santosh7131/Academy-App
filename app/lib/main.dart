import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'core/api.dart';
import 'core/brand.dart';
import 'core/changes.dart';
import 'core/device.dart';
import 'core/push.dart';
import 'core/screen_guard.dart';
import 'core/session.dart';
import 'core/updater.dart';
import 'router.dart';
import 'theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // A release build made without the server's address cannot work: it says so, instead of failing on every screen.
  if (apiMissing) return runApp(const _NoServer());
  await _keepPhonesUpright();
  Push.start();
  await Device.load();
  await session.loadPrefs();
  _resolveDark();
  runApp(const TuitionApp());
}

/// A phone turned on its side has too little height for a question and its buttons, or for a form with the
/// keyboard open, so phones stay upright. A tablet turns freely.
Future<void> _keepPhonesUpright() async {
  final view = PlatformDispatcher.instance.views.first;
  if (view.physicalSize.shortestSide / view.devicePixelRatio < 600) {
    await SystemChrome.setPreferredOrientations(const [DeviceOrientation.portraitUp]);
  }
}

/// Applies the theme choice to the token getters. Returns true when it changed.
bool _resolveDark() {
  final platformDark = PlatformDispatcher.instance.platformBrightness == Brightness.dark;
  final dark = switch (session.theme) {
    ThemeChoice.system => platformDark,
    ThemeChoice.light => false,
    ThemeChoice.dark => true,
  };
  final changed = dark != isDark;
  setResolvedDark(dark);
  return changed;
}

class TuitionApp extends StatefulWidget {
  const TuitionApp({super.key});

  @override
  State<TuitionApp> createState() => _TuitionAppState();
}

class _TuitionAppState extends State<TuitionApp> with WidgetsBindingObserver {
  late final _router = buildRouter();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    session.addListener(_onSession);
    session.restore();
    updater.start();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    session.removeListener(_onSession);
    super.dispose();
  }

  void _onSession() {
    ScreenGuard.forRole(session.user?['role'] as String?);
    Push.forSession(session.signedIn ? api.token : null);
    if (_resolveDark()) _rebuildEverything();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) updater.resumed();
  }

  @override
  void didChangePlatformBrightness() {
    if (_resolveDark()) _rebuildEverything();
  }

  /// Colours are theme-resolving getters read during build, so a theme change
  /// marks every element dirty. State (an open test, a half-typed form) is kept.
  void _rebuildEverything() {
    setState(() {});
    void walk(Element e) {
      e.markNeedsBuild();
      e.visitChildren(walk);
    }

    WidgetsBinding.instance.rootElement?.visitChildren(walk);
  }

  @override
  Widget build(BuildContext context) {
    final b = isDark ? Brightness.dark : Brightness.light;
    // Subtle motion: screens fade forward over a short slide (Android's own transition).
    final theme = buildTheme(b).copyWith(
      pageTransitionsTheme: PageTransitionsTheme(builders: {
        for (final p in TargetPlatform.values) p: const FadeForwardsPageTransitionsBuilder(),
      }),
    );
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle(
        statusBarColor: Colors.transparent,
        statusBarIconBrightness: isDark ? Brightness.light : Brightness.dark,
        statusBarBrightness: b,
        systemNavigationBarColor: bg,
        systemNavigationBarIconBrightness: isDark ? Brightness.light : Brightness.dark,
      ),
      // Every touch counts as the phone being in use, which keeps screens checking for news.
      child: Listener(
        onPointerDown: (_) => changes.lastTouch = DateTime.now(),
        child: MaterialApp.router(
          title: appName,
          debugShowCheckedModeBanner: false,
          theme: theme,
          routerConfig: _router,
        ),
      ),
    );
  }
}


/// What a release build made without the server's address shows instead of the app: it cannot reach anything, and every screen
/// would fail. Only whoever built it ever sees this.
class _NoServer extends StatelessWidget {
  const _NoServer();

  @override
  Widget build(BuildContext context) => const MaterialApp(
        debugShowCheckedModeBanner: false,
        home: Scaffold(
          body: SafeArea(
            child: Padding(
              padding: EdgeInsets.all(28),
              child: Center(
                child: Text(
                  "This copy of the app was built without its server's address, so it cannot work.\n\n"
                  'Build it again with --dart-define=API_BASE=https://... (tools/release-app.ps1 does this).',
                  style: TextStyle(fontSize: 16, height: 1.5),
                ),
              ),
            ),
          ),
        ),
      );
}
