import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/api.dart';
import '../../core/changes.dart';
import '../../core/credit.dart' show inrWhole;
import '../../core/fees.dart';
import '../../core/format.dart' as f;
import '../../core/levels.dart';
import '../../core/session.dart';
import '../../core/share_text.dart';
import '../../core/web_bits.dart' show saveOrShareFile, savesFiles;
import '../../theme.dart';
import '../../ui/kit.dart';
import 'common.dart';
import 'parent_report.dart' show reportPicture;

// Fees (api/src/routes/fees.ts), for the tuition's owner: each month's fees, who has paid and who has not; payments students
// say they made by UPI, to confirm; a student's fees, with a payment recorded in two taps and a receipt to share; a fee set for
// a student, a group or a course; and the UPI id parents pay to. The money goes straight to the tutor: the app never holds it.

const _rule = EdgeInsets.fromLTRB(0, 4, 0, 10);

/// Back to where the screen was opened from, or to Fees when it was opened on its own (from a notification, say).
void _done(BuildContext context) => context.canPop() ? context.pop(true) : context.go('/t/fees');

List<Map<String, dynamic>> _list(Object? v) => [for (final x in (v as List?) ?? const []) Map<String, dynamic>.from(x as Map)];

Color _toneColor(MonthTone t) => switch (t) {
  MonthTone.paid => success,
  MonthTone.waiting => warning,
  MonthTone.late => danger,
  MonthTone.owed => muted,
};

/// Who a fee is being set for: some students, a group, or a course.
class FeeTarget {
  const FeeTarget.students(List<String> this.studentIds, {required this.label, this.fee, this.dueDay})
      : classLevel = null,
        subjectId = null,
        courseId = null;
  const FeeTarget.group(int this.classLevel, String this.subjectId, {required this.label})
      : studentIds = null,
        courseId = null,
        fee = null,
        dueDay = null;
  const FeeTarget.course(String this.courseId, {required this.label})
      : studentIds = null,
        classLevel = null,
        subjectId = null,
        fee = null,
        dueDay = null;

  final List<String>? studentIds;
  final int? classLevel;
  final String? subjectId;
  final String? courseId;

  /// "Asha Rao", "10th Maths", "5 students with no fee".
  final String label;

  /// The fee and due day now, to start from when changing one student's.
  final int? fee;
  final int? dueDay;

  Map<String, Object> get body => studentIds != null
      ? {'student_ids': studentIds!}
      : courseId != null
          ? {'course_id': courseId!}
          : {'class_level': classLevel!, 'subject_id': subjectId!};
}

/// Asks who a fee is for: the students with none yet, or a group or a course. Null when the tutor backs out.
Future<FeeTarget?> pickFeeTarget(BuildContext context, {List<Map<String, dynamic>> noFee = const []}) async {
  try {
    final groups = _list((await api.get('/teacher/groups'))['groups']);
    final courses = _list((await api.get('/teacher/courses'))['courses']);
    if (!context.mounted) return null;
    final options = <Choice<FeeTarget>>[
      if (noFee.isNotEmpty)
        Choice(FeeTarget.students([for (final s in noFee) '${s['id']}'], label: '${f.count(noFee.length, 'student')} with no fee'), 'Everyone with no fee yet', count: noFee.length),
      for (final g in groups)
        if (paiseOf(g['students']) > 0)
          Choice(
            FeeTarget.group(paiseOf(g['class_level']), '${g['subject_id']}', label: groupName(paiseOf(g['class_level']), '${g['subject']}')),
            groupName(paiseOf(g['class_level']), '${g['subject']}'),
            count: paiseOf(g['students']),
          ),
      for (final c in courses)
        if (paiseOf(c['people']) > 0) Choice(FeeTarget.course('${c['id']}', label: '${c['name']}'), '${c['name']}', count: paiseOf(c['people'])),
    ];
    if (options.isEmpty) {
      await showCentredCard<void>(
        context,
        title: 'No students yet',
        builder: (ctx) => Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Fig('Add students to a group or a course first. Then their fee can be set here.', style: bodyStyle),
          const SizedBox(height: 18),
          PrimaryButton('OK', onTap: () => Navigator.of(ctx).pop()),
        ]),
      );
      return null;
    }
    final picked = await showChoices<FeeTarget>(
      context,
      title: 'Set a fee for',
      subtitle: 'Everyone in it gets the same monthly fee. You can change one student\'s on their page.',
      options: options,
      selected: null,
    );
    return picked?.value;
  } on ApiException catch (e) {
    if (context.mounted) await showProblem(context, e);
    return null;
  }
}

// ---------------------------------------------------------------- a month's fees

class FeesScreen extends StatefulWidget {
  const FeesScreen({super.key, this.month});

  /// YYYY-MM; none means this month.
  final String? month;

  @override
  State<FeesScreen> createState() => _FeesScreenState();
}

class _FeesScreenState extends State<FeesScreen> with WidgetsBindingObserver, AutoRefresh<FeesScreen> {
  Map<String, dynamic>? _d;
  String? _error;
  String? _month;
  String? _notice;

  /// The payment being confirmed or turned down: its buttons wait for the answer.
  String? _acting;

  @override
  Set<Area> get refreshAreas => {Area.fees};

  // Students say they have paid at any time: look again every minute while this is on screen.
  @override
  Duration? get pollEvery => const Duration(minutes: 1);

  @override
  Future<void> refreshQuietly() => _load(quiet: true);

