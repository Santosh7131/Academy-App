import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/format.dart' as f;
import '../../core/session.dart';
import '../../core/share_text.dart';
import '../../theme.dart';
import '../../ui/kit.dart';
import 'common.dart';

// Attendance (api/src/routes/attendance.ts): a class's register for a day, everyone marked here until the tutor taps the
// ones who are away. A class is a group (a class and a subject) or a course. The app keeps no phone numbers, so a parent
// is told through the share sheet, with a message ready for the tutor to send on WhatsApp or anywhere else.

int _n(Object? v) => v is num ? v.toInt() : int.tryParse('$v') ?? 0;

String _enc(String s) => Uri.encodeComponent(s);

/// A section's heading inside the page's own padding.
const _rule = EdgeInsets.fromLTRB(0, 4, 0, 10);

/// Which class a register is for, as the server's query and as the app's own links.
class ClassRef {
  const ClassRef.group(int this.classLevel, String this.subjectId) : courseId = null;
  const ClassRef.course(String this.courseId)
      : classLevel = null,
        subjectId = null;

  final int? classLevel;
  final String? subjectId;
  final String? courseId;

  String get query => courseId != null ? 'course_id=$courseId' : 'class_level=$classLevel&subject_id=$subjectId';
  Map<String, Object> get body => courseId != null ? {'course_id': courseId!} : {'class_level': classLevel!, 'subject_id': subjectId!};

  /// The app's own link to a register: [name] is the class's name, shown as the page's title.
  String link(String name, {String? day, String? month}) => '/t/attendance${month != null ? '/month' : ''}?'
      '${courseId != null ? 'course=$courseId' : 'class=$classLevel&subject=$subjectId'}&name=${_enc(name)}'
      '${day != null ? '&day=$day' : ''}${month != null ? '&month=$month' : ''}';
}

/// The message a parent is sent about a child who was away: the child, the class, the day and the tuition, signed by the tuition.
String awayMessage({required String student, required String className, required String day, required String today}) {
  final when = day == today ? 'today, ${f.shortDate(f.dayOf(day))}' : 'on ${f.shortDate(f.dayOf(day))}';
  final tuition = session.tuitionName;
  return 'Dear parent, $student was not at $className $when. Please let us know if anything is wrong.\n\n$tuition';
}

/// The line on a group's or course's page that opens today's register, saying how it stands.
class AttendanceButton extends StatelessWidget {
  const AttendanceButton({super.key, required this.today, required this.onTap});

  /// The page's `attendance_today`: taken or not, and how many were here and away.
  final Map<String, dynamic>? today;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = today;
    final taken = t?['taken'] == true;
    final here = _n(t?['present']);
    final away = _n(t?['absent']);
    return SecondaryButton(
      taken ? 'Attendance · $here of ${here + away} here today' : 'Take attendance',
      icon: Ph.listChecks,
      onTap: onTap,
    );
  }
}

// ---------------------------------------------------------------- one day's register

class AttendanceScreen extends StatefulWidget {
  const AttendanceScreen({super.key, required this.ref, required this.name, this.day});

  final ClassRef ref;

  /// The class's name: "9th Maths", or the course's.
  final String name;

  /// YYYY-MM-DD; none means today.
  final String? day;

  @override
  State<AttendanceScreen> createState() => _AttendanceScreenState();
}

class _AttendanceScreenState extends State<AttendanceScreen> {
  Map<String, dynamic>? _d;
  String? _error;
  String? _day;

  /// The students marked away on this phone, not yet saved, or as saved.
  final _away = <String>{};

  /// Whether the marks on screen differ from the register saved.
  bool _changed = false;

  /// Said when a browser with no share sheet copied a message instead.
  String? _copied;
  bool _busy = false;

  /// The students away on the register just saved, to tell their parents.
  List<Map<String, dynamic>>? _saved;

  @override
  void initState() {
    super.initState();
    _day = widget.day;
    _load();
  }

  List<Map<String, dynamic>> get _students => ((_d?['students'] as List?) ?? const []).cast<Map<String, dynamic>>();
  List<Map<String, dynamic>> get _inClass => _students.where((s) => s['in_class'] == true).toList();
  String get _today => '${_d?['today'] ?? f.dayKey(DateTime.now())}';

