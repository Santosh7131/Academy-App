part of 'credit.dart';

// Plans, the developer's side (api/src/routes/plans.ts): what each plan has room for, the AI it gives each month and its price, and
// where plans are sold; the plan payments waiting to be checked against the UPI app; and a client's plan on its page, given or ended
// by hand. It shares the AI credit's pieces (the receive card, the facts card), so it is a part of credit.dart.

/// "Free", "Basic" or "Pro".
String planName(Object? p) => switch ('$p') { 'basic' => 'Basic', 'pro' => 'Pro', _ => 'Free' };

/// "23 Feb 2027" from the server's "2027-02-23".
String _planDay(Object? ymd) {
  final d = DateTime.tryParse('$ymd');
  return d == null ? '-' : DateFormat('d MMM y').format(d);
}

const _plans = ['free', 'basic', 'pro'];

// ---------------------------------------------------------------- deciding a plan payment

/// Asks first, then marks a plan payment received or declined. A smaller plan paid for while a bigger one runs would end the bigger
/// one today: the server refuses it, and this asks before giving it anyway. True when the page should load again.
Future<bool> settlePlanRequest(BuildContext context, Map<String, dynamic> r, {required bool receive, VoidCallback? onSending}) async {
  final amount = f.inr(f.asInt(r['amount_paise']));
  final what = '${planName(r['plan'])}, ${f.plural(f.asInt(r['months']), 'month')}';
  final code = '${r['code']}';
  final client = r['client'] == null ? null : '${r['client']}';
  String? ref;
  if (receive) {
    ref = await showCentredCard<String>(
      context,
      title: 'Mark $amount received?',
      subtitle: client == null ? what : '$client · $what',
      builder: (_) => _ReceiveCard(code: code, effect: 'The plan starts, or runs on, at once'),
    );
    if (ref == null) return false;
  } else {
    final yes = await confirmCard(
      context,
      title: 'Decline $amount?',
      body: '${client == null ? '' : '$client asked for $what. '}Decline it only when no payment with $code in its note reached you. '
          'No plan is given.',
      confirm: 'Decline',
      destructive: true,
    );
    if (!yes) return false;
  }
  if (!context.mounted) return false;
  onSending?.call();
  Future<bool> send({bool replace = false}) async {
    await api.post('/admin/plans/requests/${r['id']}/${receive ? 'receive' : 'decline'}', {
      if (ref != null && ref.isNotEmpty) 'ref': ref,
      if (replace) 'replace': true,
    });
    return true;
  }

  try {
    return await send();
  } on ApiException catch (e) {
    if (e.code == 'smaller_plan' && context.mounted) {
      final yes = await confirmCard(
        context,
        title: 'Give ${planName(r['plan'])} now?',
        body: '${e.message} Give it now only if the client asked for that. Otherwise leave it waiting and give it by hand once the '
            'bigger plan ends, or decline it and return the money.',
        confirm: 'Give it now',
        destructive: true,
      );
      if (!yes || !context.mounted) return false;
      try {
        return await send(replace: true);
      } on ApiException catch (e2) {
        if (context.mounted) showProblem(context, e2);
        return e2.status == 409 || e2.status == 404;
      }
    }
    if (context.mounted) showProblem(context, e);
    // Decided already, or gone: what the page shows is out of date.
    return e.status == 409 || e.status == 404;
  }
}

// ---------------------------------------------------------------- the payments

/// The plan payments waiting to be checked, the last ones decided, and this month's plan money.
class PlanRequestsScreen extends StatefulWidget {
  const PlanRequestsScreen({super.key});

  @override
  State<PlanRequestsScreen> createState() => _PlanRequestsScreenState();
}

