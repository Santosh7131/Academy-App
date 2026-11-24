import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/changes.dart';
import '../../core/credit.dart' show inrWhole;
import '../../core/fees.dart';
import '../../core/format.dart' as f;
import '../../core/levels.dart';
import '../../core/links.dart';
import '../../core/session.dart';
import '../../core/timetable.dart';
import '../../theme.dart';
import '../../ui/desk.dart';
import '../../ui/floating_tabs.dart';
import '../../ui/kit.dart';
import '../../ui/update_card.dart';
import 'library_screens.dart';
import 'start_card.dart';
import 'test_sections.dart';

/// A course's page, with its name so the page has its title before it has loaded.
String studentCoursePath(Map<String, dynamic> c) => '/s/courses/${c['id']}?name=${Uri.encodeComponent('${c['name']}')}';

/// What the floating bar can show: Home always, Courses for a student in a class and a course, Library once there are files to read.
enum _Tab { home, courses, library }

class StudentHome extends StatefulWidget {
  const StudentHome({super.key});

  @override
  State<StudentHome> createState() => _StudentHomeState();
}

class _StudentHomeState extends State<StudentHome> with WidgetsBindingObserver, AutoRefresh<StudentHome> {
  List<Map<String, dynamic>>? _tests;

  /// The courses the student is in. A student with none sees the class's tests and nothing else.
  List<Map<String, dynamic>> _courses = const [];

  /// The classes (groups and courses) that have files to read. The Library tab shows only when there are some.
  List<ClassShelf> _shelves = const [];

  /// The tab showing.
  _Tab _tab = _Tab.home;
  String? _error;
  bool _loading = false;

  /// This month's attendance, every class together (an older server sends none).
  Map<String, dynamic>? _attendance;

  /// What is owed here, once the tutor has set a fee (api/src/routes/fees.ts); null when no fee was ever set.
  Map<String, dynamic>? _fee;

  /// Today's classes from the timetable (api/src/lib/timetable.ts), by India's calendar on the server's clock, and the next class
  /// on a later day. An older server sends neither.
  List<ClassTime> _today = const [];
  ClassTime? _next;

  /// Said when a class's link could not be opened.
  String? _joinProblem;

  @override
  Set<Area> get refreshAreas => {Area.student};

  // A new test from the teacher shows up within a minute while this is on screen.
  @override
  Duration? get pollEvery => const Duration(seconds: 60);