  @override
  void initState() {
    super.initState();
    _month = widget.month;
    _load();
  }

  Future<void> _load({bool quiet = false}) async {
    markLoaded();
    try {
      final d = Map<String, dynamic>.from(await api.get('/teacher/fees${_month != null ? '?month=$_month' : ''}'));
      if (mounted) {
        setState(() {
          _d = d;
          _month = '${d['month']}';
          _error = null;
        });
      }
    } on ApiException catch (e) {
      if (mounted && !quiet) setState(() => _error = e.message);
    }
  }

  Future<void> _goTo(String month) async {
    setState(() {
      _month = month;
      _d = null;
      _notice = null;
    });
    await _load();
  }

  Future<void> _push(String path, {Object? extra}) async {
    await context.push(path, extra: extra);
    if (mounted) _load(quiet: true);
  }

  Future<void> _setFees(List<Map<String, dynamic>> noFee) async {
    final target = await pickFeeTarget(context, noFee: noFee);
    if (target != null && mounted) await _push('/t/fees/set', extra: target);
  }

  Future<void> _confirm(Map<String, dynamic> p) async {
    setState(() => _acting = '${p['id']}');
    try {
      final r = await api.post('/teacher/fees/payments/${p['id']}/confirm');
      if (mounted) setState(() => _notice = 'Confirmed. ${p['student_name']} gets receipt ${r['payment']?['receipt_no']}.');
    } on ApiException catch (e) {
      if (mounted) await showProblem(context, e);
    } finally {
      if (mounted) setState(() => _acting = null);
    }
    if (mounted) _load(quiet: true);
  }

  Future<void> _turnDown(Map<String, dynamic> p) async {
    final ok = await confirmCard(
      context,
      title: 'Not received?',
      body: '${p['student_name']} said they paid ${inrWhole(paiseOf(p['amount_paise']))} for ${monthName('${p['month']}')}. '
          'If it has not reached you, this takes it away and tells them to check with you.',
      confirm: 'Not received',
      destructive: true,
    );
    if (!ok || !mounted) return;
    setState(() => _acting = '${p['id']}');
    try {
      await api.delete('/teacher/fees/payments/${p['id']}');
      if (mounted) setState(() => _notice = 'Taken away. ${p['student_name']} is asked to check with you.');
    } on ApiException catch (e) {
      if (mounted) await showProblem(context, e);
    } finally {
      if (mounted) setState(() => _acting = null);
    }
    if (mounted) _load(quiet: true);
  }

  @override
  Widget build(BuildContext context) {
    final d = _d;
    final month = _month;
    final thisMonth = '${d?['this_month'] ?? ''}';
    final t = ((d?['totals'] as Map?) ?? const {}).cast<String, dynamic>();
    final students = _list(d?['students']);
    final claims = _list(d?['claims']);
    final others = _list(d?['others']);
    final noFee = _list(d?['no_fee']);
    // Not paid, the late ones first; a month waiting to be confirmed is with its payment above.
    final owed = students.where((s) => s['status'] == 'unpaid').toList()
      ..sort((a, b) => (b['late'] == true ? 1 : 0).compareTo(a['late'] == true ? 1 : 0));
    final paid = students.where((s) => s['status'] == 'paid' || s['status'] == 'none').toList();
    final expected = paiseOf(t['expected']);
    final collected = paiseOf(t['collected']);
    final counts = [
      if (paiseOf(t['paid']) > 0) '${paiseOf(t['paid'])} paid',
      if (paiseOf(t['unpaid']) > 0) '${paiseOf(t['unpaid'])} to pay',
      if (paiseOf(t['late']) > 0) '${paiseOf(t['late'])} late',
      if (paiseOf(t['waiting']) > 0) '${inrWhole(paiseOf(t['waiting']))} to confirm',
    ];

    return PushedPanel(
      kicker: session.tuitionName,
      title: 'Fees',
      onRefresh: _load,
      children: [
        if (d == null && _error != null)
          ErrorState(message: _error!, onRetry: _load)
        else if (d == null || month == null)
          const LoadingState(rows: 4)
        else ...[
          const SizedBox(height: 12),
          Row(children: [
            CircleBtn(icon: Ph.caretLeft, label: 'The month before', onTap: () => _goTo(shiftMonth(month, -1))),
            Expanded(child: Fig(monthName(month), style: rowTitleStyle, textAlign: TextAlign.center)),
            CircleBtn(icon: Ph.caretRight, label: 'The month after', onTap: month.compareTo(thisMonth) > 0 ? null : () => _goTo(shiftMonth(month, 1))),
          ]),
          const SizedBox(height: 14),
          if (_notice != null) ...[InlineNotice(_notice!, tone: Tone.success, icon: Ph.checkCircle), const SizedBox(height: 12)],
          if (expected > 0 || collected > 0) _Summary(collected: collected, expected: expected, note: counts.join(' · ')),
          if (d['upi'] == null) ...[
            const SizedBox(height: 12),
            RowTile(
              leading: Icon(Ph.currencyInr, size: 22, color: ink),
              title: 'Add your UPI id',
              meta: 'Parents can then pay you from the app',
              chevron: true,
              onTap: () => _push('/t/fees/upi'),
            ),
          ],
          if (claims.isNotEmpty) ...[
            SectionRule('To confirm', count: claims.length, padding: _rule.copyWith(top: 22)),
            for (final (i, p) in claims.indexed) ...[
              if (i > 0) const SizedBox(height: gapRow),
              _ClaimCard(p: p, busy: _acting == '${p['id']}', onConfirm: () => _confirm(p), onTurnDown: () => _turnDown(p)),
            ],
          ],
          if (owed.isNotEmpty) ...[
            SectionRule('Not paid', count: owed.length, padding: _rule.copyWith(top: 22)),
            for (final (i, s) in owed.indexed) ...[if (i > 0) const SizedBox(height: gapRow), _studentRow(s)],
          ],
          if (paid.isNotEmpty) ...[
            SectionRule('Paid', count: paid.length, padding: _rule.copyWith(top: 22)),
            for (final (i, s) in paid.indexed) ...[if (i > 0) const SizedBox(height: gapRow), _studentRow(s)],
          ],
          if (others.isNotEmpty) ...[
            SectionRule('No longer here', count: others.length, padding: _rule.copyWith(top: 22)),
            for (final (i, p) in others.indexed) ...[
              if (i > 0) const SizedBox(height: gapRow),
              RowTile(
                title: '${p['student_name']}',
                meta: p['status'] == 'claimed'
                    ? '${inrWhole(paiseOf(p['amount_paise']))} to confirm'
                    : '${inrWhole(paiseOf(p['amount_paise']))} · ${methodName(p['method'])} · Receipt ${p['receipt_no']}',
                chevron: p['status'] == 'confirmed',
                onTap: p['status'] == 'confirmed' ? () => _push('/t/fees/receipt', extra: p) : null,
              ),
            ],
          ],
          if (noFee.isNotEmpty) ...[
            SectionRule('No fee yet', count: noFee.length, padding: _rule.copyWith(top: 22)),
            RowTile(
              leading: Icon(Ph.plus, size: 22, color: ink),
              title: noFee.length == 1 ? 'Set a fee for ${noFee.first['display_name']}' : 'Set a fee for these ${noFee.length} students',
              meta: _names(noFee),
              chevron: true,
              onTap: () => _push(
                '/t/fees/set',
                extra: FeeTarget.students([for (final s in noFee) '${s['id']}'], label: noFee.length == 1 ? '${noFee.first['display_name']}' : f.count(noFee.length, 'student')),
              ),
            ),
          ],
          if (students.isEmpty && claims.isEmpty && others.isEmpty && noFee.isEmpty)
            const EmptyState(
              icon: Ph.currencyInr,
              title: 'No students yet',
              body: 'Once students join, set their monthly fee here and keep track of who has paid.',
            ),
          const SizedBox(height: 22),
          Center(child: TextAction('Set fees for a group or course', onTap: () => _setFees(noFee))),
          if (d['upi'] != null) Center(child: TextAction('UPI id: ${d['upi']['id']}', onTap: () => _push('/t/fees/upi'))),
        ],
      ],
    );
  }