class _PlanRequestsScreenState extends State<PlanRequestsScreen> with WidgetsBindingObserver, AutoRefresh<PlanRequestsScreen> {
  Map<String, dynamic>? _d;
  String? _error;
  final _busy = <String>{};

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
    try {
      final d = await api.get('/admin/plans');
      if (!mounted) return;
      markLoaded();
      setState(() {
        _d = Map<String, dynamic>.from(d);
        _error = null;
      });
    } on ApiException catch (e) {
      if (mounted && _d == null) setState(() => _error = e.message);
    }
  }

  Future<void> _settle(Map<String, dynamic> r, {required bool receive}) async {
    final id = '${r['id']}';
    if (_busy.contains(id)) return;
    final reload = await settlePlanRequest(context, r, receive: receive, onSending: () => setState(() => _busy.add(id)));
    if (reload && mounted) await _load();
    if (mounted) setState(() => _busy.remove(id));
  }

  @override
  Widget build(BuildContext context) {
    final d = _d;
    if (d == null) {
      return PushedPanel(kicker: 'Plans', title: 'Payments', onRefresh: _load, children: [
        if (_error != null) ErrorState(message: _error!, onRetry: _load) else const LoadingState(),
      ]);
    }
    final waiting = (d['waiting'] as List).cast<Map<String, dynamic>>();
    final done = (d['done'] as List).cast<Map<String, dynamic>>();
    final month = Map<String, dynamic>.from(d['month'] as Map);
    final on = Map<String, dynamic>.from(d['clients'] as Map);
    return PushedPanel(
      kicker: waiting.isEmpty ? 'Plans · none waiting' : 'Plans · ${waiting.length} waiting',
      title: 'Payments',
      onRefresh: _load,
      children: [
        const SizedBox(height: 10),
        Fig('Find the payment with the code in its note in your UPI app, then mark it received. The plan starts, or runs on, at once.',
            style: bodyStyle.copyWith(color: muted)),
        SectionRule('Waiting', count: waiting.length, padding: _rule),
        if (waiting.isEmpty)
          Fig('Nothing waiting. A payment shows here when a tutor says they paid for a plan.', style: bodyStyle.copyWith(color: muted))
        else
          for (final (i, r) in waiting.indexed) ...[
            if (i > 0) const SizedBox(height: gapRow),
            _PlanRequestCard(r, busy: _busy.contains('${r['id']}'), onReceive: () => _settle(r, receive: true), onDecline: () => _settle(r, receive: false)),
          ],
        SectionRule('This month', padding: _rule),
        _Facts([
          _Fact('Paid for plans', f.inr(f.asInt(month['paid_paise']))),
          if (f.asInt(month['given']) > 0) _Fact('Given free', f.plural(f.asInt(month['given']), 'time')),
          for (final p in _plans) _Fact('On ${planName(p)}', f.plural(f.asInt(on[p]), 'client')),
        ]),
        if (done.isNotEmpty) ...[
          SectionRule('Done', count: done.length, padding: _rule),
          for (final (i, r) in done.indexed) ...[
            if (i > 0) const SizedBox(height: gapRow),
            RowTile(
              title: '${r['client']}',
              meta: '${r['status'] == 'received' ? 'Received' : 'Declined'}'
                  '${f.parseTime(r['decided_at']) == null ? '' : ' ${_whenInLine(f.parseTime(r['decided_at'])!)}'}'
                  ' · ${planName(r['plan'])}, ${f.plural(f.asInt(r['months']), 'month')} · ${r['code']}',
              trailing: Text(f.inr(f.asInt(r['amount_paise'])), style: numStyle(size: 14.5, color: r['status'] == 'received' ? success : faint)),
            ),
          ],
        ],
        const SizedBox(height: 8),
      ],
    );
  }
}

/// A waiting plan payment: who and when, the amount, the plan and months, the plan the client is on now, the code, and what to do.
class _PlanRequestCard extends StatelessWidget {
  const _PlanRequestCard(this.r, {required this.busy, required this.onReceive, required this.onDecline});
  final Map<String, dynamic> r;
  final bool busy;
  final VoidCallback onReceive;
  final VoidCallback onDecline;

