import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:go_router/go_router.dart';

import '../core/api.dart';
import '../core/brand.dart';
import '../core/levels.dart';
import '../core/session.dart';
import '../theme.dart';
import '../ui/brand_mark.dart';
import '../ui/desk.dart';
import '../ui/kit.dart';
import 'teacher/attendance_screens.dart' show ClassRef;
import 'teacher/common.dart' show showProblem;
import 'teacher/make_test.dart' show MakeTests, TestTarget;
import 'teacher/timetable_screens.dart' show timetableLink;

/// The app in a computer's browser (ui/desk.dart says when it shows). A signed-in person gets a sidebar that stays on the left,
/// with the page beside it; signing in, making an account, setting up and writing a test keep a column in the middle. A phone,
/// a tablet and a narrow window keep the phone's column, as before.
///
/// It sits above the router's pages (MaterialApp.router's builder), so it is given the router itself: it follows the page on top,
/// pushed pages included, and opens what the sidebar asks for through it.
class DeskFrame extends StatefulWidget {
  const DeskFrame({super.key, required this.router, required this.child});

  final GoRouter router;
  final Widget child;

  @override
  State<DeskFrame> createState() => _DeskFrameState();
}

class _DeskFrameState extends State<DeskFrame> {
  /// The pages keep their state when the layout round them changes: signing in, or a window made narrower.
  final _pages = GlobalKey(debugLabel: 'pages');
  bool _listening = false;
  Uri _at = Uri();

  @override
  void initState() {
    super.initState();
    if (!deskAllowed) return;
    _listening = true;
    widget.router.routerDelegate.addListener(_moved);
    session.addListener(_moved);
    _at = _where();
  }

  @override
  void dispose() {
    if (_listening) {
      widget.router.routerDelegate.removeListener(_moved);
      session.removeListener(_moved);
    }
    super.dispose();
  }

  /// The page on top: one pushed over another counts, not only the address the browser shows.
  Uri _where() {
    final config = widget.router.routerDelegate.currentConfiguration;
    if (config.isEmpty) return Uri();
    try {
      return widget.router.state.uri;
    } catch (_) {
      return config.uri;
    }
  }

  void _moved() {
    if (!mounted) return;
    // The router can tell of a move while the tree is being built; the frame follows straight after.
    if (SchedulerBinding.instance.schedulerPhase == SchedulerPhase.persistentCallbacks) {
      SchedulerBinding.instance.addPostFrameCallback((_) => _moved());
      return;
    }
    final at = _where();
    setState(() => _at = at);
  }

  /// The pages that have the sidebar: a signed-in person's own, but not the test being written, which has the screen to itself.
  static bool _framed(String path) {
    if (!session.signedIn || session.needsTuition) return false;
    if (path.startsWith('/s/write/')) return false;
    return path == '/t' || path.startsWith('/t/') || path == '/s' || path.startsWith('/s/') || path.startsWith('/library/');
  }

  @override
  Widget build(BuildContext context) {
    final pages = KeyedSubtree(key: _pages, child: widget.child);
    if (!deskAllowed) return PhoneColumn(child: pages);
    final mq = MediaQuery.of(context);
    if (mq.size.width < deskMinWidth) return PhoneColumn(child: pages);
    final path = _at.path;
    if (!_framed(path)) {
      // A test being written keeps the phone's column; signing in and the like, a narrower one with nothing round it.
      final writing = path.startsWith('/s/write/');
      return PhoneColumn(width: writing ? 720 : 480, edges: writing, child: pages);
    }
    final room = Size(mq.size.width - deskSideWidth - 1, mq.size.height);
    return ColoredBox(
      color: bg,
      child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        SizedBox(width: deskSideWidth, child: _Sidebar(at: _at, router: widget.router)),
        ColoredBox(color: hairline, child: const SizedBox(width: 1)),
        Expanded(
          // No motion beside the sidebar: a page swaps at once, as a web page does, and rows do not slide in.
          child: MediaQuery(
            data: mq.copyWith(size: room, disableAnimations: true),
            child: Theme(
              data: Theme.of(context).copyWith(
                pageTransitionsTheme: PageTransitionsTheme(builders: {for (final p in TargetPlatform.values) p: const _AtOnce()}),
              ),
              child: DeskScope(child: pages),
            ),
          ),
        ),
      ]),
    );
  }
}

/// A page swaps in with no transition.
class _AtOnce extends PageTransitionsBuilder {
  const _AtOnce();

  @override
  Widget buildTransitions<T>(PageRoute<T> route, BuildContext context, Animation<double> animation, Animation<double> secondaryAnimation, Widget child) =>
      child;
}

/// Where in the app a page belongs, for the sidebar to show which entry is open.
enum _Place { home, classes, bank, timetable, attendance, fees, plan, settings, results, profile }

