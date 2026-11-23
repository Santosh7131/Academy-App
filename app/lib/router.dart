import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'core/session.dart';
import 'features/auth/login_screen.dart';
import 'features/auth/signup_screen.dart';
import 'features/auth/start_screen.dart';
import 'features/auth/update_required_screen.dart';
import 'features/library/file_viewer.dart';
import 'features/student/course_screen.dart';
import 'features/student/home_screen.dart';
import 'features/student/join_screen.dart';
import 'features/student/library_screens.dart';
import 'features/student/profile_screen.dart';
import 'features/student/result_screen.dart';
import 'features/student/results_screen.dart';
import 'features/student/review_screen.dart';
import 'features/student/test_screen.dart';
import 'features/teacher/setup_screen.dart';
import 'features/teacher/teacher_routes.dart';

/// Each screen fades in over the one before it: the theme's fade-forwards transition.
GoRoute page(String path, Widget Function(GoRouterState s) build) =>
    GoRoute(path: path, pageBuilder: (c, s) => MaterialPage(key: s.pageKey, child: build(s)));

GoRouter buildRouter() => GoRouter(
      initialLocation: '/start',
      refreshListenable: session,
      redirect: (context, state) {
        final loc = state.matchedLocation;
        // A group's or course's join link opened the app (<app id>://app/join/<code>, from the link's page or its QR code): its
        // code is kept first, before anything below sends the app elsewhere, and the join screen offers it once it can.
        if (loc.startsWith('/join/')) session.holdJoin(loc.substring('/join/'.length));
        if (!session.restored || !session.splashDone) return loc == '/start' ? null : '/start';
        // A version the server no longer accepts shows the update screen, signed in or not.
        if (session.updateRequired) return loc == '/update' ? null : '/update';
        if (loc == '/update') return session.signedIn ? (session.isTeacher ? '/t' : '/s') : '/login';
        const signedOut = {'/login', '/signup', '/signup/student'};
        if (!session.signedIn) return signedOut.contains(loc) ? null : '/login';
        final teacher = session.isTeacher;
        final home = teacher ? '/t' : '/s';
        // Join links are for students: a tutor's phone forgets one.
        if (teacher && session.pendingJoin != null) session.dropJoin();
        // A tutor with no tuition creates one first; a student with no place yet can only ask to join.
        if (session.needsTuition) {
          if (teacher) return loc == '/setup' ? null : '/setup';
          return loc == '/s/join' || loc == '/s/profile' ? null : '/s/join';
        }
        // A student who opened a join link sees it as soon as they are in.
        if (!teacher && session.pendingJoin != null && (loc == '/start' || loc.startsWith('/join/') || signedOut.contains(loc))) return '/s/join';
        if (loc == '/start' || loc.startsWith('/join/') || signedOut.contains(loc) || loc == '/setup') return home;
        if (teacher && loc.startsWith('/s')) return home;
        if (!teacher && loc.startsWith('/t')) return home;
        return null;
      },
      routes: [
        page('/start', (_) => const StartScreen()),
        page('/login', (_) => const LoginScreen()),
        page('/signup', (_) => const TutorSignUpScreen()),
        page('/signup/student', (_) => const StudentSignUpScreen()),
        // Never shown: the redirect above keeps the link's code and moves on.
        page('/join/:code', (_) => const SizedBox.shrink()),
        page('/setup', (_) => const SetupScreen()),
        page('/update', (_) => const UpdateRequiredScreen()),
        page('/s', (_) => const StudentHome()),
        page('/s/courses/:id', (s) => StudentCourseScreen(id: s.pathParameters['id']!, name: s.uri.queryParameters['name'] ?? '')),
        page('/s/library/class', (s) => LibraryClassScreen(shelfKey: s.uri.queryParameters['k'] ?? '', name: s.uri.queryParameters['name'] ?? '')),
        // A Library file, opened from either side: what to open comes with the route (features/library/file_viewer.dart).
        page('/library/file', (s) => s.extra is FileViewerArgs ? FileViewerScreen(args: s.extra! as FileViewerArgs) : const SizedBox.shrink()),
        page('/s/write/:id', (s) => TestScreen(testId: s.pathParameters['id']!)),
        page('/s/result/:id', (s) => ResultScreen(attemptId: s.pathParameters['id']!, autoSubmitted: s.uri.queryParameters['auto'] == '1')),
        page('/s/review/:id', (s) => ReviewScreen(attemptId: s.pathParameters['id']!, start: int.tryParse(s.uri.queryParameters['n'] ?? '') ?? 1)),
        page('/s/results', (_) => const ResultsScreen()),
        page('/s/profile', (_) => const ProfileScreen()),
        page('/s/join', (_) => const JoinScreen()),
        ...teacherRoutes,
      ],
    );