  Future<void> _load() async {
    try {
      final d = Map<String, dynamic>.from(await api.get('/teacher/attendance?${widget.ref.query}${_day != null ? '&day=$_day' : ''}'));
      if (!mounted) return;
      setState(() {
        _d = d;
        _day = '${d['day']}';
        _error = null;
        _away
          ..clear()
          ..addAll([for (final s in _students) if (s['in_class'] == true && s['present'] == false) '${s['id']}']);
        _changed = false;
        _saved = null;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _goTo(String day) async {
    if (_changed) {
      final leave = await confirmCard(context, title: 'Leave without saving?', body: 'The marks on this register have not been saved.', confirm: 'Leave');
      if (!leave || !mounted) return;
    }
    setState(() {
      _day = day;
      _d = null;
    });
    await _load();
  }

  Future<void> _pickDay() async {
    final today = f.dayOf(_today);
    final picked = await showDatePicker(
      context: context,
      initialDate: f.dayOf(_day ?? _today),
      firstDate: today.subtract(const Duration(days: 365)),
      lastDate: today,
      helpText: 'Register for',
    );
    if (picked != null && mounted) await _goTo(f.dayKey(picked));
  }

  void _toggle(String id) => setState(() {
        if (!_away.remove(id)) _away.add(id);
        _changed = true;
        _saved = null;
      });

  Future<void> _save() async {
    setState(() => _busy = true);
    try {
      final r = Map<String, dynamic>.from(await api.put('/teacher/attendance', {...widget.ref.body, 'day': _day, 'absent': _away.toList()}));
      if (!mounted) return;
      final away = ((r['absent'] as List?) ?? const []).cast<Map<String, dynamic>>();
      await _load();
      if (mounted) setState(() => _saved = away);
    } on ApiException catch (e) {
      if (mounted) showProblem(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _takeAway() async {
    final yes = await confirmCard(
      context,
      title: 'Take this register away?',
      body: "${f.dayTitle(f.dayOf(_day!))}'s register for ${widget.name} goes, with every mark on it.",
      confirm: 'Take it away',
      destructive: true,
    );
    if (!yes || !mounted) return;
    try {
      await api.delete('/teacher/attendance?${widget.ref.query}&day=$_day');
      if (mounted) await _load();
    } on ApiException catch (e) {
      if (mounted) showProblem(context, e);
    }
  }

  Future<void> _tell(Map<String, dynamic> s) async {
    final copied = await shareText(awayMessage(student: '${s['display_name']}', className: widget.name, day: _day!, today: _today));
    if (copied && mounted) setState(() => _copied = "${s['display_name']}'s message is copied. Paste it into WhatsApp or a message.");
  }

  @override
  Widget build(BuildContext context) {
    final d = _d;
    final inClass = _inClass;
    final here = inClass.length - _away.length;
    final taken = d?['register'] != null;
    return PushedPanel(
      kicker: 'Attendance',
      title: widget.name,
      onRefresh: _load,
      footer: d == null || inClass.isEmpty
          ? null
          : PrimaryButton(
              taken && !_changed ? 'Saved · $here here, ${_away.length} away' : 'Save · $here here, ${_away.length} away',
              busy: _busy,
              onTap: taken && !_changed ? null : _save,
              disabledReason: taken && !_changed ? 'Tap a student to change their mark.' : null,
            ),
      children: [
        if (d == null && _error != null)
          ErrorState(message: _error!, onRetry: _load)
        else if (d == null)
          const LoadingState(rows: 4)
        else ...[
          const SizedBox(height: 12),
          _dayBar(),
          const SizedBox(height: 14),
          Fig(
            taken
                ? 'Taken${d['register']['taken_by'] == null ? '' : ' by ${d['register']['taken_by']}'}'
                    '${d['register']['taken_at'] == null ? '' : ' at ${f.time(f.parseTime(d['register']['taken_at'])!)}'}. Tap anyone to change their mark.'
                : 'Not taken yet. Everyone is marked here; tap anyone who is away.',
            style: bodyStyle.copyWith(color: muted),
          ),
          const SizedBox(height: 14),
          if (inClass.isEmpty)
            Fig('Nobody is in this class yet. Invite students with its link, then take the register.', style: bodyStyle.copyWith(color: muted))
          else
            for (final (i, s) in inClass.indexed) ...[
              if (i > 0) const SizedBox(height: gapRow),
              _mark(s),
            ],
          if (_saved != null && _saved!.isNotEmpty) ...[
            const SizedBox(height: 22),
            const SectionRule('Tell parents', padding: _rule),
            Fig('A message is ready for each one; choose the parent on WhatsApp or anywhere else.', style: labelStyle.copyWith(color: muted)),
            if (_copied != null) ...[const SizedBox(height: 10), InlineNotice(_copied!, tone: Tone.success, icon: Ph.checkCircle)],
            const SizedBox(height: 10),
            for (final (i, s) in _saved!.indexed) ...[
              if (i > 0) const SizedBox(height: gapRow),
              RowTile(
                leading: AppAvatar(name: '${s['display_name']}', seed: '${s['id']}'),
                title: '${s['display_name']}',
                meta: 'Away ${_day == _today ? 'today' : f.shortDate(f.dayOf(_day!))}',
                trailing: Icon(Ph.shareNetwork, size: 20, color: ink),
                onTap: () => _tell(s),
              ),
            ],
          ] else if (_saved != null) ...[
            const SizedBox(height: 18),
            InlineNotice('Saved. Everyone was here.', tone: Tone.success, icon: Ph.checkCircle),
          ],
          ..._leftClass(),
          const SizedBox(height: 22),
          Center(child: TextAction("See this month's registers", onTap: () => context.push(widget.ref.link(widget.name, month: _day!.substring(0, 7))))),
          if (taken) ...[
            const SizedBox(height: 14),
            Center(child: TextAction('Take this register away', color: danger, onTap: _takeAway)),
          ],
        ],
      ],
    );
  }

  /// The day, with the days before and after it; tapping the day picks another.
  Widget _dayBar() {
    final day = _day!;
    final isToday = day == _today;
    return Row(children: [
      CircleBtn(icon: Ph.caretLeft, label: 'The day before', onTap: () => _goTo(f.dayKey(f.dayOf(day).subtract(const Duration(days: 1))))),
      Expanded(
        child: Pressable(
          onTap: _pickDay,
          label: 'Choose the day',
          child: Column(children: [
            Fig(f.dayTitle(f.dayOf(day)), style: rowTitleStyle, textAlign: TextAlign.center),
            Fig('Tap to choose another day', style: labelStyle.copyWith(color: faint), textAlign: TextAlign.center),
          ]),
        ),
      ),
      CircleBtn(
        icon: Ph.caretRight,
        label: 'The day after',
        onTap: isToday ? null : () => _goTo(f.dayKey(f.dayOf(day).add(const Duration(days: 1)))),
      ),
    ]);
  }

  Widget _mark(Map<String, dynamic> s) {
    final id = '${s['id']}';
    final away = _away.contains(id);
    return RowTile(
      leading: AppAvatar(name: '${s['display_name']}', seed: id),
      title: '${s['display_name']}',
      meta: away ? 'Away' : 'Here',
      metaColor: away ? danger : success,
      trailing: Semantics(
        label: away ? '${s['display_name']} is away. Tap to mark here.' : '${s['display_name']} is here. Tap to mark away.',
        child: Icon(away ? Ph.prohibit : Ph.checkCircle, size: 24, color: away ? danger : success),
      ),
      onTap: () => _toggle(id),
    );
  }

  /// Students on this register who have left the class since: their marks stay as they were.
  List<Widget> _leftClass() {
    final left = _students.where((s) => s['in_class'] != true).toList();
    if (left.isEmpty) return const [];
    return [
      const SizedBox(height: 22),
      const SectionRule('No longer in this class', padding: _rule),
      for (final (i, s) in left.indexed) ...[
        if (i > 0) const SizedBox(height: gapRow),
        RowTile(
          leading: AppAvatar(name: '${s['display_name']}', seed: '${s['id']}'),
          title: '${s['display_name']}',
          meta: s['present'] == true ? 'Here' : 'Away',
          metaColor: s['present'] == true ? success : danger,
        ),
      ],
    ];
  }
}

// ---------------------------------------------------------------- a month of registers

class AttendanceMonthScreen extends StatefulWidget {
  const AttendanceMonthScreen({super.key, required this.ref, required this.name, this.month});

  final ClassRef ref;
  final String name;

  /// YYYY-MM; none means this month.
  final String? month;

  @override
  State<AttendanceMonthScreen> createState() => _AttendanceMonthScreenState();
}

class _AttendanceMonthScreenState extends State<AttendanceMonthScreen> {
  Map<String, dynamic>? _d;
  String? _error;
  String? _month;

  @override
  void initState() {
    super.initState();
    _month = widget.month;
    _load();
  }

  Future<void> _load() async {
    try {
      final d = Map<String, dynamic>.from(await api.get('/teacher/attendance/month?${widget.ref.query}${_month != null ? '&month=$_month' : ''}'));
      if (mounted) {
        setState(() {
          _d = d;
          _month = '${d['month']}';
          _error = null;
        });
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  String _shift(String month, int by) {
    final p = month.split('-').map(int.parse).toList();
    final d = DateTime(p[0], p[1] + by);
    return '${d.year}-${d.month.toString().padLeft(2, '0')}';
  }

  Future<void> _goTo(String month) async {
    setState(() {
      _month = month;
      _d = null;
    });
    await _load();
  }

  Future<void> _open(String day) async {
    await context.push(widget.ref.link(widget.name, day: day));
    if (mounted) _load();
  }

  @override
  Widget build(BuildContext context) {
    final d = _d;
    final days = ((d?['days'] as List?) ?? const []).cast<Map<String, dynamic>>();
    final month = _month;
    final thisMonth = '${d?['today'] ?? f.dayKey(DateTime.now())}'.substring(0, 7);
    final classes = days.length;
    final here = days.fold<int>(0, (a, x) => a + _n(x['present']));
    final all = days.fold<int>(0, (a, x) => a + _n(x['present']) + _n(x['absent']));
    return PushedPanel(
      kicker: 'Attendance',
      title: widget.name,
      onRefresh: _load,
      children: [
        if (d == null && _error != null)
          ErrorState(message: _error!, onRetry: _load)
        else if (d == null || month == null)
          const LoadingState(rows: 4)
        else ...[
          const SizedBox(height: 12),
          Row(children: [
            CircleBtn(icon: Ph.caretLeft, label: 'The month before', onTap: () => _goTo(_shift(month, -1))),
            Expanded(child: Fig(_monthName(month), style: rowTitleStyle, textAlign: TextAlign.center)),
            CircleBtn(icon: Ph.caretRight, label: 'The month after', onTap: month == thisMonth ? null : () => _goTo(_shift(month, 1))),
          ]),
          const SizedBox(height: 14),
          if (days.isEmpty)
            Fig('No registers taken this month.', style: bodyStyle.copyWith(color: muted))
          else ...[
            Fig(
              '${f.count(classes, 'register')} taken. ${all == 0 ? '' : 'Students were here ${f.percent(here / all)} of the time.'}',
              style: bodyStyle.copyWith(color: muted),
            ),
            const SizedBox(height: 12),
            for (final (i, x) in days.indexed) ...[
              if (i > 0) const SizedBox(height: gapRow),
              RowTile(
                title: f.dayTitle(f.dayOf('${x['day']}')),
                meta: '${_n(x['present'])} here · ${_n(x['absent'])} away',
                metaColor: _n(x['absent']) > 0 ? null : success,
                chevron: true,
                onTap: () => _open('${x['day']}'),
              ),
            ],
          ],
        ],
      ],
    );
  }

  String _monthName(String month) {
    final p = month.split('-').map(int.parse).toList();
    const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return '${names[p[1] - 1]} ${p[0]}';
  }
}
