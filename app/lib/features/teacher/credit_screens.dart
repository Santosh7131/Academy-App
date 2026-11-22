import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/changes.dart';
import '../../core/credit.dart';
import '../../core/format.dart' as f;
import '../../core/session.dart';
import '../../theme.dart';
import '../../ui/kit.dart';
import 'common.dart' show showProblem;

// AI credit (the server's lib/credit.ts): the balance that pays for AI work, how to add to it, and the price shown before each AI job.
// Tests, students and results never need credit.

int _n(Object? v) => v is num ? v.toInt() : int.tryParse('$v') ?? 0;
List<Map<String, dynamic>> _list(Object? v) => ((v as List?) ?? const []).cast<Map<String, dynamic>>();

// ---------------------------------------------------------------- the price before AI work

/// AI work's price, around its button. When the credit covers it: the price above the button, and what is left after it below. When it
/// does not: what the work costs against what there is, a button to add credit and, when part of it is affordable, [smaller] (a smaller
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
      PrimaryButton('Add credit', leadingIcon: Ph.plus, onTap: () => context.push('/t/credit/add')),
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

/// Home's note when the credit pays for nothing AI does: AI waits for credit, and nothing else does.
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
                'AI can\'t read papers or write questions until you add credit. Tests that are already live, your students and their results work as usual.',
                style: bodyStyle.copyWith(color: body),
              ),
              const SizedBox(height: 13),
              Pressable(
                label: 'Add credit',
                onTap: onAdd,
                child: Container(
                  height: 38,
                  padding: const EdgeInsets.symmetric(horizontal: 18),
                  decoration: BoxDecoration(color: actionFill, borderRadius: BorderRadius.circular(12)),
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    Text('Add credit', style: chipStyle.copyWith(color: actionInk, fontWeight: FontWeight.w700)),
                  ]),
                ),
              ),
            ]),
          ),
        ]),
      );
}

// ---------------------------------------------------------------- the lines

String _lineWhen(DateTime t) {
  final near = f.nearDay(t);
  if (near == 'today') return 'Today, ${f.time(t)}';
  if (near == 'yesterday') return 'Yesterday';
  return f.shortDate(t);
}

/// One line of the history: AI work (the pages of a paper read on one day are one line), or credit added.
class CreditLine extends StatelessWidget {
  const CreditLine(this.l, {super.key});
  final Map<String, dynamic> l;