  @override
  Widget build(BuildContext context) {
    final asked = f.parseTime(r['created_at']);
    final owner = r['owner'] == null ? null : '${r['owner']}';
    final now = '${r['client_plan']}';
    return Surface(
      shadow: e1,
      padding: const EdgeInsets.fromLTRB(17, 16, 17, 15),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          AppAvatar(name: '${r['client']}', seed: '${r['client_id']}', size: 42),
          const SizedBox(width: 13),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Fig('${r['client']}', style: rowTitleStyle, maxLines: 2),
              const SizedBox(height: 2),
              Fig([?owner, if (asked != null) _whenInLine(asked)].join(' · '), style: labelStyle.copyWith(color: muted), maxLines: 1),
            ]),
          ),
          const SizedBox(width: 10),
          Text(f.inr(f.asInt(r['amount_paise'])), style: numStyle(size: 18)),
        ]),
        const SizedBox(height: 12),
        Fig(
          '${planName(r['plan'])} for ${f.plural(f.asInt(r['months']), 'month')} · '
          '${now == 'free' ? 'on Free now' : 'on ${planName(now)} until ${_planDay(r['client_last_day'])}'}',
          style: bodyStyle,
        ),
        const SizedBox(height: 10),
        Row(children: [
          Flexible(child: Text('Code in the payment note', style: labelStyle.copyWith(fontSize: 12, color: muted))),
          const SizedBox(width: 8),
          Container(
            height: 26,
            padding: const EdgeInsets.symmetric(horizontal: 10),
            alignment: Alignment.center,
            decoration: BoxDecoration(color: fill, borderRadius: BorderRadius.circular(9)),
            child: Text('${r['code']}', style: numStyle(size: 13)),
          ),
        ]),
        const SizedBox(height: 13),
        Row(children: [
          Expanded(child: _ActButton('Mark received', icon: Ph.check, primary: true, busy: busy, onTap: onReceive)),
          const SizedBox(width: 8),
          Expanded(child: _ActButton('Decline', onTap: busy ? null : onDecline)),
        ]),
      ]),
    );
  }
}

// ---------------------------------------------------------------- the settings

/// Each plan's room for students and tutors, Basic's and Pro's AI each month and price, and where plans are sold.
class PlanSettingsScreen extends StatefulWidget {
  const PlanSettingsScreen({super.key});

  @override
  State<PlanSettingsScreen> createState() => _PlanSettingsScreenState();
}