_Place? _placeOf(String path) {
  bool under(String p) => path == p || path.startsWith('$p/');
  if (path == '/t' || path == '/s' || under('/s/courses') || under('/s/library') || path == '/s/join') return _Place.home;
  if (path == '/t/classes' || under('/t/groups') || under('/t/courses') || under('/t/students') || path == '/t/invite') return _Place.classes;
  if (path == '/t/bank') return _Place.bank;
  if (under('/t/timetable')) return _Place.timetable;
  if (under('/t/attendance')) return _Place.attendance;
  if (under('/t/fees') || under('/s/fees')) return _Place.fees;
  if (under('/t/plan') || under('/t/credit')) return _Place.plan;
  if (under('/t/settings') || path == '/t/profile' || path == '/t/code') return _Place.settings;
  if (under('/s/results') || under('/s/result') || under('/s/review')) return _Place.results;
  if (path == '/s/profile') return _Place.profile;
  return null;
}

List<Map<String, dynamic>> _list(Map<String, dynamic> d, String key) => ((d[key] as List?) ?? const []).cast<Map<String, dynamic>>();

class _Sidebar extends StatelessWidget {
  const _Sidebar({required this.at, required this.router});

  final Uri at;
  final GoRouter router;

  /// A context inside the router's own navigator, for the cards the sidebar opens.
  BuildContext? get _pages => router.routerDelegate.navigatorKey.currentContext;

  /// Home's figures: the tuition's groups and courses, for making a test or choosing a class. Null when it could not be had.
  Future<Map<String, dynamic>?> _home(BuildContext pages) async {
    try {
      return Map<String, dynamic>.from(await api.get('/teacher/home'));
    } on ApiException catch (e) {
      if (pages.mounted) await showProblem(pages, e);
      return null;
    }
  }

  /// Make tests, for any of the tuition's groups and courses; with none yet, the page where they are added.
  Future<void> _makeTests() async {
    final pages = _pages;
    if (pages == null) return;
    final d = await _home(pages);
    if (d == null) return;
    final targets = [
      for (final g in _list(d, 'groups')) TestTarget.fromGroup(g),
      for (final c in _list(d, 'courses')) TestTarget.fromCourse(c),
    ];
    if (targets.isEmpty) {
      router.go('/t/classes');
      return;
    }
    router.push('/t/make', extra: MakeTests(targets: targets));
  }

  /// A timetable and a register are each a class's own: the tutor chooses the class first (none to choose with only one).
  Future<void> _openClass({required bool timetable}) async {
    final pages = _pages;
    if (pages == null) return;
    final d = await _home(pages);
    if (d == null || !pages.mounted) return;
    final classes = <({String name, ClassRef ref, String kind})>[
      for (final g in _list(d, 'groups'))
        (
          name: groupName((g['class_level'] as num).toInt(), '${g['subject']}'),
          ref: ClassRef.group((g['class_level'] as num).toInt(), '${g['subject_id']}'),
          kind: 'Group',
        ),
      for (final c in _list(d, 'courses')) (name: '${c['name']}', ref: ClassRef.course('${c['id']}'), kind: 'Course'),
    ];
    if (classes.isEmpty) {
      router.go('/t/classes');
      return;
    }
    final pick = classes.length == 1
        ? classes.first
        : await showCentredCard<({String name, ClassRef ref, String kind})>(
            pages,
            title: timetable ? 'Whose timetable?' : 'Whose attendance?',
            subtitle: 'Choose a group or a course',
            builder: (ctx) => Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              for (final (i, c) in classes.indexed) ...[
                if (i > 0) const SizedBox(height: 8),
                RowTile(title: c.name, meta: c.kind, chevron: true, onTap: () => Navigator.of(ctx).pop(c)),
              ],
            ]),
          );
    if (pick == null) return;
    router.go(timetable ? timetableLink(pick.ref, pick.name) : pick.ref.link(pick.name));
  }

  @override
  Widget build(BuildContext context) {
    final teacher = session.isTeacher;
    final owner = session.activeTuition?['role'] == 'owner';
    final place = _placeOf(at.path);
    Widget go(_Place p, IconData icon, String label, String path) => _NavItem(icon: icon, label: label, on: place == p, onTap: () => router.go(path));
    final name = '${session.user?['display_name'] ?? ''}';
    return Material(
      color: bg,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 20, 14, 14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          const _Brand(),
          const SizedBox(height: 20),
          if (teacher) ...[
            _MakeTests(onTap: _makeTests),
            const SizedBox(height: 18),
          ],
          Expanded(
            child: ListView(padding: EdgeInsets.zero, children: [
              if (teacher) ...[
                go(_Place.home, Ph.house, 'Home', '/t'),
                go(_Place.classes, Ph.users, 'Groups & courses', '/t/classes'),
                go(_Place.bank, Ph.bank, 'Bank', '/t/bank'),
                const _NavKicker('Run the tuition'),
                _NavItem(icon: Ph.calendarBlank, label: 'Timetable', on: place == _Place.timetable, onTap: () => _openClass(timetable: true)),
                _NavItem(icon: Ph.listChecks, label: 'Attendance', on: place == _Place.attendance, onTap: () => _openClass(timetable: false)),
                if (owner) go(_Place.fees, Ph.currencyInr, 'Fees', '/t/fees'),
              ] else ...[
                go(_Place.home, Ph.house, 'Home', '/s'),
                go(_Place.results, Ph.chartBar, 'Results', '/s/results'),
                go(_Place.fees, Ph.currencyInr, 'Fees', '/s/fees'),
              ],
            ]),
          ),
          if (teacher) ...[
            go(_Place.plan, Ph.coins, 'Plan', '/t/plan'),
            go(_Place.settings, Ph.gear, 'Settings', '/t/settings'),
          ] else
            go(_Place.profile, Ph.userCircle, 'Profile', '/s/profile'),
          const SizedBox(height: 8),
          Container(height: 1, color: hairline),
          const SizedBox(height: 8),
          Pressable(
            label: 'Your profile',
            radius: 12,
            onTap: () => router.go(teacher ? '/t/profile' : '/s/profile'),
            child: Builder(
              builder: (context) => Container(
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(color: pressHover(context) ? fill : null, borderRadius: BorderRadius.circular(12)),
                child: Row(children: [
                  AppAvatar(name: name, seed: '${session.user?['id'] ?? ''}', size: 32),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: rowTitleStyle.copyWith(fontSize: 13.5)),
                      Text(teacher ? (owner ? 'Owner' : 'Tutor') : 'Student', style: labelStyle.copyWith(color: muted)),
                    ]),
                  ),
                ]),
              ),
            ),
          ),
        ]),
      ),
    );
  }
}

