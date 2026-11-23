import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/credit.dart';
import '../../core/format.dart' as f;
import '../../core/session.dart';
import '../../theme.dart';
import '../../ui/kit.dart';
import 'plan_screens.dart' show planTitle;

/// Deleting the tuition, for its owner (from Settings): what goes, what is lost, and the password to say so. The server deletes it
/// (POST /teacher/tuition/delete), and the app signs out after.
class DeleteTuitionScreen extends StatefulWidget {
  const DeleteTuitionScreen({super.key});

  @override
  State<DeleteTuitionScreen> createState() => _DeleteTuitionScreenState();
}

class _DeleteTuitionScreenState extends State<DeleteTuitionScreen> {
  final _password = TextEditingController();
  bool _busy = false;
  String? _problem;

  /// The credit left and the payments still waiting, as the server has them now; null until they are loaded.
  Map<String, dynamic>? _credit;

  /// The plan and the plan payments still waiting (GET /teacher/plan); null until loaded, and from a server before plans.
  Map<String, dynamic>? _plan;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _password.dispose();
    super.dispose();
  }

  /// Without the credit the screen still says that credit left is lost, only without the figure; without the plan it says nothing of it.
  Future<void> _load() async {
    Future<Map<String, dynamic>?> read(String path) async {
      try {
        final r = await api.get(path);
        return r is Map ? Map<String, dynamic>.from(r) : null;
      } on ApiException {
        return null;
      }
    }

    final got = await Future.wait([read('/teacher/credit'), read('/teacher/plan')]);
    if (!mounted) return;
    setState(() {
      _credit = got[0];
      _plan = got[1];
    });
  }

  static int _sum(Object? requests) => (requests is List ? requests : const []).whereType<Map>().fold<int>(
        0,
        (sum, w) => sum + (w['amount_paise'] is num ? (w['amount_paise'] as num).toInt() : 0),
      );

  Future<void> _delete() async {
    if (_password.text.isEmpty || _busy) return;
    setState(() {
      _busy = true;
      _problem = null;
    });
    try {
      await api.post('/teacher/tuition/delete', {'secret': _password.text});
      if (!mounted) return;
      await session.logout();
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _problem = e.message;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = _credit;
    final balanceRaw = c?['credit'] is Map ? (c!['credit'] as Map)['balance_paise'] : null;
    final balance = balanceRaw is num ? balanceRaw.toInt() : credit.value?.balance;
    final waitingPaise = _sum(c?['waiting']);
    // A Basic or Pro plan still running ends with the tuition, however long it had left.
    final plan = _plan?['plan'] is Map ? _plan!['plan'] as Map : const {};
    final paidPlan = (plan['name'] == 'basic' || plan['name'] == 'pro') && plan['lapsed'] != true && plan['last_day'] is String;
    final planWaitingPaise = _sum(_plan?['waiting']);
    // The server refuses while a plan payment waits (it would go with the tuition, unmatched): the button waits too.
    final ready = _password.text.isNotEmpty && !_busy && planWaitingPaise == 0;
    return PushedPanel(
      kicker: 'Settings',
      title: 'Delete the tuition',
      footer: SecondaryButton(_busy ? 'Deleting…' : 'Delete the tuition', icon: Ph.trash, tint: danger, onTap: ready ? _delete : null),
      children: [
        const SizedBox(height: 12),
        Fig('This deletes ${session.tuitionName} for good. It cannot be undone.', style: bodyStyle.copyWith(color: ink, fontWeight: FontWeight.w600)),
        const SizedBox(height: 18),
        const _Line(Ph.trash, "Every test and your students' results, the papers, the questions, the groups, the courses and the Library files."),
        const _Line(Ph.users, 'Students and tutors who are only in this tuition lose their logins. Anyone who is also in another tuition '
            'keeps their login and that tuition.'),
        const _Line(Ph.userCircle, 'Your own login goes too, unless you also tutor in another tuition.'),
        _Line(Ph.coins, balance == null ? 'Any AI credit left is lost.' : (balance > 0 ? 'The AI credit left, ${inr(balance)}, is lost.' : 'There is no AI credit left to lose.')),
        if (paidPlan)
          _Line(Ph.calendarBlank, 'Your ${planTitle(plan['name'])} plan ends with it, though it runs until '
              '${f.longDate(f.dayOf('${plan['last_day']}'))}.'),
        if (planWaitingPaise > 0) ...[
          const SizedBox(height: 4),
          InlineNotice('${inr(planWaitingPaise)} you paid for a plan is still waiting to be checked. The tuition can be deleted once it '
              'has been checked.', icon: Ph.warning),
        ],
        if (waitingPaise > 0) ...[
          const SizedBox(height: 4),
          InlineNotice('${inr(waitingPaise)} you paid is still waiting to be checked. Delete the tuition only after it is added: once the '
              'tuition is deleted, there is nothing to add it to.', icon: Ph.warning),
        ],
        const SizedBox(height: 26),
        Text('Type your password to delete it', style: labelStyle.copyWith(fontSize: 13, color: muted)),
        const SizedBox(height: 8),
        GroupedInputs(children: [
          BareField(
            controller: _password,
            placeholder: 'Your password',
            obscure: true,
            action: TextInputAction.done,
            onChanged: (_) => setState(() {}),
            onSubmitted: (_) => _delete(),
          ),
        ]),
        if (_problem != null) ...[const SizedBox(height: 12), InlineNotice(_problem!, tone: Tone.danger, icon: Ph.warning)],
      ],
    );
  }
}

/// One thing the delete does, with its icon.
class _Line extends StatelessWidget {
  const _Line(this.icon, this.text);
  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 14),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Padding(padding: const EdgeInsets.only(top: 1), child: Icon(icon, size: 19, color: muted)),
          const SizedBox(width: 12),
          Expanded(child: Fig(text, style: bodyStyle)),
        ]),
      );
}