class _PlanSettingsScreenState extends State<PlanSettingsScreen> {
  Map<String, dynamic>? _s;
  String? _error;
  String? _saving;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final d = await api.get('/admin/plans');
      if (!mounted) return;
      setState(() {
        _s = Map<String, dynamic>.from(d['settings'] as Map);
        _error = null;
      });
    } on ApiException catch (e) {
      if (mounted && _s == null) setState(() => _error = e.message);
    }
  }

  /// Sends the one field that changed; the server answers with all the settings.
  Future<void> _save(String key, Object? value) async {
    if (_saving != null) return;
    setState(() => _saving = key);
    try {
      final r = await api.put('/admin/plans/settings', {key: value});
      if (mounted) setState(() => _s = Map<String, dynamic>.from((r as Map)['settings'] as Map));
    } on ApiException catch (e) {
      if (mounted) showProblem(context, e);
    } finally {
      if (mounted) setState(() => _saving = null);
    }
  }

  Future<void> _editCount(String key, String title, int now, {required int most, required String note}) async {
    final v = await showCentredCard<int>(context, title: title, builder: (_) => _CountCard(count: now, most: most, note: note));
    if (v != null && v != now) await _save(key, v);
  }

  Future<void> _editAi(String key, String title, int now) async {
    final v = await showCentredCard<int>(
      context,
      title: title,
      builder: (_) => _AmountCard(
        paise: now,
        most: 10000000,
        note: "Each month of the plan tops the client's credit up to this, once, and never lowers it. Unused AI does not carry over.",
      ),
    );
    if (v != null && v != now) await _save(key, v);
  }

  Future<void> _editPrice(String key, String plan, int? now) async {
    // -1: taken off sale.
    final v = await showCentredCard<int>(context, title: 'Price of $plan, a month', builder: (_) => _PriceCard(paise: now));
    if (v == null || v == (now ?? -1)) return;
    await _save(key, v < 0 ? null : v);
  }

  @override
  Widget build(BuildContext context) {
    final s = _s;
    if (s == null) {
      return PushedPanel(kicker: 'Admin · Settings', title: 'Plans', onRefresh: _load, children: [
        if (_error != null) ErrorState(message: _error!, onRetry: _load) else const LoadingState(),
      ]);
    }
    final where = '${s['pay_where']}';
    final onSale = ['basic', 'pro'].any((p) => (s[p] as Map)['price_month_paise'] != null);
    return PushedPanel(
      kicker: 'Admin · Settings',
      title: 'Plans',
      onRefresh: _load,
      children: [
        const SizedBox(height: 10),
        Fig('What each plan has room for, the AI it gives each month and its price. Tutors see these on their Plan screen.',
            style: bodyStyle.copyWith(color: muted)),
        if (!onSale) ...[
          const SizedBox(height: 12),
          const InlineNotice('No plan has a price, so none is on sale. Tutors see "Price soon".', icon: Ph.warning),
        ],
        for (final p in _plans) ...[
          SectionRule(planName(p), padding: _rule),
          _Facts([
            _Fact('Students', f.count(f.asInt((s[p] as Map)['students'])),
                busy: _saving == '${p}_students',
                onTap: () => _editCount('${p}_students', 'Students on ${planName(p)}', f.asInt((s[p] as Map)['students']), most: 100000,
                    note: 'How many students can be in at once. Clients already past it keep everyone; only adding more waits.')),
            _Fact('Tutors', f.count(f.asInt((s[p] as Map)['tutors'])),
                busy: _saving == '${p}_tutors',
                onTap: () => _editCount('${p}_tutors', 'Tutors on ${planName(p)}', f.asInt((s[p] as Map)['tutors']), most: 1000,
                    note: 'How many tutors, the owner among them. Clients already past it keep everyone; only adding more waits.')),
            if (p != 'free') ...[
              _Fact('AI each month', f.inr(f.asInt((s[p] as Map)['ai_month_paise'])),
                  busy: _saving == '${p}_ai_month_paise',
                  onTap: () => _editAi('${p}_ai_month_paise', 'AI each month on ${planName(p)}', f.asInt((s[p] as Map)['ai_month_paise']))),
              _Fact(
                'Price a month',
                (s[p] as Map)['price_month_paise'] == null ? 'Not on sale' : f.inr(f.asInt((s[p] as Map)['price_month_paise'])),
                faintValue: (s[p] as Map)['price_month_paise'] == null,
                busy: _saving == '${p}_price_month_paise',
                onTap: () => _editPrice('${p}_price_month_paise', planName(p),
                    (s[p] as Map)['price_month_paise'] == null ? null : f.asInt((s[p] as Map)['price_month_paise'])),
              ),
            ],
          ]),
          if (p == 'free') ...[
            const SizedBox(height: 10),
            Fig('Free gives the free credit to start (in the AI credit settings) and no AI each month.', style: labelStyle),
          ],
        ],
        SectionRule('Where plans are sold', padding: _rule),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final (v, label) in [('both', 'App and web'), ('web', 'Web only'), ('app', 'App only')])
            SegChip(label, selected: where == v, onTap: _saving == null && where != v ? () => _save('pay_where', v) : null),
        ]),
        const SizedBox(height: 10),
        Fig('Tutors pay to the UPI id in the AI credit settings. Without it, no plan can be bought.', style: labelStyle),
        const SizedBox(height: 8),
      ],
    );
  }
}

/// Changes a whole number: the field, a note, and Save. Pops with the number.
class _CountCard extends StatefulWidget {
  const _CountCard({required this.count, required this.most, required this.note});
  final int count;
  final int most;
  final String note;

  @override
  State<_CountCard> createState() => _CountCardState();
}

