import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/changes.dart';
import '../../core/credit.dart';
import '../../core/format.dart' as f;
import '../../core/session.dart';
import '../../theme.dart';
import '../../ui/kit.dart';

// AI credit (the server's lib/credit.ts): the balance that pays for AI work, how to add to it, and the price shown before each AI job.
// Tests, students and results never need credit.

int _n(Object? v) => v is num ? v.toInt() : int.tryParse('$v') ?? 0;
List<Map<String, dynamic>> _list(Object? v) => ((v as List?) ?? const []).cast<Map<String, dynamic>>();

// ---------------------------------------------------------------- the price before AI work

/// AI work's price, around its button. When the credit covers it: the price above the button, and what is left after it below. When it
/// does not: what the work costs against what there is, a button to the plans (AI comes with them) and, when part of it is affordable, [smaller] (a smaller
/// job, such as reading the first page only). Without [c] (the credit could not be had) the button stands alone: the server still
/// refuses work the credit does not cover, and says so.
class PricedAction extends StatelessWidget {
  const PricedAction({super.key, required this.c, required this.count, required this.one, required this.many, required this.unitPaise, required this.button, this.smaller});

  final Credit? c;

  /// How many pages, or questions, the work is.
  final int count;

  /// "page" and "pages", or "question" and "questions".
  final String one;
  final String many;
  final int unitPaise;
  final Widget button;
  final Widget Function(int affordable)? smaller;

  @override
  Widget build(BuildContext context) {
    final c = this.c;
    if (c == null || count <= 0 || unitPaise <= 0) return button;
    final total = count * unitPaise;
    final what = '$count ${count == 1 ? one : many}';
    if (c.free >= total) {
      return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 0, 4, 10),
          child: Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
            Expanded(
              child: Text.rich(
                TextSpan(children: [
                  TextSpan(text: '$what  '),
                  TextSpan(text: '× ${inr(unitPaise)}', style: numStyle(size: 13, weight: FontWeight.w600, color: faint)),
                ]),
                style: bodyStyle.copyWith(color: muted, fontWeight: FontWeight.w600),
              ),
            ),
            Text(inr(total), style: numStyle(size: 19)),
          ]),
        ),
        button,
        const SizedBox(height: 9),
        Fig('You have ${inr(c.free)}. ${inr(c.free - total)} left after this.', style: labelStyle, textAlign: TextAlign.center),
      ]);
    }
    final affordable = c.free ~/ unitPaise;
    final style = bodyStyle.copyWith(color: warning, fontWeight: FontWeight.w600);
    return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(4, 0, 4, 12),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(Ph.warningCircle, size: 19, color: warning),
          const SizedBox(width: 10),
          Expanded(
            child: Text.rich(TextSpan(children: [
              figSpan('$what ${count == 1 ? 'costs' : 'cost'} ${inr(total)}.', style.copyWith(color: ink, fontWeight: FontWeight.w700)),
              figSpan(' You have ${inr(c.free)}.', style),
            ])),
          ),
        ]),
      ),
      PrimaryButton('See plans', onTap: () => context.push('/t/plan')),
      if (affordable > 0 && smaller != null) ...[const SizedBox(height: gapRow), smaller!(affordable)],
    ]);
  }
}

// ---------------------------------------------------------------- on Home

/// The balance, at the top of Home and of the screens that spend it; a tap opens the AI credit screen. Amber when it does not pay
/// for a page, or for the work on the screen ([short]); red when it pays for nothing AI does.
class CreditPill extends StatelessWidget {
  const CreditPill(this.c, {super.key, required this.onTap, this.short = false});
  final Credit c;
  final VoidCallback onTap;
  final bool short;