  String get _title {
    final label = l['label'] == null ? '' : ' · ${l['label']}';
    return switch ('${l['kind']}') {
      'page' => 'Read ${f.count(_n(l['pages']), 'page')}$label',
      'questions' => 'Wrote ${f.count(_n(l['questions']), 'question')}$label',
      'start' => 'Free credit to start',
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
    final pay = (d['pay'] as Map?) ?? const {};
    final open = pay['open'] == true;
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
            pages == 0 && questions == 0 ? 'Add credit to use AI' : 'about ${f.count(pages, 'page')} or ${f.count(questions, 'question')}',
            style: bodyStyle.copyWith(color: muted, fontWeight: FontWeight.w600),
            numColor: ink,
          ),
          const SizedBox(height: 18),
          PrimaryButton(
            'Add credit',
            leadingIcon: Ph.plus,
            onTap: open ? () => context.push('/t/credit/add') : null,
            disabledReason: open ? null : 'Adding credit opens soon.',
          ),
        ]),
      ),
      const SizedBox(height: 12),
      Fig('Tests, students and results never need credit.', style: labelStyle),
      const SectionRule('What AI costs', padding: _rule),
      Surface(
        shadow: e1,
        child: Column(children: [
          _price(Ph.scan, 'Reading a page', 'and finding every answer on it', c.pagePaise),
          Container(height: 1, color: hairline),
          _price(Ph.pencilSimpleLine, 'Writing a question', 'in Describe it to AI', c.questionPaise),
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

// ---------------------------------------------------------------- adding credit

/// Choose an amount, pay it by UPI with the tuition's code in the note, then say so. The developer checks the payment and the credit
/// is added then.
class AddCreditScreen extends StatefulWidget {
  const AddCreditScreen({super.key});

  @override
  State<AddCreditScreen> createState() => _AddCreditScreenState();
}

class _AddCreditScreenState extends State<AddCreditScreen> {
  Map<String, dynamic>? _d;
  String? _error;
  int? _amount;
  bool _sending = false;

  /// What was copied last, so its button says so.
  String? _copied;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final d = Map<String, dynamic>.from(await api.get('/teacher/credit'));
      credit.set(Credit.from(d));
      final offered = ((d['pay']?['amounts_paise'] as List?) ?? const []).map(_n).toList();
      if (mounted) {
        setState(() {
          _d = d;
          // The second amount is the usual first top-up (₹250 of ₹100, ₹250, ₹500, ₹1,000).
          _amount ??= offered.length > 1 ? offered[1] : offered.firstOrNull;
        });
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _paid() async {
    final amount = _amount;
    if (amount == null) return;
    setState(() => _sending = true);
    try {
      final r = await api.post('/teacher/credit/requests', {'amount_paise': amount});
      if (mounted) context.pushReplacement('/t/credit/sent', extra: Map<String, dynamic>.from(r['request'] as Map));
    } on ApiException catch (e) {
      if (mounted) await showProblem(context, e);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  void _copy(String text) {
    Clipboard.setData(ClipboardData(text: text));
    setState(() => _copied = text);
  }

  @override
  Widget build(BuildContext context) {
    final d = _d;
    final pay = (d?['pay'] as Map?) ?? const {};
    final c = d == null ? null : Credit.from(d);
    final open = pay['open'] == true;
    final amount = _amount;
    return PushedPanel(
      kicker: 'AI credit',
      title: 'Add credit',
      footer: d == null || !open || amount == null
          ? null
          : Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              PrimaryButton('I have paid ${inrWhole(amount)}', busy: _sending, onTap: _paid),
              const SizedBox(height: 9),
              Fig('The credit is added after the payment is checked.', style: labelStyle, textAlign: TextAlign.center),
            ]),
      children: [
        if (d == null && _error != null)
          ErrorState(message: _error!, onRetry: _load)
        else if (d == null)
          const LoadingState(rows: 3)
        else if (!open) ...[
          const SizedBox(height: 16),
          const InlineNotice('Adding credit opens soon. Your tests, students and results work as usual meanwhile.', tone: Tone.neutral, icon: Ph.clock),
        ] else ...[
          const SizedBox(height: 10),
          Fig('Your credit is added once the payment is checked.', style: bodyStyle.copyWith(color: muted)),
          const SectionRule('Amount', padding: _rule),
          _amounts(((pay['amounts_paise'] as List?) ?? const []).map(_n).toList(), c),
          const SectionRule('How to pay', padding: _rule),
          Surface(
            shadow: e1,
            child: Column(children: [
              _step(1, 'Pay ${inrWhole(amount ?? 0)} by UPI to', copy: '${pay['upi_id']}'),
              if ('${pay['upi_name'] ?? ''}'.isNotEmpty) ...[
                Padding(
                  padding: const EdgeInsets.fromLTRB(55, 0, 17, 12),
                  child: Align(alignment: Alignment.centerLeft, child: Fig('The UPI app shows the name ${pay['upi_name']}.', style: labelStyle.copyWith(color: muted))),
                ),
              ],
              Container(height: 1, color: hairline),
              _step(2, 'Put this code in the payment note', copy: '${pay['code']}'),
              Container(height: 1, color: hairline),
              _step(3, 'Come back and tap I have paid'),
            ]),
          ),
        ],
      ],
    );
  }

  Widget _amounts(List<int> offered, Credit? c) => LayoutBuilder(
        builder: (context, box) {
          final w = (box.maxWidth - gapRow) / 2;
          return Wrap(spacing: gapRow, runSpacing: gapRow, children: [
            for (final a in offered)
              SizedBox(
                width: w,
                child: Pressable(
                  label: inrWhole(a),
                  onTap: () => setState(() => _amount = a),
                  child: Container(
                    constraints: const BoxConstraints(minHeight: 68),
                    padding: const EdgeInsets.fromLTRB(16, 13, 16, 12),
                    decoration: a == _amount
                        ? BoxDecoration(color: actionFill, borderRadius: BorderRadius.circular(rCard), boxShadow: e4)
                        : surface(radius: rCard, shadow: e1),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                      Text(inrWhole(a), style: numStyle(size: 22, color: a == _amount ? actionInk : ink)),
                      if (c != null && c.pagePaise > 0) ...[
                        const SizedBox(height: 4),
                        Fig('about ${f.count(c.pagesFor(a), 'page')}', style: labelStyle.copyWith(color: a == _amount ? actionInk.withValues(alpha: 0.72) : muted)),
                      ],
                    ]),
                  ),
                ),
              ),
          ]);
        },
      );

  Widget _step(int n, String text, {String? copy}) => Padding(
        padding: const EdgeInsets.fromLTRB(17, 13, 17, 13),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Container(
            width: 24,
            height: 24,
            alignment: Alignment.center,
            decoration: BoxDecoration(color: fill, shape: BoxShape.circle),
            child: Text('$n', style: numStyle(size: 12)),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Padding(padding: const EdgeInsets.only(top: 3), child: Fig(text, style: rowTitleStyle)),
              if (copy != null) ...[
                const SizedBox(height: 8),
                Row(children: [
                  Expanded(
                    child: Container(
                      height: 40,
                      padding: const EdgeInsets.symmetric(horizontal: 13),
                      alignment: Alignment.centerLeft,
                      decoration: BoxDecoration(color: fill, borderRadius: BorderRadius.circular(12)),
                      child: Text(copy, style: numStyle(size: 14.5), maxLines: 1, overflow: TextOverflow.ellipsis),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Pressable(
                    label: 'Copy $copy',
                    onTap: () => _copy(copy),
                    child: Container(
                      height: 40,
                      padding: const EdgeInsets.symmetric(horizontal: 14),
                      decoration: surface(radius: 12, shadow: e1),
                      child: Row(mainAxisSize: MainAxisSize.min, children: [
                        Icon(_copied == copy ? Ph.check : Ph.copy, size: 16, color: ink),
                        const SizedBox(width: 6),
                        Text(_copied == copy ? 'Copied' : 'Copy', style: chipStyle.copyWith(color: ink, fontWeight: FontWeight.w700)),
                      ]),
                    ),
                  ),
                ]),
              ],
            ]),
          ),
        ]),
      );
}