  String _names(List<Map<String, dynamic>> people) {
    final names = [for (final p in people) '${p['display_name']}'];
    return names.length <= 3 ? names.join(', ') : '${names.take(2).join(', ')} and ${names.length - 2} more';
  }

  Widget _studentRow(Map<String, dynamic> s) {
    final line = monthLine(s);
    return RowTile(
      leading: AppAvatar(name: '${s['display_name']}', seed: '${s['id']}'),
      title: '${s['display_name']}${s['active'] == false ? ' (turned off)' : ''}',
      meta: line.text,
      metaColor: line.tone == MonthTone.owed ? null : _toneColor(line.tone),
      chevron: true,
      onTap: () => _push('/t/fees/students/${s['id']}?name=${Uri.encodeComponent('${s['display_name']}')}'),
    );
  }
}

/// The month's money: what has been paid of what is due, as a figure and a bar. Big sums shrink to fit one line, as rupees
/// in lakhs are long.
class _Summary extends StatelessWidget {
  const _Summary({required this.collected, required this.expected, required this.note});

  final int collected;
  final int expected;
  final String note;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 17),
        decoration: surface(radius: rHero, shadow: e3),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Paid so far', style: labelStyle),
          const SizedBox(height: 8),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
              Text(inrWhole(collected), style: numStyle(size: 34)),
              if (expected > 0) ...[const SizedBox(width: 6), Text('of ${inrWhole(expected)}', style: numStyle(size: 14, weight: FontWeight.w600, color: muted))],
            ]),
          ),
          if (expected > 0) ...[const SizedBox(height: 13), Track((collected / expected).clamp(0, 1).toDouble())],
          if (note.isNotEmpty) ...[const SizedBox(height: 11), Fig(note, style: bodyStyle.copyWith(color: muted), numColor: body)],
        ]),
      );
}

/// A payment a student says they made by UPI: who, how much, for which month, the reference they gave, and the two answers.
class _ClaimCard extends StatelessWidget {
  const _ClaimCard({required this.p, required this.busy, required this.onConfirm, required this.onTurnDown});

  final Map<String, dynamic> p;
  final bool busy;
  final VoidCallback onConfirm;
  final VoidCallback onTurnDown;