class _CountCardState extends State<_CountCard> {
  late final _c = TextEditingController(text: '${widget.count}');

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final n = int.tryParse(_c.text.trim());
    final ok = n != null && n >= 1 && n <= widget.most;
    final reason = n == null ? 'Type a whole number.' : (n < 1 ? 'At least 1.' : (n > widget.most ? 'At most ${f.count(widget.most)}.' : null));
    return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      _Box(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: TextField(
            controller: _c,
            autofocus: true,
            onChanged: (_) => setState(() {}),
            onSubmitted: (_) {
              if (ok) Navigator.of(context).pop(n);
            },
            keyboardType: TextInputType.number,
            textInputAction: TextInputAction.done,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
            cursorColor: ink,
            style: numStyle(size: 15, weight: FontWeight.w600),
            decoration: const InputDecoration(isDense: true, border: InputBorder.none, contentPadding: EdgeInsets.symmetric(vertical: 15)),
          ),
        ),
      ),
      const SizedBox(height: 12),
      Fig(widget.note, style: bodyStyle.copyWith(color: muted)),
      const SizedBox(height: 20),
      PrimaryButton('Save', onTap: ok ? () => Navigator.of(context).pop(n) : null, disabledReason: reason),
    ]);
  }
}

/// A plan's price a month: the amount and Save, or Take off sale. Pops with the price in paise, or -1 to take the plan off sale.
class _PriceCard extends StatefulWidget {
  const _PriceCard({required this.paise});
  final int? paise;

  @override
  State<_PriceCard> createState() => _PriceCardState();
}

class _PriceCardState extends State<_PriceCard> {
  late final _amount = TextEditingController(text: widget.paise == null ? '' : _typed(widget.paise!));

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = f.paiseOf(_amount.text);
    final ok = p != null && p >= 100 && p <= 100000000;
    final reason = p == null ? 'Type the price in rupees, like 499.' : (p < 100 ? 'At least ₹1.' : (p > 100000000 ? 'At most ₹10,00,000.' : null));
    return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      _RupeeField(
        controller: _amount,
        autofocus: true,
        onChanged: (_) => setState(() {}),
        onSubmitted: (_) {
          if (ok) Navigator.of(context).pop(p);
        },
      ),
      const SizedBox(height: 12),
      Fig('Tutors see the new price at once. A payment already sent keeps the price it was sent at.', style: bodyStyle.copyWith(color: muted)),
      const SizedBox(height: 20),
      PrimaryButton('Save', onTap: ok ? () => Navigator.of(context).pop(p) : null, disabledReason: reason),
      if (widget.paise != null) ...[
        const SizedBox(height: 10),
        SecondaryButton('Take off sale', tint: danger, onTap: () => Navigator.of(context).pop(-1)),
      ],
    ]);
  }
}

// ---------------------------------------------------------------- a client's plan

/// A client's plan on its page: the plan and until when, the room it uses, the payments waiting, every stretch given, and buttons to
/// give a plan by hand or end it.
class ClientPlan extends StatefulWidget {
  const ClientPlan({super.key, required this.clientId, required this.clientName, required this.onChanged});
  final String clientId;
  final String clientName;

  /// Loads the page again, after a plan was given or ended.
  final Future<void> Function() onChanged;

  @override
  State<ClientPlan> createState() => _ClientPlanState();
}