// ---------------------------------------------------------------- request sent

/// After "I have paid": what was asked for, and that nothing more is needed.
class CreditSentScreen extends StatelessWidget {
  const CreditSentScreen({super.key, required this.request});
  final Map<String, dynamic> request;

  @override
  Widget build(BuildContext context) {
    final sent = f.parseTime(request['created_at']);
    Widget kv(String k, String v, {bool mono = false}) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 12),
          child: Row(children: [
            Fig(k, style: bodyStyle.copyWith(color: muted)),
            const SizedBox(width: 12),
            Expanded(child: Text(v, style: mono ? numStyle(size: 13.5, weight: FontWeight.w600) : bodyStyle.copyWith(color: ink, fontWeight: FontWeight.w600), textAlign: TextAlign.end)),
          ]),
        );
    return PushedPanel(
      kicker: 'AI credit',
      title: 'Request sent',
      // Back to wherever adding credit started: the AI credit screen, Home, or the paper or test that needed the credit.
      footer: PrimaryButton('Done', onTap: () => Navigator.of(context).maybePop()),
      children: [
        const SizedBox(height: 20),
        Surface(
          padding: const EdgeInsets.fromLTRB(20, 20, 20, 8),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Fig('Waiting for the payment to be checked', style: bodyStyle.copyWith(color: muted, fontWeight: FontWeight.w600)),
            const SizedBox(height: 12),
            Text(inr(_n(request['amount_paise'])), style: numStyle(size: 40)),
            const SizedBox(height: 18),
            Container(height: 1, color: hairline),
            kv('Code', '${request['code']}', mono: true),
            Container(height: 1, color: hairline),
            kv('Paid to', '${request['upi_id']}', mono: true),
            Container(height: 1, color: hairline),
            kv('Sent', sent == null ? '' : _lineWhen(sent)),
          ]),
        ),
        const SizedBox(height: 16),
        Fig(
          'Paid already? That is all you need to do. The credit shows up on the AI credit screen once the payment is checked.',
          style: labelStyle,
        ),
      ],
    );
  }
}