  @override
  Widget build(BuildContext context) {
    final at = f.parseTime(p['created_at']);
    return Surface(
      shadow: e1,
      padding: const EdgeInsets.fromLTRB(17, 15, 17, 14),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(child: Fig('${p['student_name']}', style: rowTitleStyle)),
          const SizedBox(width: 10),
          Text(inrWhole(paiseOf(p['amount_paise'])), style: numStyle(size: 17)),
        ]),
        const SizedBox(height: 4),
        Fig(
          [
            'Says they paid by UPI for ${monthName('${p['month']}')}',
            if (at != null) f.day(at),
          ].join(' · '),
          style: bodyStyle.copyWith(color: muted),
        ),
        if ('${p['reference'] ?? ''}'.isNotEmpty) ...[
          const SizedBox(height: 4),
          Text('Reference ${p['reference']}', style: numStyle(size: 13, weight: FontWeight.w600, color: body)),
        ],
        const SizedBox(height: 12),
        Fig('Check your UPI app or bank for it first.', style: labelStyle),
        const SizedBox(height: 10),
        Row(children: [
          Expanded(child: PrimaryButton('Confirm', busy: busy, onTap: busy ? null : onConfirm)),
          const SizedBox(width: 10),
          Expanded(child: SecondaryButton('Not received', onTap: busy ? null : onTurnDown)),
        ]),
      ]),
    );
  }
}

// ---------------------------------------------------------------- one student's fees

class FeeStudentScreen extends StatefulWidget {
  const FeeStudentScreen({super.key, required this.id, this.name});

  final String id;
  final String? name;

  @override
  State<FeeStudentScreen> createState() => _FeeStudentScreenState();
}

class _FeeStudentScreenState extends State<FeeStudentScreen> with WidgetsBindingObserver, AutoRefresh<FeeStudentScreen> {
  Map<String, dynamic>? _d;
  String? _error;
  String? _acting;

  /// A browser with no share sheet copied the reminder instead.
  bool _copied = false;

  @override
  Set<Area> get refreshAreas => {Area.fees};

  @override
  Future<void> refreshQuietly() => _load(quiet: true);

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load({bool quiet = false}) async {
    markLoaded();
    try {
      final d = Map<String, dynamic>.from(await api.get('/teacher/fees/students/${widget.id}'));
      if (mounted) {
        setState(() {
          _d = d;
          _error = null;
        });
      }
    } on ApiException catch (e) {
      if (mounted && !quiet) setState(() => _error = e.message);
    }
  }

  Future<void> _push(String path, {Object? extra}) async {
    await context.push(path, extra: extra);
    if (mounted) _load(quiet: true);
  }

  String get _name => '${_d?['student']?['display_name'] ?? widget.name ?? 'Student'}';

  Future<void> _remind(List<Map<String, dynamic>> owing) async {
    final text = feeReminder(
      student: _name,
      owing: owing.where((m) => m['status'] == 'unpaid').toList(),
      upi: (_d?['upi'] as Map?)?.cast<String, dynamic>(),
      tuition: session.tuitionName,
    );
    try {
      if (await shareText(text) && mounted) setState(() => _copied = true);
    } catch (e) {
      if (mounted) await showProblem(context, e);
    }
  }

  Future<void> _confirm(Map<String, dynamic> p) async {
    setState(() => _acting = '${p['id']}');
    try {
      final r = await api.post('/teacher/fees/payments/${p['id']}/confirm');
      if (mounted) await _push('/t/fees/receipt', extra: Map<String, dynamic>.from(r['payment'] as Map));
    } on ApiException catch (e) {
      if (mounted) await showProblem(context, e);
    } finally {
      if (mounted) setState(() => _acting = null);
    }
  }

  Future<void> _turnDown(Map<String, dynamic> p) async {
    final ok = await confirmCard(
      context,
      title: 'Not received?',
      body: '$_name said they paid ${inrWhole(paiseOf(p['amount_paise']))} for ${monthName('${p['month']}')}. '
          'If it has not reached you, this takes it away and tells them to check with you.',
      confirm: 'Not received',
      destructive: true,
    );
    if (!ok || !mounted) return;
    try {
      await api.delete('/teacher/fees/payments/${p['id']}');
    } on ApiException catch (e) {
      if (mounted) await showProblem(context, e);
    }
    if (mounted) _load(quiet: true);
  }