class _ClientPlanState extends State<ClientPlan> {
  Map<String, dynamic>? _d;
  String? _error;
  bool _busy = false;
  final _settling = <String>{};

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final d = await api.get('/admin/clients/${widget.clientId}/plan');
      if (mounted) {
        setState(() {
          _d = Map<String, dynamic>.from(d);
          _error = null;
        });
      }
    } on ApiException catch (e) {
      // A server before plans has no such page: the section stays away.
      if (mounted) setState(() => _error = e.status == 404 ? '' : e.message);
    }
  }

  Future<void> _changed() async {
    await _load();
    await widget.onChanged();
  }

  Future<void> _give() async {
    final g = await showCentredCard<Map<String, dynamic>>(context, title: 'Give a plan', subtitle: widget.clientName, builder: (_) => const _GivePlanCard());
    if (g == null || !mounted) return;
    setState(() => _busy = true);
    try {
      try {
        await api.post('/admin/clients/${widget.clientId}/plan', g);
      } on ApiException catch (e) {
        if (e.code != 'smaller_plan' || !mounted) rethrow;
        final yes = await confirmCard(context,
            title: 'Give ${planName(g['plan'])} now?', body: '${e.message} Give it now only if the client asked for that.', confirm: 'Give it now', destructive: true);
        if (!yes) return;
        await api.post('/admin/clients/${widget.clientId}/plan', {...g, 'replace': true});
      }
      await _changed();
    } on ApiException catch (e) {
      if (mounted) showProblem(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _end(String plan) async {
    final yes = await confirmCard(
      context,
      title: 'End ${planName(plan)} today?',
      body: '${widget.clientName} is on Free from today. Nobody is turned off and nothing is deleted; adding students or tutors past '
          "Free's room waits. Their AI credit stays. This does not return any money.",
      confirm: 'End plan',
      destructive: true,
    );
    if (!yes || !mounted) return;
    setState(() => _busy = true);
    try {
      await api.delete('/admin/clients/${widget.clientId}/plan');
      await _changed();
    } on ApiException catch (e) {
      if (mounted) showProblem(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _receive(Map<String, dynamic> r) async {
    final id = '${r['id']}';
    if (_settling.contains(id)) return;
    final reload = await settlePlanRequest(context, {...r, 'client': widget.clientName}, receive: true, onSending: () => setState(() => _settling.add(id)));
    if (reload) await _changed();
    if (mounted) setState(() => _settling.remove(id));
  }

  @override
  Widget build(BuildContext context) {
    final d = _d;
    if (d == null) {
      if (_error == '') return const SizedBox.shrink();
      return _error == null ? const LoadingState(rows: 1) : InlineNotice(_error!, icon: Ph.warning);
    }
    final plan = Map<String, dynamic>.from(d['plan'] as Map);
    final name = '${plan['name']}';
    final used = Map<String, dynamic>.from(d['used'] as Map);
    final periods = (d['periods'] as List? ?? const []).cast<Map<String, dynamic>>();
    final waiting = (d['waiting'] as List? ?? const []).cast<Map<String, dynamic>>();
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Container(
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
        decoration: surface(radius: rCard, shadow: e1),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Plan', style: labelStyle.copyWith(fontSize: 12.5, color: muted)),
          const SizedBox(height: 8),
          Text(planName(name), style: titleStyle),
          const SizedBox(height: 6),
          Fig(
            name != 'free'
                ? 'Until ${_planDay(plan['last_day'])}${plan['next_month_on'] == null ? '' : ' · AI again ${_planDay(plan['next_month_on'])}'}'
                : plan['lapsed'] == true
                    ? '${planName(plan['bought'])} ended; on Free since ${_planDay(plan['until'])}'
                    : 'Never bought a plan',
            style: bodyStyle.copyWith(color: muted),
          ),
          const SizedBox(height: 4),
          Fig('${f.plural(f.asInt(used['students']), 'student')} · ${f.plural(f.asInt(used['tutors']), 'tutor')} in now',
              style: bodyStyle.copyWith(color: muted), numColor: ink),
          const SizedBox(height: 16),
          Row(children: [
            Expanded(child: _ActButton('Give a plan', icon: Ph.plus, primary: true, busy: _busy, onTap: _give)),
            if (name != 'free') ...[
              const SizedBox(width: 8),
              Expanded(child: _ActButton('End plan', onTap: _busy ? null : () => _end(name))),
            ],
          ]),
        ]),
      ),
      if (waiting.isNotEmpty) ...[
        SectionRule('Plan payments waiting', count: waiting.length, padding: _rule),
        for (final (i, r) in waiting.indexed) ...[
          if (i > 0) const SizedBox(height: gapRow),
          Container(
            padding: const EdgeInsets.fromLTRB(17, 14, 15, 14),
            decoration: surface(radius: rCard, shadow: e1),
            child: Row(children: [
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Fig('${f.inr(f.asInt(r['amount_paise']))} · ${planName(r['plan'])}, ${f.plural(f.asInt(r['months']), 'month')}', style: rowTitleStyle, maxLines: 2),
                  const SizedBox(height: 2),
                  Fig('Code ${r['code']}', style: labelStyle.copyWith(color: muted), maxLines: 1),
                ]),
              ),
              const SizedBox(width: 10),
              _ActButton('Mark received', primary: true, height: 38, busy: _settling.contains('${r['id']}'), onTap: () => _receive(r)),
            ]),
          ),
        ],
      ],
      if (periods.isNotEmpty) ...[
        SectionRule('Plans given', count: periods.length, padding: _rule),
        for (final (i, p) in periods.indexed) ...[
          if (i > 0) const SizedBox(height: gapRow),
          RowTile(
            title: '${planName(p['plan'])}, ${f.plural(f.asInt(p['months']), 'month')}',
            meta: '${_planDay(p['from'])} to ${_planDay(p['last_day'])}${p['ref'] == null ? '' : ' · ${shortRef('${p['ref']}')}'}',
            trailing: f.asInt(p['amount_paise']) == 0
                ? Text('Given', style: labelStyle.copyWith(color: muted))
                : Text(f.inr(f.asInt(p['amount_paise'])), style: numStyle(size: 14.5, color: success)),
          ),
        ],
      ],
    ]);
  }
}

