import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/changes.dart';
import '../../core/credit.dart';
import '../../core/format.dart' as f;
import '../../core/session.dart';
import '../../core/upi.dart';
import '../../core/web_bits.dart' show savesFiles;
import '../../theme.dart';
import '../../ui/kit.dart';
import '../../ui/qr.dart';
import 'common.dart' show showProblem;

// Plans (the server's lib/plans.ts): Free, Basic and Pro. Each has room for so many students and tutors, and Basic and Pro give AI
// every month. The owner pays by UPI with the tuition's code in the note and says so; the developer checks the payment and the plan
// starts then. A plan that ends leaves the tuition on Free: nobody is turned off and nothing is deleted.

int _n(Object? v) => v is num ? v.toInt() : int.tryParse('$v') ?? 0;
List<Map<String, dynamic>> _list(Object? v) => ((v as List?) ?? const []).cast<Map<String, dynamic>>();

/// "Free", "Basic" or "Pro".
String planTitle(Object? p) => switch ('$p') { 'basic' => 'Basic', 'pro' => 'Pro', _ => 'Free' };

/// "Thu 24 Dec" from the server's "2026-12-24", and "Thu 24 Dec 2026" for the end of a plan, which may be in another year.
String _day(Object? ymd) => ymd == null ? '' : f.shortDate(f.dayOf('$ymd'));
String _lastDay(Object? ymd) => ymd == null ? '' : f.longDate(f.dayOf('$ymd'));

const _rule = EdgeInsets.fromLTRB(0, 26, 0, 12);
const _size = {'free': 0, 'basic': 1, 'pro': 2};

/// Whether the owner can buy [plan] here, and why not when they cannot (null when they can).
String? _whyNot(Map<String, dynamic> d, String plan) {
  final pay = (d['pay'] as Map?) ?? const {};
  final current = '${d['plan']?['name']}';
  if (plan == 'free') return 'Free needs nothing bought.';
  if (pay['open'] != true || !((pay['for_sale'] as List?) ?? const []).contains(plan)) return 'Plans go on sale soon.';
  if (pay['here'] != true) {
    return pay['where'] == 'web' ? 'Plans are bought in the web version of the app, in a browser.' : 'Plans are bought in the app on a phone.';
  }
  if (d['owner'] != true) return "Only the tuition's owner can buy a plan.";
  if ((_size[current] ?? 0) > (_size[plan] ?? 0)) return 'You can move to ${planTitle(plan)} after ${planTitle(current)} ends.';
  return null;
}

// ---------------------------------------------------------------- the plan screen

/// The plan today, how much of its room is used, the AI left, the three plans, and the payments waiting to be checked.
class PlanScreen extends StatefulWidget {
  const PlanScreen({super.key});

  @override
  State<PlanScreen> createState() => _PlanScreenState();
}