  @override
  Widget build(BuildContext context) {
    final Color? tint = c.out ? danger : (short || c.low ? warning : null);
    return Pressable(
      label: 'AI credit, ${inr(c.balance)}',
      onTap: onTap,
      child: Container(
        height: 36,
        padding: const EdgeInsets.fromLTRB(11, 0, 13, 0),
        decoration: tint == null
            ? surface(radius: rPill, shadow: e1)
            : BoxDecoration(color: c.out ? dangerSoft : warningSoft, borderRadius: BorderRadius.circular(rPill)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(Ph.coins, size: 16, color: tint ?? muted),
          const SizedBox(width: 6),
          Text(inr(c.balance), style: numStyle(size: 13.5, weight: FontWeight.w700, color: tint ?? ink)),
        ]),
      ),
    );
  }
}

/// Home's note when the credit pays for nothing AI does: AI waits for the plan's next month or a bigger plan, and nothing else
/// waits.
class CreditLowNotice extends StatelessWidget {
  const CreditLowNotice(this.c, {super.key, required this.onAdd});
  final Credit c;
  final VoidCallback onAdd;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(color: dangerSoft, borderRadius: BorderRadius.circular(rCard)),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Padding(padding: const EdgeInsets.only(top: 1), child: Icon(Ph.coins, size: 22, color: danger)),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Fig('AI credit is ${inr(c.balance)}', style: rowTitleStyle.copyWith(color: danger, fontWeight: FontWeight.w700)),
              const SizedBox(height: 5),
              Fig(
                '${aiWaitsFor(c)} Tests that are already live, your students and their results work as usual.',
                style: bodyStyle.copyWith(color: body),
              ),
              const SizedBox(height: 13),
              Pressable(
                label: 'See plans',
                onTap: onAdd,
                child: Container(
                  height: 38,
                  padding: const EdgeInsets.symmetric(horizontal: 18),
                  decoration: BoxDecoration(color: actionFill, borderRadius: BorderRadius.circular(12)),
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    Text('See plans', style: chipStyle.copyWith(color: actionInk, fontWeight: FontWeight.w700)),
                  ]),
                ),
              ),
            ]),
          ),
        ]),
      );
}

/// What AI waits for once it has run out: on Free, a plan on sale (or plans going on sale, before any is); on a plan, its next
/// month, or Pro when it is on sale.
String aiWaitsFor(Credit c) {
  final sale = c.plansOnSale;
  if (!c.monthly) {
    if (sale != null && sale.isEmpty) return "AI can't read papers or write questions until plans with AI every month go on sale.";
    final names = (sale ?? const ['basic', 'pro']).map((p) => p == 'pro' ? 'Pro' : 'Basic').toList();
    return "AI can't read papers or write questions until you move to ${names.join(' or ')}, which ${names.length == 1 ? 'gives' : 'give'} AI every month.";
  }
  final next = c.nextMonthOn == null ? null : f.shortDate(f.dayOf(c.nextMonthOn!));
  final more = c.plan == 'basic' && (sale == null || sale.contains('pro')) ? ' Or move to Pro for more now.' : '';
  return next == null
      ? "Your plan's AI for this month is used up.$more"
      : "Your plan's AI for this month is used up. It comes again on $next.$more";
}

// ---------------------------------------------------------------- the lines

String _lineWhen(DateTime t) {
  final near = f.nearDay(t);
  if (near == 'today') return 'Today, ${f.time(t)}';
  if (near == 'yesterday') return 'Yesterday';
  return f.shortDate(t);
}

/// One line of the history: AI work (the pages of a paper read on one day are one line, and so are the worked solutions written for
/// one test on one day), or credit added.
class CreditLine extends StatelessWidget {
  const CreditLine(this.l, {super.key});
  final Map<String, dynamic> l;

  String get _title {
    final label = l['label'] == null ? '' : ' · ${l['label']}';
    return switch ('${l['kind']}') {
      'page' => 'Read ${f.count(_n(l['pages']), 'page')}$label',
      'questions' => 'Wrote ${f.count(_n(l['questions']), 'question')}$label',
      'solutions' => 'Wrote ${f.count(_n(l['solutions']), 'worked solution')}$label',
      'start' => 'Free credit to start',
      'plan' => 'AI for the month$label',
      _ => 'Credit added',
    };
  }