  @override
  Future<void> refreshQuietly() => _load();

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (_loading) return;
    markLoaded();
    setState(() => _loading = true);
    try {
      final r = await api.get('/student/home');
      _tests = (r['tests'] as List).cast<Map<String, dynamic>>();
      _attendance = r['attendance'] is Map ? (r['attendance'] as Map).cast<String, dynamic>() : null;
      _fee = r['fee'] is Map ? (r['fee'] as Map).cast<String, dynamic>() : null;
      final classes = r['classes'] is Map ? r['classes'] as Map : const {};
      _today = ClassTime.list(classes['today']);
      _next = ClassTime.from(classes['next']);
      // The server says how many courses the student is in (an older server says nothing: none).
      final n = (r['courses'] as num?)?.toInt() ?? 0;
      _courses = n == 0 ? const [] : ((await api.get('/student/courses'))['courses'] as List).cast<Map<String, dynamic>>();
      // And how many files the student can read (an older server says nothing: none).
      _shelves = ((r['library'] as num?)?.toInt() ?? 0) == 0 ? const [] : await loadShelves();
      _error = null;
    } on ApiException catch (e) {
      _error = e.message;
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _open(String path) async {
    await context.push(path);
    _load();
  }

  /// A test that has not been started asks first (what it holds, when the marks show); one under way carries on.
  Future<void> _start(Map<String, dynamic> t) async {
    if (t['state'] != 'in_progress' && !await confirmStart(context, t)) return;
    if (mounted) _open('/s/write/${t['id']}');
  }

  /// A student in several tuitions chooses which one the home shows.
  Future<void> _switchTuition() async {
    final c = await showChoices<String>(
      context,
      title: 'Tuition',
      options: [for (final t in session.activeTuitions) Choice('${t['id']}', '${t['name']}')],
      selected: session.tuitionId,
    );
    if (c?.value != null) session.switchTuition(c!.value!);
  }

  @override
  Widget build(BuildContext context) {
    final user = session.user ?? {};
    final tests = _tests;
    // A person with no class (only in courses) opens straight on their courses. A student in a class and in a
    // course has a Courses tab, kept apart so a course never looks like part of the class. Files to read add a Library tab.
    final inClass = session.classLevel != null;
    final tabs = [_Tab.home, if (inClass && _courses.isNotEmpty) _Tab.courses, if (_shelves.isNotEmpty) _Tab.library];
    final tab = tabs.contains(_tab) ? _tab : _Tab.home;
    final bar = tabs.length > 1;
    // Beside a computer's sidebar the tabs are a switch under the title, not a bar floating at the bottom.
    final desk = onDesk(context);
    final coursesOnly = !inClass;
    final showCourses = tab == _Tab.courses || (tab == _Tab.home && coursesOnly);
    final kicker = inClass && tab == _Tab.home ? '${session.tuitionName} · ${className(session.classLevel)}' : session.tuitionName;
    final title = switch (tab) {
      _Tab.library => 'Library',
      _Tab.courses => 'Courses',
      _Tab.home => session.firstName,
    };
    return Scaffold(
      body: Stack(children: [
        Positioned.fill(
          child: SafeArea(
            child: PullToRefresh(
              onRefresh: _load,
              child: ListView(padding: EdgeInsets.only(top: 8, bottom: bar && !desk ? 110 : 32), physics: const AlwaysScrollableScrollPhysics(), children: [
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: gutter),
                  child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        const SizedBox(height: 14),
                        session.hasChoice
                            ? Pressable(
                                label: 'Change tuition',
                                onTap: _switchTuition,
                                child: Row(mainAxisSize: MainAxisSize.min, children: [
                                  Flexible(child: Kicker(kicker)),
                                  const SizedBox(width: 6),
                                  Icon(Ph.caretDown, size: 13, color: faint),
                                ]),
                              )
                            : Kicker(kicker),
                        const SizedBox(height: 6),
                        Text(title, style: displayStyle, maxLines: 1, overflow: TextOverflow.ellipsis),
                      ]),
                    ),
                    Pressable(
                      label: 'Profile',
                      onTap: () => context.push('/s/profile'),
                      child: AppAvatar(name: '${user['display_name'] ?? ''}', seed: '${user['id'] ?? ''}', size: 42),
                    ),
                  ]),
                ),
                if (bar && desk)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(gutter, 18, gutter, 0),
                    child: SegmentedToggle(
                      labels: [
                        for (final t in tabs)
                          switch (t) {
                            _Tab.home => 'Home',
                            _Tab.courses => 'Courses',
                            _Tab.library => 'Library',
                          },
                      ],
                      index: tabs.indexOf(tab),
                      onChanged: (i) => setState(() => _tab = tabs[i]),
                    ),
                  ),
                const UpdateBanner(),
                if (tests == null && _error != null)
                  ErrorState(message: _error!, onRetry: _load)
                else if (tests == null)
                  const _HomeSkeleton()
                else ...[
                  if (_error != null)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(gutter, 18, gutter, 0),
                      child: InlineNotice(_error!, icon: Ph.warning),
                    ),
                  if (tab == _Tab.home) ..._classRows(),
                  ...(tab == _Tab.library
                      ? staggered(libraryRows(_shelves, onOpen: (shelf) => _open(libraryClassPath(shelf))), scope: this, prefix: 'library', stepMs: 70)
                      : showCourses
                          ? _courseSections(withNote: tab == _Tab.courses)
                          : _sections(tests)),
                  if (tab == _Tab.home) ..._feeRows(),
                  if (tab == _Tab.home) ..._attendanceRows(),
                ],
              ]),
            ),
          ),
        ),
        if (bar && !desk)
          FloatingTabs.positioned(
            context,
            child: FloatingTabs(
              items: [
                for (final t in tabs)
                  switch (t) {
                    _Tab.home => (Ph.house, 'Home'),
                    _Tab.courses => (Ph.graduationCap, 'Courses'),
                    _Tab.library => (Ph.books, 'Library'),
                  },
              ],
              index: tabs.indexOf(tab),
              onTap: (i) => setState(() => _tab = tabs[i]),
            ),
          ),
      ]),
    );
  }

  List<Widget> _sections(List<Map<String, dynamic>> tests) => staggered(
        testSections(
          context,
          tests,
          onStart: _start,
          onOpen: _open,
          onAllResults: () => context.push('/s/results'),
        ),
        scope: this,
        prefix: 'home',
        stepMs: 70,
      );

  /// Today's classes from the timetable, each with Join when the tutor gave a link to join it online; on a day with none, the next
  /// class.
  List<Widget> _classRows() {
    final today = _today;
    final next = _next;
    if (today.isEmpty && (next == null || next.day == null)) return const [];
    return [
      SectionRule(today.isNotEmpty ? "Today's classes" : 'Next class', count: today.length > 1 ? today.length : null),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: gutter),
        child: Column(children: [
          if (today.isEmpty)
            _ClassRow(time: next!, when: '${f.shortDate(f.dayOf(next.day!))} · ${startLabel(next.startsAt)}')
          else
            for (final (i, t) in today.indexed) ...[
              if (i > 0) const SizedBox(height: gapRow),
              _ClassRow(time: t, when: startLabel(t.startsAt), onJoin: t.joinUrl == null ? null : () => _join(t.joinUrl!)),
            ],
          if (_joinProblem != null) ...[const SizedBox(height: 10), InlineNotice(_joinProblem!, icon: Ph.warning)],
        ]),
      ),
    ];
  }

  /// Opens a class's link outside the app: the Meet, Zoom or Jitsi app, or the browser.
  Future<void> _join(String url) async {
    final ok = await openJoinLink(url);
    if (mounted) setState(() => _joinProblem = ok ? null : 'The link could not be opened here. Ask your tutor to check it.');
  }

  /// The fee owed, the oldest month first, or this month's paid; a tap opens the fees, to pay by UPI.
  List<Widget> _feeRows() {
    final fee = _fee;
    if (fee == null) return const [];
    final owing = [for (final m in (fee['owing'] as List?) ?? const []) Map<String, dynamic>.from(m as Map)];
    final unpaid = owing.where((m) => m['status'] == 'unpaid').toList();
    final month = fee['month'] is Map ? (fee['month'] as Map).cast<String, dynamic>() : null;
    final String title;
    final String meta;
    Color? color;
    if (unpaid.isNotEmpty) {
      final left = unpaid.fold<int>(0, (n, m) => n + paiseOf(m['left']));
      final late = unpaid.any((m) => m['late'] == true);
      title = '${inrWhole(left)} to pay';
      meta = unpaid.length == 1
          ? '${monthName('${unpaid.first['month']}')} · ${late ? 'was due' : 'due'} ${dueDay('${unpaid.first['due_on']}')}'
          : 'For ${monthsList([for (final m in unpaid) '${m['month']}'])}';
      if (late) color = danger;
    } else if (owing.isNotEmpty) {
      title = 'Waiting for your tutor';
      meta = 'You said you paid for ${monthsList([for (final m in owing) '${m['month']}'])}';
    } else if (month != null) {
      title = '${monthName('${month['month']}')} is paid';
      meta = 'Receipts are in Fees';
      color = success;
    } else {
      return const [];
    }
    return [
      const SectionRule('Fees'),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: gutter),
        child: RowTile(
          leading: Icon(Ph.currencyInr, size: 22, color: ink),
          title: title,
          meta: meta,
          metaColor: color,
          chevron: true,
          onTap: () => _open('/s/fees'),
        ),
      ),
    ];
  }

  /// This month's attendance, every class together, once a register with the student on it has been taken.
  List<Widget> _attendanceRows() {
    final a = _attendance;
    final classes = (a?['classes'] as num?)?.toInt() ?? 0;
    if (a == null || classes == 0) return const [];
    final here = (a['present'] as num?)?.toInt() ?? 0;
    final away = ((a['absent_days'] as List?) ?? const []).map((x) => '$x').toList();
    final shown = away.take(3).map((x) => f.shortDate(f.dayOf(x))).join(', ');
    return [
      const SectionRule('Attendance this month'),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: gutter),
        child: RowTile(
          leading: Icon(Ph.listChecks, size: 22, color: ink),
          title: 'Here at $here of ${f.count(classes, 'class', 'classes')}',
          meta: away.isEmpty ? 'Not away once' : 'Away $shown${away.length > 3 ? ' and ${f.count(away.length - 3, 'more day', 'more days')}' : ''}',
        ),
      ),
    ];
  }

  /// The student's courses, one row each. Under a Courses tab a note says these are not the class's tests.
  List<Widget> _courseSections({required bool withNote}) {
    if (_courses.isEmpty) {
      return [
        const SizedBox(height: 40),
        const EmptyState(
          icon: Ph.graduationCap,
          title: 'Nothing here yet',
          body: 'Your tutor has not added you to a class or a course yet. When they do, it shows up here.',
        ),
      ];
    }
    return staggered(
      [
        if (withNote)
          const Padding(
            padding: EdgeInsets.fromLTRB(gutter, 22, gutter, 0),
            child: InlineNotice('Tests here are only for your courses. Your class tests are under Tests.', tone: Tone.neutral, icon: Ph.graduationCap),
          )
        else
          SectionRule('Your courses', count: _courses.length),
        Padding(
          padding: EdgeInsets.fromLTRB(gutter, withNote ? 16 : 0, gutter, 0),
          child: Column(children: [
            for (final (i, c) in _courses.indexed) ...[if (i > 0) const SizedBox(height: gapRow), _CourseRow(course: c, onTap: () => _open(studentCoursePath(c)))],
          ]),
        ),
      ],
      scope: this,
      prefix: 'courses',
      stepMs: 70,
    );
  }
}