class _PlanScreenState extends State<PlanScreen> with WidgetsBindingObserver, AutoRefresh<PlanScreen> {
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
      final d = Map<String, dynamic>.from(await api.get('/teacher/plan'));
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
    return PushedPanel(
      kicker: session.tuitionName,
      title: 'Plan',
      onRefresh: _load,
      children: [
        if (d == null && _error != null)
          ErrorState(message: _error!, onRetry: _load)
        else if (d == null)
          const LoadingState(rows: 3)
        else
          ..._body(d),
      ],
    );
  }

  List<Widget> _body(Map<String, dynamic> d) {
    final plan = Map<String, dynamic>.from((d['plan'] as Map?) ?? const {});
    final name = '${plan['name']}';
    final plans = _list(d['plans']);
    final mine = plans.firstWhere((p) => p['name'] == name, orElse: () => const {});
    final used = (d['used'] as Map?) ?? const {};
    final ai = (d['ai'] as Map?) ?? const {};
    final waiting = _list(d['waiting']);
    final c = credit.value;
    final pages = c?.pagesFor(_n(ai['balance_paise']));
    return [
      const SizedBox(height: 20),
      Surface(
        padding: const EdgeInsets.fromLTRB(20, 20, 20, 8),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Fig('Your plan', style: bodyStyle.copyWith(color: muted, fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          Text(planTitle(name), style: displayStyle),
          const SizedBox(height: 6),
          Fig(
            name == 'free' ? 'Free, for as long as you like' : 'Until ${_lastDay(plan['last_day'])}',
            style: bodyStyle.copyWith(color: muted),
          ),
          const SizedBox(height: 14),
          Container(height: 1, color: hairline),
          _use(Ph.users, 'Students', _n(used['students']), _n(mine['students'])),
          Container(height: 1, color: hairline),
          _use(Ph.userPlus, 'Tutors', _n(used['tutors']), _n(mine['tutors'])),
          Container(height: 1, color: hairline),
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 13),
            child: Row(children: [
              Icon(Ph.sparkle, size: 19, color: muted),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Fig('AI left', style: rowTitleStyle),
                  if (plan['next_month_on'] != null || pages != null) ...[
                    const SizedBox(height: 2),
                    Fig(
                      [
                        if (pages != null) 'about ${f.count(pages, 'page')}',
                        if (plan['next_month_on'] != null) 'more on ${_day(plan['next_month_on'])}',
                      ].join(' · '),
                      style: labelStyle.copyWith(color: muted),
                    ),
                  ],
                ]),
              ),
              const SizedBox(width: 12),
              Text(inr(_n(ai['balance_paise'])), style: numStyle(size: 16)),
            ]),
          ),
        ]),
      ),
      if (plan['lapsed'] == true) ...[
        const SizedBox(height: 12),
        InlineNotice(
          'Your ${planTitle(plan['bought'])} plan has ended, so you are on Free. Everyone stays in and nothing is deleted. '
          'Adding students or tutors past Free\'s room waits until you buy a plan again.',
          tone: Tone.neutral,
          icon: Ph.clock,
        ),
      ],
      const SectionRule('Plans', padding: _rule),
      for (final (i, p) in plans.indexed) ...[
        if (i > 0) const SizedBox(height: gapRow),
        _PlanCard(
          p: p,
          current: p['name'] == name,
          whyNot: _whyNot(d, '${p['name']}'),
          startPaise: _n(p['ai_start_paise']),
          waitingPaise: waiting.where((w) => w['plan'] == p['name']).fold(0, (sum, w) => sum + _n(w['amount_paise'])),
        ),
      ],
      const SizedBox(height: 12),
      Fig(
        'A plan starts the day its payment is checked. When it ends, you are on Free again: nobody is turned off and nothing is deleted.',
        style: labelStyle,
      ),
      if (waiting.isNotEmpty) ...[
        SectionRule('Waiting to be checked', count: waiting.length, padding: _rule),
        for (final (i, w) in waiting.indexed) ...[
          if (i > 0) const SizedBox(height: 8),
          RowTile(
            leading: Icon(Ph.clock, size: 20, color: muted),
            title: '${planTitle(w['plan'])}, ${f.count(_n(w['months']), 'month')} · ${inrWhole(_n(w['amount_paise']))}',
            meta: 'Sent ${f.when(f.parseTime(w['created_at']) ?? DateTime.now())} · ${w['code']}',
          ),
        ],
      ],
    ];
  }

  Widget _use(IconData icon, String what, int used, int room) {
    final full = room > 0 && used >= room;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 13),
      child: Row(children: [
        Icon(icon, size: 19, color: muted),
        const SizedBox(width: 12),
        Expanded(child: Fig(what, style: rowTitleStyle)),
        if (full) ...[Fig('Full', style: labelStyle.copyWith(color: warning, fontWeight: FontWeight.w700)), const SizedBox(width: 10)],
        Text.rich(TextSpan(children: [
          TextSpan(text: '$used', style: numStyle(size: 16, color: full ? warning : ink)),
          TextSpan(text: ' of $room', style: numStyle(size: 14, weight: FontWeight.w600, color: muted)),
        ])),
      ]),
    );
  }
}

/// One plan: its price, its room and its AI, and the button to buy it (or why it cannot be bought here).
class _PlanCard extends StatelessWidget {
  const _PlanCard({required this.p, required this.current, required this.whyNot, required this.startPaise, this.waitingPaise = 0});
  final Map<String, dynamic> p;
  final bool current;
  final String? whyNot;
  final int startPaise;

  /// What has been paid for this plan and is still waiting to be checked. Paying again is not lost: once checked, it adds months after
  /// the first. The card says so, so nobody pays twice thinking the first did not go through.
  final int waitingPaise;