  @override
  Widget build(BuildContext context) {
    final d = _d;
    final months = _list(d?['months']);
    final payments = _list(d?['payments']);
    final claims = payments.where((p) => p['status'] == 'claimed').toList();
    final receipts = payments.where((p) => p['status'] == 'confirmed').toList();
    final owing = _list(d?['owing']);
    final fee = d?['fee'] == null ? null : paiseOf(d!['fee']);
    final left = paiseOf(d?['left']);
    return PushedPanel(
      kicker: _name,
      title: 'Fees',
      onRefresh: _load,
      footer: d == null
          ? null
          : PrimaryButton(
              'Record a payment',
              leadingIcon: Ph.plus,
              onTap: () => _push('/t/fees/record', extra: {'student': d['student'], 'months': months, 'fee': fee, 'this_month': d['this_month']}),
            ),
      children: [
        if (d == null && _error != null)
          ErrorState(message: _error!, onRetry: _load)
        else if (d == null)
          const LoadingState(rows: 4)
        else ...[
          const SizedBox(height: 16),
          RowTile(
            leading: Icon(Ph.currencyInr, size: 22, color: ink),
            title: fee == null ? (d['set'] == true ? 'No fee now' : 'No fee set') : '${inrWhole(fee)} a month',
            meta: fee == null ? 'Set a monthly fee' : 'Due on ${ordinalDay(paiseOf(d['due_day']))} of each month · Change',
            chevron: true,
            onTap: () => _push(
              '/t/fees/set',
              extra: FeeTarget.students([widget.id], label: _name, fee: fee, dueDay: d['due_day'] == null ? null : paiseOf(d['due_day'])),
            ),
          ),
          if (left > 0) ...[
            const SizedBox(height: 12),
            Surface(
              shadow: e1,
              padding: const EdgeInsets.fromLTRB(17, 15, 17, 15),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Text(inrWhole(left), style: numStyle(size: 28, color: owing.any((m) => m['late'] == true) ? danger : ink)),
                const SizedBox(height: 4),
                Fig(
                  'still to pay for ${monthsList([for (final m in owing.where((m) => m['status'] == 'unpaid')) '${m['month']}'])}',
                  style: bodyStyle.copyWith(color: muted),
                ),
                const SizedBox(height: 12),
                SecondaryButton('Remind the parents', icon: Ph.shareNetwork, onTap: () => _remind(owing)),
                if (_copied) ...[const SizedBox(height: 10), InlineNotice(copiedNotice, tone: Tone.success, icon: Ph.checkCircle)],
              ]),
            ),
          ],
          for (final p in claims) ...[
            const SizedBox(height: 12),
            _ClaimCard(p: {...p, 'student_name': _name}, busy: _acting == '${p['id']}', onConfirm: () => _confirm(p), onTurnDown: () => _turnDown(p)),
          ],
          if (months.isNotEmpty) ...[
            SectionRule('Months', padding: _rule.copyWith(top: 22)),
            for (final (i, m) in months.indexed) ...[
              if (i > 0) const SizedBox(height: gapRow),
              Builder(builder: (context) {
                final line = monthLine(m);
                return RowTile(
                  title: monthName('${m['month']}'),
                  meta: line.text,
                  metaColor: line.tone == MonthTone.owed ? null : _toneColor(line.tone),
                );
              }),
            ],
          ],
          if (receipts.isNotEmpty) ...[
            SectionRule('Payments', count: receipts.length, padding: _rule.copyWith(top: 22)),
            for (final (i, p) in receipts.indexed) ...[
              if (i > 0) const SizedBox(height: gapRow),
              RowTile(
                leading: Icon(Ph.receipt, size: 22, color: ink),
                title: '${inrWhole(paiseOf(p['amount_paise']))} · ${monthName('${p['month']}')}',
                meta: '${methodName(p['method'])} · ${f.shortDate(f.dayOf('${p['paid_on']}'))} · Receipt ${p['receipt_no']}',
                chevron: true,
                onTap: () => _push('/t/fees/receipt', extra: {...p, 'class_level': d['student']?['class_level']}),
              ),
            ],
          ],
        ],
      ],
    );
  }
}

// ---------------------------------------------------------------- setting a fee

class SetFeeScreen extends StatefulWidget {
  const SetFeeScreen({super.key, required this.target});

  final FeeTarget target;

  @override
  State<SetFeeScreen> createState() => _SetFeeScreenState();
}

class _SetFeeScreenState extends State<SetFeeScreen> {
  late final _fee = TextEditingController(text: widget.target.fee == null ? '' : '${widget.target.fee! ~/ 100}');
  late final _due = TextEditingController(text: '${widget.target.dueDay ?? 5}');
  var _next = false;
  var _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    // The button says what will be saved.
    _fee.addListener(_changed);
  }

  void _changed() => setState(() {});

  @override
  void dispose() {
    _fee.dispose();
    _due.dispose();
    super.dispose();
  }

  String get _thisMonth => DateFormat('yyyy-MM').format(DateTime.now());

  Future<void> _save() async {
    final rupees = int.tryParse(_fee.text.trim());
    final due = int.tryParse(_due.text.trim());
    if (rupees == null || rupees < 0) return setState(() => _error = 'Write the monthly fee in rupees, like 1500.');
    if (due == null || due < 1 || due > 28) return setState(() => _error = 'The fee can be due on a day from 1 to 28.');
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await api.put('/teacher/fees/rates', {
        ...widget.target.body,
        'fee_paise': rupees * 100,
        'due_day': due,
        'from': _next ? shiftMonth(_thisMonth, 1) : _thisMonth,
      });
      if (mounted) _done(context);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final rupees = int.tryParse(_fee.text.trim());
    final thisMonth = _thisMonth;
    return PushedPanel(
      kicker: widget.target.label,
      title: widget.target.fee == null ? 'Set a fee' : 'Change the fee',
      footer: PrimaryButton(
        rupees == null ? 'Save' : rupees == 0 ? 'Stop the fee' : 'Save ${inrWhole(rupees * 100)} a month',
        busy: _saving,
        onTap: _saving ? null : _save,
      ),
      children: [
        const SizedBox(height: 16),
        GroupedInputs(children: [
          NamedField(name: 'Monthly fee', controller: _fee, placeholder: 'Rupees, like 1500', keyboard: TextInputType.number, maxLength: 6),
          NamedField(name: 'Due on day', controller: _due, placeholder: '1 to 28', keyboard: TextInputType.number, maxLength: 2),
        ]),
        const SizedBox(height: 8),
        Fig('The day of the month it is due, from 1 to 28, so every month has it.', style: labelStyle),
        const SectionRule('Starting', padding: EdgeInsets.fromLTRB(0, 22, 0, 10)),
        SegmentedToggle(
          labels: [monthName(thisMonth), monthName(shiftMonth(thisMonth, 1))],
          index: _next ? 1 : 0,
          onChanged: (i) => setState(() => _next = i == 1),
        ),
        const SizedBox(height: 12),
        Fig(
          rupees == 0
              ? 'No fee from then on. The months before keep the fee they had.'
              : 'The months before keep the fee they had. Nothing is owed for a month before a student joined.',
          style: bodyStyle.copyWith(color: muted),
        ),
        if (_error != null) ...[const SizedBox(height: 14), InlineNotice(_error!, icon: Ph.warning)],
      ],
    );
  }
}