/// A class on the timetable: when, which and for how long, and Join when there is a link to join it online. Joining leaves the app
/// for the tutor's chosen service, so the row names where it goes.
class _ClassRow extends StatelessWidget {
  const _ClassRow({required this.time, required this.when, this.onJoin});

  final ClassTime time;
  final String when;
  final VoidCallback? onJoin;

  @override
  Widget build(BuildContext context) => RowTile(
        leading: Icon(Ph.clock, size: 22, color: ink),
        title: '$when · ${time.name ?? ''}',
        meta: [lengthLabel(time.minutes), if (onJoin != null) 'on ${linkHost(time.joinUrl!)}', ?time.note].join(' · '),
        trailing: onJoin == null ? null : SegChip('Join', selected: true, onTap: onJoin),
        onTap: onJoin,
      );
}

/// A course the student is in: its name, whether a test is open and when it closes.
class _CourseRow extends StatelessWidget {
  const _CourseRow({required this.course, required this.onTap});
  final Map<String, dynamic> course;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final open = (course['open'] as num?)?.toInt() ?? 0;
    final closes = f.parseTime(course['closes_at']);
    return RowTile(
      title: '${course['name']}',
      meta: open == 0 ? 'No test open right now' : '${f.count(open, 'test')} open${closes == null ? '' : ' · closes ${f.whenDate(closes)}'}',
      trailing: open > 0 ? TagChip('$open open', tone: Tone.success) : null,
      chevron: true,
      onTap: onTap,
    );
  }
}

class _HomeSkeleton extends StatelessWidget {
  const _HomeSkeleton();

  @override
  Widget build(BuildContext context) => const SkeletonScope(
        child: Padding(
          padding: EdgeInsets.fromLTRB(gutter, 22, gutter, 0),
          child: Column(children: [
            SkeletonHero(height: 214),
            SizedBox(height: 34),
            SkeletonRows(count: 3, padding: EdgeInsets.zero),
          ]),
        ),
      );
}