  @override
  Widget build(BuildContext context) {
    final name = '${p['name']}';
    final price = p['price_month_paise'] == null ? null : _n(p['price_month_paise']);
    final aiMonth = _n(p['ai_month_paise']);
    final c = credit.value;
    final aiPages = c?.pagesFor(name == 'free' ? startPaise : aiMonth);
    return Surface(
      shadow: e1,
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 16),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
          Text(planTitle(name), style: titleStyle),
          if (current) ...[
            const SizedBox(width: 10),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
              decoration: BoxDecoration(color: fill, borderRadius: BorderRadius.circular(rPill)),
              child: Text('Your plan', style: chipStyle.copyWith(color: ink, fontWeight: FontWeight.w700)),
            ),
          ],
          const Spacer(),
          if (name == 'free')
            Text(inrWhole(0), style: numStyle(size: 17))
          else if (price == null)
            Fig('Price soon', style: labelStyle.copyWith(color: muted))
          else
            Text.rich(TextSpan(children: [
              TextSpan(text: inrWhole(price), style: numStyle(size: 17)),
              TextSpan(text: ' a month', style: labelStyle.copyWith(color: muted)),
            ])),
        ]),
        const SizedBox(height: 10),
        Fig('Room for ${f.count(_n(p['students']), 'student')} and ${f.count(_n(p['tutors']), 'tutor')}', style: bodyStyle.copyWith(color: body)),
        const SizedBox(height: 4),
        Fig(
          name == 'free'
              ? (startPaise > 0 ? '${inrWhole(startPaise)} of AI to start${aiPages == null ? '' : ', about ${f.count(aiPages, 'page')}'}' : 'No AI')
              : '${inrWhole(aiMonth)} of AI every month${aiPages == null ? '' : ', about ${f.count(aiPages, 'page')}'}',
          style: bodyStyle.copyWith(color: body),
          numColor: ink,
        ),
        if (name != 'free' && whyNot == null) ...[
          if (waitingPaise > 0) ...[
            const SizedBox(height: 12),
            InlineNotice(
              '${inrWhole(waitingPaise)} you paid for ${planTitle(name)} is waiting to be checked. Paying again adds more months.',
              tone: Tone.neutral,
              icon: Ph.clock,
            ),
          ],
          const SizedBox(height: 14),
          current || waitingPaise > 0
              ? SecondaryButton('Add months', onTap: () => context.push('/t/plan/buy?plan=$name'))
              : PrimaryButton('Move to ${planTitle(name)}', onTap: () => context.push('/t/plan/buy?plan=$name')),
        ] else if (name != 'free' && whyNot != null && !current) ...[
          const SizedBox(height: 10),
          Fig(whyNot!, style: labelStyle.copyWith(color: muted)),
        ],
      ]),
    );
  }
}

// ---------------------------------------------------------------- buying a plan

/// Choose how many months, pay by UPI with the tuition's code in the note, then say so. The plan starts once the developer has
/// checked the payment.
class BuyPlanScreen extends StatefulWidget {
  const BuyPlanScreen({super.key, required this.plan});
  final String plan;

  @override
  State<BuyPlanScreen> createState() => _BuyPlanScreenState();
}

class _BuyPlanScreenState extends State<BuyPlanScreen> {
  Map<String, dynamic>? _d;
  String? _error;
  int _months = 1;
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
      final d = Map<String, dynamic>.from(await api.get('/teacher/plan'));
      if (mounted) setState(() => _d = d);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _paid() async {
    setState(() => _sending = true);
    try {
      final r = await api.post('/teacher/plan/requests', {'plan': widget.plan, 'months': _months});
      if (mounted) context.pushReplacement('/t/plan/sent', extra: Map<String, dynamic>.from(r['request'] as Map));
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

  Future<void> _payHere(String link) async {
    if (await openUpiApp(link) || !mounted) return;
    await showCentredCard<void>(
      context,
      title: 'No UPI app here',
      builder: (ctx) => Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Fig('This phone has no UPI app. Copy the UPI id and the code, and pay from a phone that has one.', style: bodyStyle),
        const SizedBox(height: 18),
        PrimaryButton('OK', onTap: () => Navigator.of(ctx).pop()),
      ]),
    );
  }