// ---------------------------------------------------------------- recording a payment

/// A payment the tutor has received: the month it is for (the oldest one owed comes first), the amount (what is left of it),
/// how it was paid, the day, and a note. Saved, it opens its receipt.
class RecordPaymentScreen extends StatefulWidget {
  const RecordPaymentScreen({super.key, required this.data});

  /// {student: {id, display_name, class_level}, months: [...], fee, this_month}, from the student's fees.
  final Map<String, dynamic> data;

  @override
  State<RecordPaymentScreen> createState() => _RecordPaymentScreenState();
}

class _RecordPaymentScreenState extends State<RecordPaymentScreen> {
  final _amount = TextEditingController();
  final _note = TextEditingController();
  late String _month;
  var _method = 'cash';
  DateTime _day = DateTime.now();
  var _saving = false;
  String? _error;

  Map<String, dynamic> get _student => Map<String, dynamic>.from(widget.data['student'] as Map);
  List<Map<String, dynamic>> get _months => _list(widget.data['months']);
  String get _thisMonth => '${widget.data['this_month'] ?? DateFormat('yyyy-MM').format(DateTime.now())}';

  Map<String, dynamic>? _row(String month) => _months.where((m) => m['month'] == month).firstOrNull;

  @override
  void initState() {
    super.initState();
    // The oldest month still owed, or this month.
    final owed = _months.where((m) => m['status'] == 'unpaid' || m['status'] == 'claimed').toList();
    _month = owed.isNotEmpty ? '${owed.last['month']}' : _thisMonth;
    _fillAmount();
  }

  @override
  void dispose() {
    _amount.dispose();
    _note.dispose();
    super.dispose();
  }

  void _fillAmount() {
    final r = _row(_month);
    final fee = widget.data['fee'] == null ? 0 : paiseOf(widget.data['fee']);
    final paise = r == null ? fee : (r['status'] == 'paid' || r['status'] == 'none' ? 0 : paiseOf(r['left']));
    _amount.text = paise > 0 ? '${paise ~/ 100}' : '';
  }

  Future<void> _pickMonth() async {
    final choices = <String>{
      for (final m in _months) if (m['status'] == 'unpaid' || m['status'] == 'claimed') '${m['month']}',
      _thisMonth,
      shiftMonth(_thisMonth, 1),
      shiftMonth(_thisMonth, -1),
    }.toList()
      ..sort((a, b) => b.compareTo(a));
    final picked = await showChoices<String>(
      context,
      title: 'Paid for',
      options: [
        for (final m in choices)
          Choice(m, '${monthName(m)}${_row(m) == null ? '' : ' · ${monthLine(_row(m)!).text}'}'),
      ],
      selected: _month,
    );
    if (picked?.value != null && mounted) {
      setState(() {
        _month = picked!.value!;
        _fillAmount();
      });
    }
  }

  Future<void> _pickDay() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: _day,
      firstDate: DateTime(now.year - 2, now.month),
      lastDate: now,
      helpText: 'Paid on',
    );
    if (picked != null && mounted) setState(() => _day = picked);
  }

  Future<void> _save() async {
    final rupees = int.tryParse(_amount.text.trim());
    if (rupees == null || rupees <= 0) return setState(() => _error = 'Write the amount in rupees, like 1500.');
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final r = await api.post('/teacher/fees/payments', {
        'student_id': _student['id'],
        'month': _month,
        'amount_paise': rupees * 100,
        'method': _method,
        'paid_on': f.dayKey(_day),
        if (_note.text.trim().isNotEmpty) 'reference': _note.text.trim(),
      });
      if (mounted) context.pushReplacement('/t/fees/receipt', extra: {...Map<String, dynamic>.from(r['payment'] as Map), 'class_level': _student['class_level']});
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final rupees = int.tryParse(_amount.text.trim());
    final claimed = _row(_month)?['status'] == 'claimed';
    const methods = ['cash', 'upi', 'other'];
    return PushedPanel(
      kicker: '${_student['display_name']}',
      title: 'Record a payment',
      footer: PrimaryButton(rupees == null || rupees <= 0 ? 'Save' : 'Save ${inrWhole(rupees * 100)}', busy: _saving, onTap: _saving ? null : _save),
      children: [
        const SectionRule('For', padding: EdgeInsets.fromLTRB(0, 16, 0, 10)),
        SelectField(value: monthName(_month), onTap: _pickMonth),
        if (claimed) ...[
          const SizedBox(height: 10),
          const InlineNotice('The student said they paid this month by UPI. Saving confirms their payment.', tone: Tone.neutral, icon: Ph.info),
        ],
        const SectionRule('Amount', padding: EdgeInsets.fromLTRB(0, 22, 0, 10)),
        GroupedInputs(children: [
          BareField(
            controller: _amount,
            placeholder: 'Rupees, like 1500',
            keyboard: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            maxLength: 7,
            onChanged: (_) => setState(() {}),
          ),
        ]),
        const SectionRule('Paid by', padding: EdgeInsets.fromLTRB(0, 22, 0, 10)),
        SegmentedToggle(labels: const ['Cash', 'UPI', 'Other'], index: methods.indexOf(_method), onChanged: (i) => setState(() => _method = methods[i])),
        const SectionRule('Paid on', padding: EdgeInsets.fromLTRB(0, 22, 0, 10)),
        SelectField(value: f.dayDate(_day), onTap: _pickDay),
        const SectionRule('Note', padding: EdgeInsets.fromLTRB(0, 22, 0, 10)),
        GroupedInputs(children: [
          BareField(controller: _note, placeholder: 'UPI reference or a note (optional)', maxLength: 60),
        ]),
        if (_error != null) ...[const SizedBox(height: 14), InlineNotice(_error!, icon: Ph.warning)],
      ],
    );
  }
}