/// Giving a plan by hand: which, for how long, what was received (nothing, for months given free), and the payment's reference.
/// Pops with the body for POST /admin/clients/:id/plan.
class _GivePlanCard extends StatefulWidget {
  const _GivePlanCard();

  @override
  State<_GivePlanCard> createState() => _GivePlanCardState();
}

class _GivePlanCardState extends State<_GivePlanCard> {
  String _plan = 'basic';
  int _months = 1;
  final _amount = TextEditingController();
  final _ref = TextEditingController();

  @override
  void dispose() {
    _amount.dispose();
    _ref.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final typed = _amount.text.trim();
    final paise = typed.isEmpty ? 0 : f.paiseOf(typed);
    final ok = paise != null && paise <= 100000000;
    return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const _FieldLabel('Plan'),
      Wrap(spacing: 8, children: [
        for (final p in ['basic', 'pro']) SegChip(planName(p), selected: _plan == p, onTap: () => setState(() => _plan = p)),
      ]),
      const SizedBox(height: 16),
      const _FieldLabel('How long'),
      Wrap(spacing: 8, runSpacing: 8, children: [
        for (final m in [1, 3, 6, 12, 24]) SegChip(f.plural(m, 'month'), selected: _months == m, onTap: () => setState(() => _months = m)),
      ]),
      const SizedBox(height: 16),
      const _FieldLabel('Received, if it was paid'),
      _RupeeField(controller: _amount, onChanged: (_) => setState(() {})),
      const SizedBox(height: 12),
      const _FieldLabel('UPI transaction id, to keep with it'),
      _Box(child: BareField(controller: _ref, placeholder: 'Optional', maxLength: 80, action: TextInputAction.done)),
      const SizedBox(height: 12),
      Fig('The same plan, still running, runs on after its last day. Any other starts today.', style: bodyStyle.copyWith(color: muted)),
      const SizedBox(height: 20),
      PrimaryButton(
        'Give ${planName(_plan)}, ${f.plural(_months, 'month')}',
        onTap: ok
            ? () => Navigator.of(context).pop({
                  'plan': _plan,
                  'months': _months,
                  'amount_paise': paise,
                  if (_ref.text.trim().isNotEmpty) 'ref': _ref.text.trim(),
                })
            : null,
        disabledReason: ok ? null : 'Type the amount in rupees, like 499, or leave it empty.',
      ),
    ]);
  }
}