  @override
  Widget build(BuildContext context) {
    final d = _d;
    final title = planTitle(widget.plan);
    final current = '${d?['plan']?['name']}';
    final same = current == widget.plan;
    final p = d == null ? null : _list(d['plans']).where((x) => x['name'] == widget.plan).firstOrNull;
    final price = p?['price_month_paise'] == null ? null : _n(p!['price_month_paise']);
    final whyNot = d == null ? null : _whyNot(d, widget.plan);
    final total = (price ?? 0) * _months;
    return PushedPanel(
      kicker: 'Plan',
      title: same ? 'More of $title' : 'Move to $title',
      footer: d == null || whyNot != null || price == null
          ? null
          : Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              PrimaryButton('I have paid ${inrWhole(total)}', busy: _sending, onTap: _paid),
              const SizedBox(height: 9),
              Fig('The plan starts once the payment is checked.', style: labelStyle, textAlign: TextAlign.center),
            ]),
      children: [
        if (d == null && _error != null)
          ErrorState(message: _error!, onRetry: _load)
        else if (d == null)
          const LoadingState(rows: 3)
        else if (whyNot != null || price == null) ...[
          const SizedBox(height: 16),
          InlineNotice(whyNot ?? 'Plans go on sale soon.', tone: Tone.neutral, icon: Ph.clock),
        ] else
          ..._body(d, price, total, same, current),
      ],
    );
  }

  List<Widget> _body(Map<String, dynamic> d, int price, int total, bool same, String current) {
    final pay = Map<String, dynamic>.from((d['pay'] as Map?) ?? const {});
    final months = ((pay['months'] as List?) ?? const [1]).map(_n).toList();
    final upiId = '${pay['upi_id']}';
    final upiName = '${pay['upi_name'] ?? ''}';
    final code = '${pay['code']}';
    final link = upiLink(id: upiId, name: upiName, paise: total, note: code);
    final plan = (d['plan'] as Map?) ?? const {};
    return [
      const SizedBox(height: 10),
      Fig(
        same
            ? 'These months are added after your plan\'s last day, ${_lastDay(plan['last_day'])}.'
            : current == 'free'
                ? '${planTitle(widget.plan)} starts the day your payment is checked.'
                : '${planTitle(widget.plan)} starts the day your payment is checked, in place of ${planTitle(current)}. The days left of ${planTitle(current)} do not carry over.',
        style: bodyStyle.copyWith(color: muted),
      ),
      const SectionRule('How long', padding: _rule),
      LayoutBuilder(
        builder: (context, box) {
          final w = (box.maxWidth - gapRow) / 2;
          return Wrap(spacing: gapRow, runSpacing: gapRow, children: [
            for (final m in months)
              SizedBox(
                width: w,
                child: Pressable(
                  label: f.count(m, 'month'),
                  onTap: () => setState(() => _months = m),
                  child: Container(
                    constraints: const BoxConstraints(minHeight: 68),
                    padding: const EdgeInsets.fromLTRB(16, 13, 16, 12),
                    decoration: m == _months
                        ? BoxDecoration(color: actionFill, borderRadius: BorderRadius.circular(rCard), boxShadow: e4)
                        : surface(radius: rCard, shadow: e1),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                      Text(f.count(m, 'month'), style: rowTitleStyle.copyWith(color: m == _months ? actionInk : ink)),
                      const SizedBox(height: 4),
                      Text(inrWhole(price * m), style: numStyle(size: 18, color: m == _months ? actionInk : ink)),
                    ]),
                  ),
                ),
              ),
          ]);
        },
      ),
      const SectionRule('How to pay', padding: _rule),
      Surface(
        shadow: e1,
        child: Column(children: [
          _step(1, 'Pay ${inrWhole(total)} by UPI to', copy: upiId),
          if (upiName.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(55, 0, 17, 12),
              child: Align(alignment: Alignment.centerLeft, child: Fig('The UPI app shows the name $upiName.', style: labelStyle.copyWith(color: muted))),
            ),
          Container(height: 1, color: hairline),
          _step(2, 'Put this code in the payment note', copy: code),
          Container(height: 1, color: hairline),
          _step(3, 'Come back and tap I have paid'),
        ]),
      ),
      const SizedBox(height: 16),
      // A computer has no UPI app: there the code is scanned with a phone, which fills in the amount and the note.
      if (savesFiles) ...[
        Center(child: QrBox(data: link, size: 200, label: 'A UPI code to pay ${inrWhole(total)}')),
        const SizedBox(height: 10),
        Fig('Or scan this with a UPI app on your phone. It fills in the amount and the code.', style: labelStyle, textAlign: TextAlign.center),
      ] else
        SecondaryButton('Pay in a UPI app on this phone', icon: Ph.arrowSquareOut, onTap: () => _payHere(link)),
    ];
  }

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

// ---------------------------------------------------------------- payment sent

/// After "I have paid": what was asked for, and that nothing more is needed.
class PlanSentScreen extends StatelessWidget {
  const PlanSentScreen({super.key, required this.request});
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
      kicker: 'Plan',
      title: 'Payment sent',
      footer: PrimaryButton('Done', onTap: () => Navigator.of(context).maybePop()),
      children: [
        const SizedBox(height: 20),
        Surface(
          padding: const EdgeInsets.fromLTRB(20, 20, 20, 8),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Fig('Waiting for the payment to be checked', style: bodyStyle.copyWith(color: muted, fontWeight: FontWeight.w600)),
            const SizedBox(height: 12),
            Text(inrWhole(_n(request['amount_paise'])), style: numStyle(size: 40)),
            const SizedBox(height: 18),
            Container(height: 1, color: hairline),
            kv('Plan', '${planTitle(request['plan'])}, ${f.count(_n(request['months']), 'month')}'),
            Container(height: 1, color: hairline),
            kv('Code', '${request['code']}', mono: true),
            Container(height: 1, color: hairline),
            kv('Paid to', '${request['upi_id']}', mono: true),
            if (sent != null) ...[
              Container(height: 1, color: hairline),
              kv('Sent', f.when(sent)),
            ],
          ]),
        ),
        const SizedBox(height: 16),
        Fig('Paid already? That is all you need to do. Your plan starts once the payment is checked.', style: labelStyle),
      ],
    );
  }
}
