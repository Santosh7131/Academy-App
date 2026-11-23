import 'dart:math';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/changes.dart';
import '../../core/credit.dart' show inrWhole;
import '../../core/fees.dart';
import '../../core/format.dart' as f;
import '../../theme.dart';
import '../../ui/kit.dart';
import 'common.dart';
import 'subjects.dart';
import '../../core/levels.dart';

class StudentDetailScreen extends StatefulWidget {
  const StudentDetailScreen({super.key, required this.id, this.courseId, this.courseName});
  final String id;

  /// Opened from a course's page: the person is shown as that course sees them (its tests only), and can be
  /// taken out of it.
  final String? courseId;
  final String? courseName;

  @override
  State<StudentDetailScreen> createState() => _StudentDetailScreenState();
}

class _StudentDetailScreenState extends State<StudentDetailScreen> with WidgetsBindingObserver, AutoRefresh<StudentDetailScreen> {
  @override
  Set<Area> get refreshAreas => {Area.students, Area.tests};

  @override
  Future<void> refreshQuietly() => _load();

  Map<String, dynamic>? _d;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    markLoaded();
    try {
      final d = await api.get('/teacher/students/${widget.id}${widget.courseId == null ? '' : '?course=${widget.courseId}'}');
      if (mounted) {
        setState(() {
        _d = Map<String, dynamic>.from(d);
        _error = null;
      });
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _editSubjects(Map<String, dynamic> s) async {
    final List<Subject> subjects;
    try {
      subjects = await loadSubjects();
    } on ApiException catch (e) {
      if (mounted) showProblem(context, e);
      return;
    }
    if (!mounted) return;
    var chosen = {for (final x in (s['subjects'] as List? ?? const [])) '${(x as Map)['id']}'};
    final result = await showCentredCard<Set<String>>(
      context,
      title: 'Subjects',
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setCard) => Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Fig('${s['display_name']} gets the tests of each group they are in.', style: bodyStyle.copyWith(color: muted)),
          const SizedBox(height: 14),
          SubjectToggles(subjects: subjects, value: chosen, onChanged: (v) => setCard(() => chosen = v)),
          const SizedBox(height: 18),
          PrimaryButton(
            'Save',
            onTap: chosen.isEmpty ? null : () => Navigator.of(ctx).pop(chosen),
            disabledReason: chosen.isEmpty ? 'Choose at least one subject.' : null,
          ),
        ]),
      ),
    );
    if (result == null) return;
    try {
      await api.patch('/teacher/students/${widget.id}', {'subject_ids': result.toList()});
      _load();
    } on ApiException catch (e) {
      if (mounted) showProblem(context, e);
    }
  }

  Future<void> _toggleActive(Map<String, dynamic> s) async {
    final active = s['active'] == true;
    final ok = await confirmCard(
      context,
      // The account is the student's own: turning them off closes this tuition to them, and nothing else.
      title: active ? 'Turn off in this tuition?' : 'Turn back on?',
      body: active
          ? '${s['display_name']} keeps their own account, but cannot see this tuition or its tests until you turn them back on. Their results are kept.'
          : '${s['display_name']} will see this tuition and its tests again.',
      confirm: active ? 'Turn off' : 'Turn on',
      destructive: active,
    );
    if (!ok) return;
    try {
      await api.post('/teacher/students/${widget.id}/active', {'active': !active});
      _load();
    } on ApiException catch (e) {
      if (mounted) showProblem(context, e);
    }
  }

  /// Takes the person out of the course this page was opened from. They stay a student with their login and any groups they are in.
  Future<void> _leaveCourse(Map<String, dynamic> s) async {
    final course = widget.courseName ?? 'this course';
    final ok = await confirmCard(
      context,
      title: 'Remove ${s['display_name']} from $course?',
      body: 'They stay a student with their login and any groups they are in. What they wrote in the course stays in its results.',
      confirm: 'Remove',
      destructive: true,
    );
    if (!ok) return;
    try {
      await api.delete('/teacher/courses/${widget.courseId}/people/${widget.id}');
      if (mounted) context.pop(true);
    } on ApiException catch (e) {
      if (mounted) showProblem(context, e);
    }
  }

  Future<void> _delete(Map<String, dynamic> s, int written) async {
    final inCourses = (s['courses'] as List? ?? const []).length;
    final ok = await confirmCard(
      context,
      title: 'Remove ${s['display_name']}?',
      body: [
        if (written > 0) 'Their ${written == 1 ? '1 test result' : '$written test results'} here will be deleted for good.',
        'They keep their own account, and can ask to join again.',
        if (inCourses > 0) 'They are taken out of ${f.count(inCourses, 'course')} too.',
        if (written > 0) 'To keep the results, turn them off instead.',
      ].join(' '),
      confirm: 'Remove',
      destructive: true,
    );
    if (!ok) return;
    try {
      await api.delete('/teacher/students/${widget.id}');
      if (mounted) context.pop(true);
    } on ApiException catch (e) {
      if (mounted) showProblem(context, e);
    }
  }

  /// The student's attendance, on the same registers as the results above (a course's from its page, the groups' from a group's).
  /// Nothing shows until a register with this student on it has been taken.
  List<Widget> _attendance(Object? a) {
    final m = a is Map ? a.cast<String, dynamic>() : null;
    final classes = (m?['classes'] as num?)?.toInt() ?? 0;
    if (m == null || classes == 0) return const [];
    final here = (m['present'] as num?)?.toInt() ?? 0;
    final away = ((m['absent_days'] as List?) ?? const []).map((x) => '$x').toList();
    final shown = away.take(3).map((x) => f.shortDate(f.dayOf(x))).join(', ');
    return [
      const SizedBox(height: gapRow),
      RowTile(
        leading: Icon(Ph.listChecks, size: 22, color: ink),
        title: 'Here at $here of ${f.count(classes, 'class', 'classes')} · ${f.percent(here / classes)}',
        meta: away.isEmpty ? 'Not away once' : 'Away $shown${away.length > 3 ? ' and ${f.count(away.length - 3, 'more day', 'more days')}' : ''}',
      ),
    ];
  }

  /// The student's fee and what they still owe. Only the owner sees fees, so the page has none for a helper tutor, nor from a
  /// course's page. A tap opens their fees, to record a payment or remind the parents.
  List<Widget> _fee(Object? v, Map<String, dynamic> s) {
    if (v is! Map) return const [];
    final m = v.cast<String, dynamic>();
    final fee = m['fee'] == null ? null : paiseOf(m['fee']);
    final owing = [for (final x in (m['owing'] as List?) ?? const []) Map<String, dynamic>.from(x as Map)];
    final unpaid = owing.where((x) => x['status'] == 'unpaid').toList();
    final month = m['month'] is Map ? (m['month'] as Map).cast<String, dynamic>() : null;
    String meta;
    Color? color;
    if (fee == null && m['set'] != true) {
      meta = 'Set a monthly fee';
    } else if (unpaid.isNotEmpty) {
      meta = '${inrWhole(paiseOf(m['left']))} to pay for ${monthsList([for (final x in unpaid) '${x['month']}'])}';
      if (unpaid.any((x) => x['late'] == true)) color = danger;
    } else if (owing.isNotEmpty) {
      meta = 'A payment to confirm';
      color = warning;
    } else if (month != null && month['status'] == 'paid') {
      meta = '${monthName('${month['month']}')} is paid';
      color = success;
    } else {
      meta = 'Nothing owed';
    }
    return [
      const SizedBox(height: gapRow),
      RowTile(
        leading: Icon(Ph.currencyInr, size: 22, color: ink),
        title: fee == null ? 'Fees' : '${inrWhole(fee)} a month',
        meta: meta,
        metaColor: color,
        chevron: true,
        onTap: () => context.push('/t/fees/students/${widget.id}?name=${Uri.encodeComponent('${s['display_name']}')}'),
      ),
    ];
  }

  /// The student's actions, kept off the page: change subjects, turn them off here, remove them from the tuition. The
  /// account is the student's own, so nothing here changes their password.
  Future<void> _menu(Map<String, dynamic> s, int written) async {
    final active = s['active'] == true;
    final inCourses = (s['courses'] as List? ?? const []).length;
    final pick = await showCentredCard<String>(
      context,
      title: '${s['display_name']}',
      subtitle: 'Login ${s['username']}${inCourses > 0 ? ' · in ${f.count(inCourses, 'course')}' : ''}',
      builder: (ctx) => Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        if (widget.courseId != null) _MenuRow(icon: Ph.userMinus, label: 'Remove from this course', onTap: () => Navigator.of(ctx).pop('leave')),
        // Subjects decide a person's groups: someone with no class (only in courses) has none to change.
        if (s['class_level'] != null) _MenuRow(icon: Ph.pencilSimple, label: 'Change subjects', onTap: () => Navigator.of(ctx).pop('subjects')),
        _MenuRow(
          icon: active ? Ph.prohibit : Ph.checkCircle,
          label: active ? 'Turn off in this tuition' : 'Turn back on',
          onTap: () => Navigator.of(ctx).pop('active'),
        ),
        _MenuRow(icon: Ph.trash, label: 'Remove from the tuition', destructive: true, last: true, onTap: () => Navigator.of(ctx).pop('delete')),
      ]),
    );
    if (!mounted) return;
    switch (pick) {
      case 'leave':
        await _leaveCourse(s);
      case 'subjects':
        await _editSubjects(s);
      case 'active':
        await _toggleActive(s);
      case 'delete':
        await _delete(s, written);
    }
  }

  bool _allChapters = false;
  bool _allTests = false;

  @override
  Widget build(BuildContext context) {
    final d = _d;
    if (d == null) {
      return PushedPanel(title: 'Student', children: [
        if (_error != null) ErrorState(message: _error!, onRetry: _load) else const LoadingState(rows: 3),
      ]);
    }
    final s = Map<String, dynamic>.from(d['student']);
    final attempts = (d['attempts'] as List).cast<Map<String, dynamic>>();
    final done = attempts.where((a) => a['submitted_at'] != null).toList();
    final chapters = (d['chapters'] as List).cast<Map<String, dynamic>>();
    final missed = (d['missed'] as List).cast<Map<String, dynamic>>();
    final avg = done.isEmpty
        ? null
        : done.map((a) => (a['score'] as num) / max((a['max_score'] as num), 1)).reduce((x, y) => x + y) / done.length;
    final lastSeen = f.parseTime(s['last_seen_at']);
    final subjects = subjectNames(s['subjects']);

    // Weakest chapters first: that is where the tutor can help. A chapter the student has down is not a weakness.
    double ratio(Map<String, dynamic> c) => (c['correct'] as int) / max(c['total'] as int, 1);
    final byWeakness = [...chapters]..sort((a, b) => ratio(a).compareTo(ratio(b)));
    final weak = byWeakness.where((c) => ratio(c) < 0.8).take(3).toList();
    final chaptersShown = _allChapters ? byWeakness : weak;

    // Written and missed tests in one list, newest first.
    final items = <(DateTime, Widget)>[
      for (final a in attempts)
        (
          f.parseTime(a['submitted_at'] ?? a['started_at']) ?? DateTime.now(),
          RowTile(
            title: '${a['title']}${(a['attempt_no'] as int) > 1 ? ' (retake)' : ''}',
            meta: a['submitted_at'] == null
                ? 'Writing now'
                : 'Handed in ${f.when(f.parseTime(a['submitted_at'])!)}'
                    ' · ${f.duration(f.parseTime(a['submitted_at'])!.difference(f.parseTime(a['started_at'])!).inSeconds)}',
            trailing: a['submitted_at'] == null
                ? const TagChip('Writing', tone: Tone.warning)
                : Text('${f.marks(a['score'])}/${f.marks(a['max_score'])}', style: numStyle(size: 15)),
            chevron: a['submitted_at'] != null,
            onTap: a['submitted_at'] == null ? null : () => context.push('/t/attempts/${a['id']}'),
          ),
        ),
      for (final m in missed)
        (
          f.parseTime(m['closes_at']) ?? DateTime.now(),
          RowTile(title: '${m['title']}', meta: 'Closed ${f.whenDate(f.parseTime(m['closes_at'])!)}', trailing: const TagChip('Missed', tone: Tone.danger)),
        ),
    ]..sort((a, b) => b.$1.compareTo(a.$1));
    final testsShown = _allTests ? items : items.take(6).toList();

    Widget toggle(String label, VoidCallback onTap) => Pressable(
          label: label,
          onTap: onTap,
          child: Text(label, style: chipStyle.copyWith(color: muted, fontWeight: FontWeight.w600)),
        );

    return PushedPanel(
      onRefresh: _load,
      kicker: widget.courseId != null
          // Turned off here only: the login is the student's own and still works.
          ? ['Course', if (widget.courseName != null && widget.courseName!.isNotEmpty) widget.courseName!, if (s['active'] != true) 'turned off'].join(' · ')
          : [className(s['class_level']), ...subjects, if (s['active'] != true) 'turned off'].where((p) => p.isNotEmpty).join(' · '),
      title: '${s['display_name']}',
      headerTrailing: CircleBtn(icon: Ph.dotsThreeVertical, label: 'More', onTap: () => _menu(s, done.length)),
      children: [
        const SizedBox(height: 22),
        Reveal(
          child: MeasurementCard(
            label: 'Average marks',
            value: avg == null ? '-' : '${(avg * 100).round()}',
            countTo: avg == null ? null : (avg * 100).round(),
            unit: avg == null ? null : '%',
            fraction: avg,
            note: '${f.count(done.length, 'test')} written · ${missed.length} missed'
                '${lastSeen == null ? '' : ' · last seen ${f.relative(lastSeen)}'}',
          ),
        ),
        ..._attendance(d['attendance']),
        ..._fee(d['fee'], Map<String, dynamic>.from(d['student'] as Map)),
        const SizedBox(height: gapRow),
        // A picture of the month for the parents, to send on WhatsApp (parent_report.dart).
        SecondaryButton('Report for parents', icon: Ph.chartBar, onTap: () {
          final q = {
            if (widget.courseId != null) 'course': widget.courseId!,
            if (widget.courseName != null && widget.courseName!.isNotEmpty) 'name': widget.courseName!,
          };
          context.push(Uri(path: '/t/students/${widget.id}/report', queryParameters: q.isEmpty ? null : q).toString());
        }),
        if (chapters.isNotEmpty) ...[
          SectionRule(
            _allChapters ? 'Chapters' : 'Weakest chapters',
            padding: const EdgeInsets.fromLTRB(0, 26, 0, 11),
            trailing: chapters.length > weak.length ? toggle(_allChapters ? 'Show fewer' : 'All ${chapters.length}', () => setState(() => _allChapters = !_allChapters)) : null,
          ),
          if (chaptersShown.isEmpty)
            Text('None below 80%.', style: bodyStyle.copyWith(color: muted))
          else
          AnimatedSize( // motion: approved
            duration: const Duration(milliseconds: 260),
            curve: Curves.easeOutCubic,
            alignment: Alignment.topCenter,
            child: Surface(
              shadow: e1,
              padding: const EdgeInsets.fromLTRB(17, 6, 17, 6),
              child: Column(children: [
                for (final c in chaptersShown)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 10),
                    child: Row(children: [
                      Expanded(flex: 5, child: Text('${c['chapter']}', style: rowTitleStyle, maxLines: 1, overflow: TextOverflow.ellipsis)),
                      const SizedBox(width: 12),
                      Expanded(flex: 4, child: Track(ratio(c), height: 6)),
                      const SizedBox(width: 12),
                      SizedBox(width: 46, child: Text(f.percent(ratio(c)), style: numStyle(size: 13), textAlign: TextAlign.right)),
                    ]),
                  ),
              ]),
            ),
          ),
        ],
        SectionRule(
          'Tests',
          count: items.length,
          padding: const EdgeInsets.fromLTRB(0, 26, 0, 11),
          trailing: items.length > 6 ? toggle(_allTests ? 'Show fewer' : 'All ${items.length}', () => setState(() => _allTests = !_allTests)) : null,
        ),
        if (items.isEmpty)
          Text('No tests yet.', style: bodyStyle.copyWith(color: muted))
        else
          for (final (i, it) in testsShown.indexed) ...[if (i > 0) const SizedBox(height: gapRow), it.$2],
        // The username, for a student who forgot it. Their password is theirs alone: no tutor can see or change it.
        const SectionRule('Login', padding: EdgeInsets.fromLTRB(0, 26, 0, 11)),
        Surface(
          shadow: e1,
          padding: const EdgeInsets.fromLTRB(17, 14, 17, 14),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Username', style: labelStyle),
            const SizedBox(height: 3),
            Text('${s['username']}', style: numStyle(size: 15, weight: FontWeight.w600)),
          ]),
        ),
      ],
    );
  }
}

/// One action in the student's menu card.
class _MenuRow extends StatelessWidget {
  const _MenuRow({required this.icon, required this.label, required this.onTap, this.destructive = false, this.last = false});
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final bool destructive;
  final bool last;

  @override
  Widget build(BuildContext context) {
    final tint = destructive ? danger : ink;
    return Pressable(
      label: label,
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.fromLTRB(4, 14, 4, 14),
        decoration: last ? null : BoxDecoration(border: Border(bottom: BorderSide(color: hairline))),
        child: Row(children: [
          Icon(icon, size: 20, color: destructive ? danger : muted),
          const SizedBox(width: 14),
          Expanded(child: Text(label, style: rowTitleStyle.copyWith(color: tint))),
        ]),
      ),
    );
  }
}