// ---------------------------------------------------------------- the UPI id

class UpiIdScreen extends StatefulWidget {
  const UpiIdScreen({super.key});

  @override
  State<UpiIdScreen> createState() => _UpiIdScreenState();
}

class _UpiIdScreenState extends State<UpiIdScreen> {
  final _id = TextEditingController();
  final _name = TextEditingController();
  var _loaded = false;
  var _had = false;
  var _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _id.dispose();
    _name.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final d = await api.get('/teacher/fees');
      final upi = d['upi'] as Map?;
      if (!mounted) return;
      setState(() {
        _id.text = '${upi?['id'] ?? ''}';
        _name.text = '${upi?['name'] ?? ''}';
        _had = upi != null;
        _loaded = true;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _save({bool remove = false}) async {
    if (!remove && _id.text.trim().isEmpty) return setState(() => _error = 'Write your UPI id, like priya@okaxis.');
    if (remove &&
        !await confirmCard(
          context,
          title: 'Take the UPI id away?',
          body: 'Students then cannot pay you from the app. Payments already made stay.',
          confirm: 'Take it away',
          destructive: true,
        )) {
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await api.put('/teacher/fees/upi', remove ? {'upi_id': ''} : {'upi_id': _id.text.trim(), 'upi_name': _name.text.trim()});
      if (mounted) _done(context);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return PushedPanel(
      kicker: 'Fees',
      title: 'Your UPI id',
      footer: PrimaryButton('Save', busy: _saving, onTap: !_loaded || _saving ? null : _save),
      children: [
        const SizedBox(height: 12),
        Fig('Parents pay this UPI id from their own UPI app, and the money goes straight to you. The app never holds it.', style: bodyStyle.copyWith(color: muted)),
        const SizedBox(height: 16),
        if (!_loaded && _error == null)
          const LoadingState(rows: 2)
        else ...[
          GroupedInputs(children: [
            NamedField(name: 'UPI id', controller: _id, placeholder: 'priya@okaxis', keyboard: TextInputType.emailAddress, maxLength: 120),
            NamedField(name: 'Name shown', controller: _name, placeholder: 'Optional', capitalization: TextCapitalization.words, maxLength: 50),
          ]),
          const SizedBox(height: 8),
          Fig("The name is what the payer's UPI app shows. Left empty, it is the tuition's name.", style: labelStyle),
          const SizedBox(height: 14),
          const InlineNotice(
            'Students and parents see this UPI id. If it has your phone number in it, like 98xxxxxx10@ybl, they see your number. '
            'A UPI id with your name keeps your number private.',
            tone: Tone.neutral,
            icon: Ph.info,
          ),
          if (_had) ...[const SizedBox(height: 18), Center(child: TextAction('Take the UPI id away', color: danger, onTap: _saving ? null : () => _save(remove: true)))],
        ],
        if (_error != null) ...[const SizedBox(height: 14), InlineNotice(_error!, icon: Ph.warning)],
      ],
    );
  }
}

// ---------------------------------------------------------------- receipts

/// A payment's receipt as a picture to share, the same for the tutor and the student. The tutor can also take the payment away.
class ReceiptScreen extends StatefulWidget {
  const ReceiptScreen({super.key, required this.payment, this.canRemove = true});

  /// A payment as routes/fees.ts gives it, with the student's class_level when known.
  final Map<String, dynamic> payment;
  final bool canRemove;

  /// Around the picture's boundary, so the screenshot tests can save the very picture that is shared.
  static const cardKey = ValueKey('fee-receipt-card');

  @override
  State<ReceiptScreen> createState() => _ReceiptScreenState();
}

class _ReceiptScreenState extends State<ReceiptScreen> {
  final _boundary = GlobalKey();
  var _sharing = false;

  Map<String, dynamic> get p => widget.payment;

  Future<void> _share() async {
    setState(() => _sharing = true);
    try {
      final png = await reportPicture(_boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary);
      final text = 'Fee receipt ${p['receipt_no']} from ${session.tuitionName}: ${inrWhole(paiseOf(p['amount_paise']))} for ${monthName('${p['month']}')}.';
      if (kIsWeb) {
        await saveOrShareFile(png, name: 'receipt-${p['receipt_no']}.png', mimeType: 'image/png', text: text);
        return;
      }
      final dir = await getTemporaryDirectory();
      final file = File('${dir.path}/receipt-${p['receipt_no']}.png');
      await file.writeAsBytes(png, flush: true);
      await SharePlus.instance.share(ShareParams(files: [XFile(file.path, mimeType: 'image/png')], text: text));
    } catch (e) {
      if (mounted) await showProblem(context, e);
    } finally {
      if (mounted) setState(() => _sharing = false);
    }
  }

  Future<void> _remove() async {
    final ok = await confirmCard(
      context,
      title: 'Take this payment away?',
      body: 'For a payment recorded by mistake. ${inrWhole(paiseOf(p['amount_paise']))} for ${monthName('${p['month']}')} is then owed again, '
          'and receipt ${p['receipt_no']} is not given to another payment.',
      confirm: 'Take it away',
      destructive: true,
    );
    if (!ok || !mounted) return;
    try {
      await api.delete('/teacher/fees/payments/${p['id']}');
      if (mounted) _done(context);
    } on ApiException catch (e) {
      if (mounted) await showProblem(context, e);
    }
  }

  @override
  Widget build(BuildContext context) => PushedPanel(
        kicker: 'Receipt ${p['receipt_no']}',
        title: 'Fee receipt',
        footer: PrimaryButton(savesFiles ? 'Save the receipt' : 'Share the receipt', icon: savesFiles ? Ph.downloadSimple : Ph.shareNetwork, busy: _sharing, onTap: _sharing ? null : _share),
        children: [
          const SizedBox(height: 18),
          // Drawn at 360 points whatever the phone's width or text size, then fitted to the screen, like the report for parents.
          ClipRRect(
            borderRadius: BorderRadius.circular(rCard),
            child: FittedBox(
              fit: BoxFit.fitWidth,
              child: MediaQuery(
                data: MediaQuery.of(context).copyWith(textScaler: TextScaler.noScaling),
                child: KeyedSubtree(
                  key: ReceiptScreen.cardKey,
                  child: RepaintBoundary(key: _boundary, child: SizedBox(width: 360, child: ReceiptCard(payment: p, tuition: session.tuitionName))),
                ),
              ),
            ),
          ),
          const SizedBox(height: 12),
          Text('This is the picture that is shared, on white whatever your phone shows.', style: bodyStyle.copyWith(color: muted)),
          if (widget.canRemove) ...[
            const SizedBox(height: 22),
            Center(child: TextAction('Take this payment away', color: danger, onTap: _remove)),
          ],
        ],
      );
}

/// The light tokens of theme.dart, fixed: a receipt goes to parents, so it is light whatever the phone shows.
abstract final class _Paper {
  static const page = Color(0xFFFFFFFF);
  static const track = Color(0xFFEDEDF1);
  static const ink = Color(0xFF0E0E11);
  static const body = Color(0xFF3A3A42);
  static const muted = Color(0xFF8E8E99);
  static const success = Color(0xFF1A9E62);
}

/// The receipt itself, 360 points wide. Public so its tests can draw it.
class ReceiptCard extends StatelessWidget {
  const ReceiptCard({super.key, required this.payment, required this.tuition});

  final Map<String, dynamic> payment;
  final String tuition;

  @override
  Widget build(BuildContext context) {
    final p = payment;
    final cls = p['class_level'] == null ? '' : className(p['class_level']);
    final paidOn = DateFormat('d MMM y').format(f.dayOf('${p['paid_on']}'));
    final confirmedBy = '${p['confirmed_by'] ?? ''}'.trim();
    final reference = '${p['reference'] ?? ''}'.trim();
    Widget rule() => const Padding(padding: EdgeInsets.symmetric(vertical: 16), child: SizedBox(height: 1, width: double.infinity, child: ColoredBox(color: _Paper.track)));
    Widget line(String k, String v) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            SizedBox(width: 96, child: Text(k, style: bodyStyle.copyWith(color: _Paper.muted))),
            Expanded(child: Text(v, style: bodyStyle.copyWith(color: _Paper.ink, fontWeight: FontWeight.w600))),
          ]),
        );
    return ColoredBox(
      color: _Paper.page,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(24, 26, 24, 22),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(tuition.toUpperCase(), style: kickerStyle.copyWith(color: _Paper.ink, fontWeight: FontWeight.w700, letterSpacing: 1.3, fontSize: 12.5), maxLines: 2),
          const SizedBox(height: 4),
          Row(children: [
            Expanded(child: Text('Fee receipt', style: bodyStyle.copyWith(color: _Paper.muted))),
            Text('No. ${p['receipt_no']}', style: numStyle(size: 13, color: _Paper.body)),
          ]),
          const SizedBox(height: 20),
          Text(inrWhole(paiseOf(p['amount_paise'])), style: numStyle(size: 40, color: _Paper.ink)),
          const SizedBox(height: 4),
          Text('Fee for ${monthName('${p['month']}')}', style: rowTitleStyle.copyWith(color: _Paper.body)),
          rule(),
          line('Received from', [p['student_name'], if (cls.isNotEmpty) cls].join(' · ')),
          line('Paid by', methodName(p['method'])),
          line('Paid on', paidOn),
          if (reference.isNotEmpty) line(p['method'] == 'upi' ? 'UPI reference' : 'Note', reference),
          rule(),
          Row(children: [
            const Icon(Ph.checkCircle, size: 18, color: _Paper.success),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                confirmedBy.isEmpty ? 'Received with thanks' : 'Received with thanks by $confirmedBy',
                style: bodyStyle.copyWith(color: _Paper.body),
              ),
            ),
          ]),
        ]),
      ),
    );
  }
}