/// The app's mark and name, with the tuition on screen under it.
class _Brand extends StatelessWidget {
  const _Brand();

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(8, 2, 8, 0),
        child: Row(children: [
          Container(
            width: 30,
            height: 30,
            decoration: BoxDecoration(color: actionFill, borderRadius: BorderRadius.circular(8)),
            child: BrandMark(size: 30, color: actionInk),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(appName, style: rowTitleStyle.copyWith(fontSize: 15, fontWeight: FontWeight.w700, height: 1.15, letterSpacing: -0.45)),
              Text(session.tuitionName, maxLines: 1, overflow: TextOverflow.ellipsis, style: labelStyle.copyWith(color: muted)),
            ]),
          ),
        ]),
      );
}

/// The sidebar's one filled button.
class _MakeTests extends StatelessWidget {
  const _MakeTests({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 2),
        child: Pressable(
          label: 'Make tests',
          radius: 12,
          onTap: onTap,
          child: Builder(
            builder: (context) => Container(
              height: 42,
              decoration: BoxDecoration(color: pressHover(context) ? actionHover : actionFill, borderRadius: BorderRadius.circular(12), boxShadow: e4),
              child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                Icon(Ph.plus, size: 18, color: actionInk),
                const SizedBox(width: 8),
                Text('Make tests', style: buttonStyle.copyWith(fontSize: 14, color: actionInk)),
              ]),
            ),
          ),
        ),
      );
}

/// A heading between the sidebar's entries.
class _NavKicker extends StatelessWidget {
  const _NavKicker(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(padding: const EdgeInsets.fromLTRB(10, 18, 10, 8), child: Kicker(text));
}

/// One entry of the sidebar: lifted on a card when its page is open, a soft fill under the pointer.
class _NavItem extends StatelessWidget {
  const _NavItem({required this.icon, required this.label, required this.on, required this.onTap});

  final IconData icon;
  final String label;
  final bool on;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 2),
        child: Pressable(
          label: on ? '$label, open' : label,
          radius: 10,
          onTap: onTap,
          child: Builder(builder: (context) {
            final hover = pressHover(context) && !on;
            final strong = on || hover;
            return Container(
              height: 38,
              padding: const EdgeInsets.symmetric(horizontal: 10),
              decoration: on ? surface(radius: 10, shadow: e1) : BoxDecoration(color: hover ? fill : null, borderRadius: BorderRadius.circular(10)),
              child: Row(children: [
                Icon(icon, size: 18, color: strong ? ink : muted),
                const SizedBox(width: 11),
                Expanded(
                  child: Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: rowTitleStyle.copyWith(fontSize: 13.8, letterSpacing: -0.3, color: strong ? ink : body),
                  ),
                ),
              ]),
            );
          }),
        ),
      );
}