  String get _meta {
    final t = f.parseTime(l['at']);
    final when = t == null ? '' : _lineWhen(t);
    return l['kind'] == 'topup' ? '$when · UPI' : when;
  }

  @override
  Widget build(BuildContext context) {
    final amount = _n(l['amount_paise']);
    return Container(
      padding: const EdgeInsets.fromLTRB(17, 13, 17, 13),
      decoration: surface(radius: rCard, shadow: e1),
      child: Row(children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Fig(_title, style: rowTitleStyle, maxLines: 1),
            const SizedBox(height: 2),
            Fig(_meta, style: labelStyle.copyWith(color: muted), maxLines: 1),
          ]),
        ),
        const SizedBox(width: 12),
        Text(amount < 0 ? '−${inr(-amount)}' : '+${inr(amount)}', style: numStyle(size: 14.5, color: amount < 0 ? ink : success)),
      ]),
    );
  }
}

Widget _lines(List<Map<String, dynamic>> lines) => Column(children: [
      for (final (i, l) in lines.indexed) ...[if (i > 0) const SizedBox(height: 8), CreditLine(l)],
    ]);

const _rule = EdgeInsets.fromLTRB(0, 26, 0, 12);

// ---------------------------------------------------------------- the AI credit screen

/// The balance, what AI costs, the payments waiting to be checked and the last few lines.
class CreditScreen extends StatefulWidget {
  const CreditScreen({super.key});

  @override
  State<CreditScreen> createState() => _CreditScreenState();
}

class _CreditScreenState extends State<CreditScreen> with WidgetsBindingObserver, AutoRefresh<CreditScreen> {
  Map<String, dynamic>? _d;
  String? _error;

  @override
  Set<Area> get refreshAreas => {Area.credit};

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
      final d = Map<String, dynamic>.from(await api.get('/teacher/credit'));
      credit.set(Credit.from(d));
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

  @override
  Widget build(BuildContext context) {
    final d = _d;
    final c = d == null ? null : Credit.from(d);
    return PushedPanel(
      kicker: session.tuitionName,
      title: 'AI credit',
      onRefresh: _load,
      children: [
        if (c == null && _error != null)
          ErrorState(message: _error!, onRetry: _load)
        else if (c == null)
          const LoadingState(rows: 3)
        else
          ..._body(d!, c),
      ],
    );
  }

  List<Widget> _body(Map<String, dynamic> d, Credit c) {
    final waiting = _list(d['waiting']);
    final recent = _list(d['recent']);
    final pages = c.pagesFor(c.balance);
    final questions = c.questionsFor(c.balance);
    return [
      const SizedBox(height: 20),
      Surface(
        padding: const EdgeInsets.fromLTRB(20, 20, 20, 18),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Fig('You have', style: bodyStyle.copyWith(color: muted, fontWeight: FontWeight.w600)),
          const SizedBox(height: 10),
          Text(inr(c.balance), style: numStyle(size: 46)),
          const SizedBox(height: 12),
          Fig(
            pages == 0 && questions == 0 ? aiWaitsFor(c) : 'about ${f.count(pages, 'page')} or ${f.count(questions, 'question')}',
            style: bodyStyle.copyWith(color: muted, fontWeight: FontWeight.w600),
            numColor: ink,
          ),
          if (c.monthly && c.nextMonthOn != null && (pages > 0 || questions > 0)) ...[
            const SizedBox(height: 4),
            Fig('Your plan gives more on ${f.shortDate(f.dayOf(c.nextMonthOn!))}', style: labelStyle),
          ],
          const SizedBox(height: 18),
          SecondaryButton('See plans', onTap: () => context.push('/t/plan')),
        ]),
      ),
      const SizedBox(height: 12),
      Fig('AI comes with your plan. Tests, students and results never need it.', style: labelStyle),
      const SectionRule('What AI costs', padding: _rule),
      Surface(
        shadow: e1,
        child: Column(children: [
          _price(Ph.scan, 'Reading a page', 'and finding every answer on it', c.pagePaise),
          Container(height: 1, color: hairline),
          _price(Ph.pencilSimpleLine, 'Writing a question', 'in Describe it to AI', c.questionPaise),
          // A server before worked solutions sends no price for them.
          if (c.solutionPaise case final s?) ...[
            Container(height: 1, color: hairline),
            _price(Ph.notePencil, 'Writing a worked solution', 'for a question in a test', s),
          ],
        ]),
      ),
      const SizedBox(height: 12),
      Fig('You only pay for work that finishes. A page that fails costs nothing.', style: labelStyle),
      if (waiting.isNotEmpty) ...[
        SectionRule('Waiting to be checked', count: waiting.length, padding: _rule),
        for (final (i, w) in waiting.indexed) ...[
          if (i > 0) const SizedBox(height: 8),
          RowTile(
            leading: Icon(Ph.clock, size: 20, color: muted),
            title: '${inr(_n(w['amount_paise']))} · ${w['code']}',
            meta: 'Sent ${f.when(f.parseTime(w['created_at']) ?? DateTime.now())} · paid to ${w['upi_id']}',
          ),
        ],
      ],
      SectionRule('Recent', padding: _rule, trailing: recent.length >= 5 ? TextAction('All', onTap: () => context.push('/t/credit/history')) : null),
      if (recent.isEmpty) Fig('Nothing yet.', style: bodyStyle.copyWith(color: muted)) else _lines(recent),
    ];
  }

  Widget _price(IconData icon, String title, String meta, int paise) => Padding(
        padding: const EdgeInsets.fromLTRB(17, 14, 17, 14),
        child: Row(children: [
          Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(color: fill, borderRadius: BorderRadius.circular(rSmall - 2)),
            child: Icon(icon, size: 19, color: ink),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Fig(title, style: rowTitleStyle),
              const SizedBox(height: 2),
              Fig(meta, style: labelStyle.copyWith(color: muted)),
            ]),
          ),
          const SizedBox(width: 12),
          Text(inr(paise), style: numStyle(size: 15)),
        ]),
      );
}

// ---------------------------------------------------------------- every line

/// The whole history, newest first, thirty lines at a time.
class CreditHistoryScreen extends StatefulWidget {
  const CreditHistoryScreen({super.key});

  @override
  State<CreditHistoryScreen> createState() => _CreditHistoryScreenState();
}

class _CreditHistoryScreenState extends State<CreditHistoryScreen> {
  final _lines0 = <Map<String, dynamic>>[];
  bool _more = false;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _next();
  }

  Future<void> _next() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final before = _lines0.isEmpty ? '' : '?before=${Uri.encodeQueryComponent('${_lines0.last['at']}')}';
      final r = await api.get('/teacher/credit/history$before');
      if (!mounted) return;
      setState(() {
        _lines0.addAll(_list(r['lines']));
        _more = r['more'] == true;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) => PushedPanel(
        kicker: 'AI credit',
        title: 'History',
        children: [
          const SizedBox(height: 20),
          if (_lines0.isEmpty && _error != null)
            ErrorState(message: _error!, onRetry: _next)
          else if (_lines0.isEmpty && _loading)
            const LoadingState(rows: 4)
          else if (_lines0.isEmpty)
            Fig('Nothing yet.', style: bodyStyle.copyWith(color: muted))
          else ...[
            _lines(_lines0),
            if (_error != null) ...[const SizedBox(height: 12), InlineNotice(_error!, icon: Ph.warning)],
            if (_more) Center(child: TextAction(_loading ? 'Loading' : 'Show more', onTap: _loading ? null : _next)),
          ],
        ],
      );
}
