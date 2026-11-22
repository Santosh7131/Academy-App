import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/api.dart';
import '../core/auto_refresh.dart';
import '../core/format.dart' as f;
import '../theme.dart';
import '../ui/common.dart';
import '../ui/kit.dart';

// The AI credit, the developer's side (design/comps/w1a-*): the payments waiting to be checked against the UPI app, the prices and
// payment details tutors see, and the credit on a client's page. Amounts stay whole paise from end to end, never a fraction of a rupee
// in floating point.

const _rule = EdgeInsets.fromLTRB(0, 26, 0, 11);

/// The most the server adds by hand in one go: ₹1,00,000 (MAX_BY_HAND in api/src/lib/credit.ts).
const _mostByHand = 10000000;

/// The highest price the server takes for a page or a question (₹100), and for the free start (₹1,000).
const _mostPrice = 10000;
const _mostStart = 100000;

/// The shape the server takes for a UPI id (upiId in api/src/routes/credit.ts), checked here first so the card can say so at once.
final _upiShape = RegExp(r'^[A-Za-z0-9._-]{2,80}@[A-Za-z][A-Za-z0-9.-]{1,40}$');

/// "4281…0217" for a long payment reference, a short one whole.
String shortRef(String ref) => ref.length > 12 ? '${ref.substring(0, 4)}…${ref.substring(ref.length - 4)}' : ref;

/// "2.40" for 240 paise: the amount as it is typed into a field, worked out in whole numbers.
String _typed(int paise) => '${paise ~/ 100}.${(paise % 100).toString().padLeft(2, '0')}';

/// A time inside a line: "today, 5:12 pm", "yesterday", "Tue 7 Oct".
String _whenInLine(DateTime t) {
  final s = f.lineWhen(t);
  return s.startsWith('Today') || s.startsWith('Yesterday') ? s[0].toLowerCase() + s.substring(1) : s;
}

/// What one line of a client's credit history says.
String ledgerTitle(Map<String, dynamic> l) {
  final label = '${l['label'] ?? ''}'.trim();
  String about(String s) => label.isEmpty ? s : '$s · $label';
  return switch ('${l['kind']}') {
    'page' => about('Read ${f.plural(f.asInt(l['pages']), 'page')}'),
    'questions' => about('Wrote ${f.plural(f.asInt(l['questions']), 'question')}'),
    'start' => 'Free credit to start',
    'topup' => 'Credit added · UPI',
    'by_hand' => 'Credit added by hand',
    final other => other,
  };
}

/// One line of a client's credit history: what it was and when, and the amount in or out.
class CreditLedgerLine extends StatelessWidget {
  const CreditLedgerLine(this.line, {super.key});
  final Map<String, dynamic> line;

  @override
  Widget build(BuildContext context) {
    final amount = f.asInt(line['amount_paise']);
    final at = f.parseTime(line['at']);
    final ref = '${line['ref'] ?? ''}'.trim();
    final meta = [if (at != null) f.lineWhen(at), if (ref.isNotEmpty) 'ref ${shortRef(ref)}'].join(' · ');
    return Container(
      padding: const EdgeInsets.fromLTRB(17, 13, 17, 13),
      decoration: surface(radius: rCard, shadow: e1),
      child: Row(children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Fig(ledgerTitle(line), style: rowTitleStyle.copyWith(fontSize: 14), maxLines: 1),
            if (meta.isNotEmpty) ...[const SizedBox(height: 2), Fig(meta, style: labelStyle.copyWith(color: muted), maxLines: 1)],
          ]),
        ),
        const SizedBox(width: 14),
        Text(amount < 0 ? '−${f.inr(-amount)}' : '+${f.inr(amount)}', style: numStyle(size: 14.5, color: amount < 0 ? ink : success)),
      ]),
    );
  }
}

/// The last lines of a client's credit history, newest first.
class ClientCreditHistory extends StatelessWidget {
  const ClientCreditHistory(this.lines, {super.key});
  final List<Map<String, dynamic>> lines;

  @override
  Widget build(BuildContext context) => lines.isEmpty
      ? Fig('No credit has come in or gone out yet.', style: bodyStyle.copyWith(color: muted))
      : Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          for (final (i, l) in lines.indexed) ...[if (i > 0) const SizedBox(height: 8), CreditLedgerLine(l)],
        ]);
}

/// The comps' short button: filled for the step to take, grey beside it.
class _ActButton extends StatelessWidget {
  const _ActButton(this.label, {this.icon, this.primary = false, this.onTap, this.busy = false, this.height = 44});

  final String label;
  final IconData? icon;
  final bool primary;
  final VoidCallback? onTap;

  /// Asking the server: dots in place of the label, and no taps.
  final bool busy;
  final double height;

  @override
  Widget build(BuildContext context) {
    final fg = primary ? actionInk : (onTap == null && !busy ? faint : ink);
    return Pressable(
      onTap: busy ? null : onTap,
      label: label,
      child: Container(
        height: height,
        padding: const EdgeInsets.symmetric(horizontal: 15),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: primary ? actionFill : fill,
          borderRadius: BorderRadius.circular(13),
          boxShadow: primary ? e2 : const [],
        ),
        child: busy
            ? LoadingDots(color: fg, size: 4.5)
            : Row(mainAxisSize: MainAxisSize.min, children: [
                if (icon != null) ...[Icon(icon, size: 17, color: fg), const SizedBox(width: 6)],
                Flexible(child: Text(label, style: buttonStyle.copyWith(fontSize: 13.5, color: fg), maxLines: 1, overflow: TextOverflow.ellipsis)),
              ]),
      ),
    );
  }
}

/// A field's name above it, inside a centred card.
class _FieldLabel extends StatelessWidget {
  const _FieldLabel(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 7),
        child: Text(text, style: labelStyle.copyWith(fontSize: 13, color: muted)),
      );
}

/// A field's box inside a centred card: sunk into the card rather than raised off it.
class _Box extends StatelessWidget {
  const _Box({required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) =>
      Container(decoration: BoxDecoration(color: fill, borderRadius: BorderRadius.circular(16)), child: child);
}

/// An amount in rupees: ₹ before it, the figures in mono, the number keyboard with a decimal point.
class _RupeeField extends StatelessWidget {
  const _RupeeField({required this.controller, this.onChanged, this.onSubmitted, this.autofocus = false});
  final TextEditingController controller;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onSubmitted;
  final bool autofocus;

  @override
  Widget build(BuildContext context) => _Box(
        child: Padding(
          padding: const EdgeInsets.only(left: 16),
          child: Row(children: [
            Text('₹', style: numStyle(size: 15, weight: FontWeight.w600, color: muted)),
            Expanded(
              child: TextField(
                controller: controller,
                autofocus: autofocus,
                onChanged: onChanged,
                onSubmitted: onSubmitted,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                textInputAction: TextInputAction.done,
                inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.,]')), LengthLimitingTextInputFormatter(12)],
                cursorColor: ink,
                style: numStyle(size: 15, weight: FontWeight.w600),
                decoration: InputDecoration(
                  isDense: true,
                  border: InputBorder.none,
                  hintText: '0.00',
                  hintStyle: numStyle(size: 15, weight: FontWeight.w600, color: faint),
                  contentPadding: const EdgeInsets.fromLTRB(6, 15, 16, 15),
                ),
              ),
            ),
          ]),
        ),
      );
}

// ---------------------------------------------------------------- deciding a request

/// The card that marks a payment received: what to check first, and the UPI transaction id to keep with it, if wanted.
/// Pops with the reference ('' for none), or nothing when cancelled.
class _ReceiveCard extends StatefulWidget {
  const _ReceiveCard({required this.code});
  final String code;

  @override
  State<_ReceiveCard> createState() => _ReceiveCardState();
}

class _ReceiveCardState extends State<_ReceiveCard> {
  final _ref = TextEditingController();

  @override
  void dispose() {
    _ref.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Fig("Find this payment in your UPI app first: its note should say ${widget.code}. The credit goes to the client at once, "
            "and this can't be undone.", style: bodyStyle),
        const SizedBox(height: 16),
        const _FieldLabel('UPI transaction id, to keep with it'),
        _Box(child: BareField(controller: _ref, placeholder: 'Optional', maxLength: 80, action: TextInputAction.done)),
        const SizedBox(height: 20),
        Row(children: [
          Expanded(child: SecondaryButton('Cancel', onTap: () => Navigator.of(context).pop())),
          const SizedBox(width: 10),
          Expanded(child: PrimaryButton('Mark received', onTap: () => Navigator.of(context).pop(_ref.text.trim()))),
        ]),
      ]);
}

/// Asks first, then marks a credit request received or declined. [onSending] is called as the server is asked. True when the page
/// should load again: the request was decided, here or (as the server's answer shows) somewhere else meanwhile.
Future<bool> settleRequest(BuildContext context, Map<String, dynamic> r, {required bool receive, VoidCallback? onSending}) async {
  final amount = f.inr(f.asInt(r['amount_paise']));
  final code = '${r['code']}';
  final client = r['client'] == null ? null : '${r['client']}';
  String? ref;
  if (receive) {
    ref = await showCentredCard<String>(context, title: 'Mark $amount received?', subtitle: client, builder: (_) => _ReceiveCard(code: code));
    if (ref == null) return false;
  } else {
    final yes = await confirmCard(
      context,
      title: 'Decline $amount?',
      body: '${client == null ? '' : '$client asked for it. '}Decline it only when no payment with $code in its note reached you. '
          'No credit is added.',
      confirm: 'Decline',
      destructive: true,
    );
    if (!yes) return false;
  }
  if (!context.mounted) return false;
  onSending?.call();
  try {
    await api.post('/admin/credit/requests/${r['id']}/${receive ? 'receive' : 'decline'}', {if (ref != null && ref.isNotEmpty) 'ref': ref});
    return true;
  } on ApiException catch (e) {
    if (context.mounted) showProblem(context, e);
    // Decided already, or gone: what the page shows is out of date.
    return e.status == 409 || e.status == 404;
  }
}

// ---------------------------------------------------------------- adding credit by hand

/// Adds credit to a client by hand, for a payment that came some other way. Returns the client's credit after it, or null when
/// nothing was added.
Future<int?> addCreditByHand(BuildContext context, {required String clientId, required String clientName, required int balance}) =>
    showCentredCard<int>(context, title: 'Add credit', subtitle: clientName, builder: (_) => _AddCredit(clientId: clientId, balance: balance));

class _AddCredit extends StatefulWidget {
  const _AddCredit({required this.clientId, required this.balance});
  final String clientId;
  final int balance;

  @override
  State<_AddCredit> createState() => _AddCreditState();
}

class _AddCreditState extends State<_AddCredit> {
  final _amount = TextEditingController();
  final _ref = TextEditingController();
  bool _busy = false;
  String? _problem;

  int? get _paise => f.paiseOf(_amount.text);
  bool get _valid => _paise != null && _paise! >= 1 && _paise! <= _mostByHand;

  @override
  void dispose() {
    _amount.dispose();
    _ref.dispose();
    super.dispose();
  }

  Future<void> _add() async {
    if (!_valid || _busy) return;
    final ref = _ref.text.trim();
    setState(() {
      _busy = true;
      _problem = null;
    });
    try {
      final r = await api.post('/admin/clients/${widget.clientId}/credit', {'amount_paise': _paise, if (ref.isNotEmpty) 'ref': ref});
      if (mounted) Navigator.of(context).pop(f.asInt((r as Map)['balance_paise']));
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
    final p = _paise;
    final typed = _amount.text.trim().isNotEmpty;
    final String? reason = !typed
        ? null
        : p == null
            ? 'Type the amount in rupees, like 250 or 250.50.'
            : p < 1
                ? 'Type an amount above ₹0.'
                : p > _mostByHand
                    ? 'At most ${f.inr(_mostByHand)} at a time.'
                    : null;
    return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const _FieldLabel('Amount'),
      _RupeeField(controller: _amount, autofocus: true, onChanged: (_) => setState(() {}), onSubmitted: (_) => _add()),
      const SizedBox(height: 12),
      const _FieldLabel('Payment reference'),
      _Box(child: BareField(controller: _ref, placeholder: 'UPI transaction id or the code', maxLength: 80, action: TextInputAction.done)),
      Padding(
        padding: const EdgeInsets.only(top: 14),
        child: Row(children: [
          Expanded(child: Text('Credit after this', style: labelStyle.copyWith(fontSize: 12.5, color: muted))),
          Text(f.inr(widget.balance + (_valid ? p! : 0)), style: numStyle(size: 14)),
        ]),
      ),
      if (_problem != null) ...[const SizedBox(height: 14), InlineNotice(_problem!, tone: Tone.danger, icon: Ph.warning)],
      const SizedBox(height: 18),
      PrimaryButton(_valid ? 'Add ${f.inr(p!)}' : 'Add credit', onTap: _valid ? _add : null, busy: _busy, disabledReason: reason),
      Center(child: TextAction('Cancel', onTap: _busy ? null : () => Navigator.of(context).pop())),
    ]);
  }
}

// ---------------------------------------------------------------- the requests

/// Credit requests: the payments tutors say they made, to be found in the UPI app by the code in their note and marked received,
/// then the last ones decided.
class CreditRequestsScreen extends StatefulWidget {
  const CreditRequestsScreen({super.key});

  @override
  State<CreditRequestsScreen> createState() => _CreditRequestsScreenState();
}

class _CreditRequestsScreenState extends State<CreditRequestsScreen> with WidgetsBindingObserver, AutoRefresh<CreditRequestsScreen> {
  Map<String, dynamic>? _d;
  String? _error;

  /// The requests the server is being asked about, so their buttons show it and take no second tap.
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
      final d = await api.get('/admin/credit');
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
    final reload = await settleRequest(context, r, receive: receive, onSending: () => setState(() => _busy.add(id)));
    if (reload && mounted) await _load();
    if (mounted) setState(() => _busy.remove(id));
  }

  @override
  Widget build(BuildContext context) {
    final d = _d;
    if (d == null) {
      return PushedPanel(kicker: 'Credit', title: 'Requests', onRefresh: _load, children: [
        if (_error != null) ErrorState(message: _error!, onRetry: _load) else const LoadingState(),
      ]);
    }
    final waiting = (d['waiting'] as List).cast<Map<String, dynamic>>();
    final done = (d['done'] as List).cast<Map<String, dynamic>>();
    return PushedPanel(
      kicker: waiting.isEmpty ? 'Credit · none waiting' : 'Credit · ${waiting.length} waiting',
      title: 'Requests',
      onRefresh: _load,
      children: [
        const SizedBox(height: 10),
        Fig('Find the payment with the code in its note in your UPI app, then mark it received. The credit goes to the client at once.',
            style: bodyStyle.copyWith(color: muted)),
        SectionRule('Waiting', count: waiting.length, padding: _rule),
        if (waiting.isEmpty)
          Fig('Nothing waiting. A request shows here when a tutor asks to add credit.', style: bodyStyle.copyWith(color: muted))
        else
          ...[
            for (final (i, r) in waiting.indexed) ...[
              if (i > 0) const SizedBox(height: gapRow),
              _RequestCard(
                r,
                busy: _busy.contains('${r['id']}'),
                onReceive: () => _settle(r, receive: true),
                onDecline: () => _settle(r, receive: false),
              ),
            ],
          ],
        if (done.isNotEmpty) ...[
          SectionRule('Done', count: done.length, padding: _rule),
          for (final (i, r) in done.indexed) ...[
            if (i > 0) const SizedBox(height: gapRow),
            _DoneLine(r),
          ],
        ],
        const SizedBox(height: 8),
      ],
    );
  }
}

/// A waiting request: who asked and when, the amount, the code to look for in the payment's note, and what to do with it.
class _RequestCard extends StatelessWidget {
  const _RequestCard(this.r, {required this.busy, required this.onReceive, required this.onDecline});
  final Map<String, dynamic> r;
  final bool busy;
  final VoidCallback onReceive;
  final VoidCallback onDecline;

  @override
  Widget build(BuildContext context) {
    final asked = f.parseTime(r['created_at']);
    final owner = r['owner'] == null ? null : '${r['owner']}';
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
        const SizedBox(height: 13),
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

/// A request already decided: received (its amount in green) or declined (greyed), when, and its code.
class _DoneLine extends StatelessWidget {
  const _DoneLine(this.r);
  final Map<String, dynamic> r;

  @override
  Widget build(BuildContext context) {
    final received = r['status'] == 'received';
    final at = f.parseTime(r['decided_at']);
    return RowTile(
      title: '${r['client']}',
      meta: '${received ? 'Received' : 'Declined'}${at == null ? '' : ' ${_whenInLine(at)}'} · ${r['code']}',
      trailing: Text(f.inr(f.asInt(r['amount_paise'])), style: numStyle(size: 14.5, color: received ? success : faint)),
    );
  }
}

// ---------------------------------------------------------------- the settings

/// What tutors pay for AI work, the free credit a new client starts with, and the UPI details tutors pay to.
class CreditSettingsScreen extends StatefulWidget {
  const CreditSettingsScreen({super.key});

  @override
  State<CreditSettingsScreen> createState() => _CreditSettingsScreenState();
}

class _CreditSettingsScreenState extends State<CreditSettingsScreen> {
  Map<String, dynamic>? _d;
  String? _error;

  /// The field being saved, so its row shows it and takes no second tap.
  String? _saving;

  static const _priceNote = 'Every tutor sees the new price at once. Work already under way finishes at the old price.';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final d = await api.get('/admin/credit');
      if (!mounted) return;
      setState(() {
        _d = Map<String, dynamic>.from(d);
        _error = null;
      });
    } on ApiException catch (e) {
      if (mounted && _d == null) setState(() => _error = e.message);
    }
  }

  Map<String, dynamic> get _s => Map<String, dynamic>.from(_d!['settings'] as Map);

  /// Sends the one field that changed; the server answers with all the settings.
  Future<void> _save(String key, Object value) async {
    if (_saving != null) return;
    setState(() => _saving = key);
    try {
      final r = await api.put('/admin/credit/settings', {key: value});
      if (mounted) setState(() => _d = {..._d!, 'settings': (r as Map)['settings']});
    } on ApiException catch (e) {
      if (mounted) showProblem(context, e);
    } finally {
      if (mounted) setState(() => _saving = null);
    }
  }

  Future<void> _editAmount(String key, String title, String note, {required int most}) async {
    final now = f.asInt(_s[key]);
    final v = await showCentredCard<int>(context, title: title, builder: (_) => _AmountCard(paise: now, most: most, note: note));
    if (v != null && v != now) await _save(key, v);
  }

  Future<void> _editText(String key, String title, {required int max, required String placeholder, String? note, bool upi = false}) async {
    final now = '${_s[key] ?? ''}';
    final v = await showCentredCard<String>(
      context,
      title: title,
      builder: (_) => _TextCard(text: now, max: max, placeholder: placeholder, note: note, upi: upi),
    );
    if (v == null || v == now || !mounted) return;
    if (upi && v.isEmpty) {
      final yes = await confirmCard(context,
          title: 'Remove the UPI id?', body: 'No tutor can add credit until you set one again.', confirm: 'Remove', destructive: true);
      if (!yes) return;
    }
    await _save(key, v);
  }

  @override
  Widget build(BuildContext context) {
    final d = _d;
    if (d == null) {
      return PushedPanel(kicker: 'Admin · Settings', title: 'AI credit', onRefresh: _load, children: [
        if (_error != null) ErrorState(message: _error!, onRetry: _load) else const LoadingState(),
      ]);
    }
    final s = _s;
    final month = Map<String, dynamic>.from(d['month'] as Map);
    final pageCost = month['page_cost_inr'];
    final questionCost = month['question_cost_inr'];
    final upiId = '${s['upi_id'] ?? ''}';
    final upiName = '${s['upi_name'] ?? ''}';
    final newAi = s['new_clients_ai'] == true;
    final costs = [
      if (pageCost != null) '${f.rupees(f.asDouble(pageCost))} a page',
      if (questionCost != null) '${f.rupees(f.asDouble(questionCost))} a question',
    ];
    return PushedPanel(
      kicker: 'Admin · Settings',
      title: 'AI credit',
      onRefresh: _load,
      children: [
        const SizedBox(height: 10),
        Fig('What tutors pay for AI work. Tutors see these prices and the UPI id in their app.', style: bodyStyle.copyWith(color: muted)),
        SectionRule('Prices', padding: _rule),
        _Facts([
          _Fact('Reading a page', f.inr(f.asInt(s['page_paise'])),
              busy: _saving == 'page_paise', onTap: () => _editAmount('page_paise', 'Price of a page', _priceNote, most: _mostPrice)),
          _Fact('Writing a question', f.inr(f.asInt(s['question_paise'])),
              busy: _saving == 'question_paise',
              onTap: () => _editAmount('question_paise', 'Price of a question', _priceNote, most: _mostPrice)),
        ]),
        if (costs.isNotEmpty) ...[
          const SizedBox(height: 10),
          Fig('It costs you about ${costs.join(' and ')} this month, at list prices.', style: labelStyle),
        ],
        SectionRule('New clients', padding: _rule),
        _Facts([
          _Fact('Free credit to start', f.inr(f.asInt(s['start_paise'])),
              busy: _saving == 'start_paise',
              onTap: () => _editAmount('start_paise', 'Free credit to start', 'What a tuition gets when it is created. Tuitions already on '
                  'the service keep what they have.', most: _mostStart)),
        ]),
        const SizedBox(height: gapRow),
        _SwitchRow(
          title: 'New clients can use AI',
          body: 'Turn off to give new clients no free credit: they can use AI once they buy credit or you add some.',
          on: newAi,
          onTap: _saving == null ? () => _save('new_clients_ai', !newAi) : null,
        ),
        SectionRule('Payment details', padding: _rule),
        if (upiId.isEmpty) ...[
          InlineNotice('No UPI id is set, so no tutor can add credit.', icon: Ph.warning),
          const SizedBox(height: gapRow),
        ],
        _Facts([
          _Fact('UPI id', upiId.isEmpty ? 'Not set' : upiId,
              faintValue: upiId.isEmpty,
              busy: _saving == 'upi_id',
              onTap: () => _editText('upi_id', 'UPI id', max: 121, placeholder: 'name@bank', upi: true,
                  note: 'Tutors pay to this. Check it twice: a payment to a wrong id does not come back.')),
          _Fact('Name', upiName.isEmpty ? 'Not set' : upiName,
              mono: false,
              faintValue: upiName.isEmpty,
              busy: _saving == 'upi_name',
              onTap: () => _editText('upi_name', 'Name', max: 60, placeholder: 'The name on the UPI account',
                  note: 'Tutors see it beside the UPI id, so they know the payment goes to the right person.')),
        ]),
        const SizedBox(height: 8),
      ],
    );
  }
}

/// One row of a facts card: its name, its value and, when it can be changed, a chevron.
class _Fact {
  const _Fact(this.label, this.value, {this.onTap, this.busy = false, this.mono = true, this.faintValue = false});
  final String label;
  final String value;
  final VoidCallback? onTap;
  final bool busy;
  final bool mono;
  final bool faintValue;
}

/// Rows of name and value in one card, split by hairlines.
class _Facts extends StatelessWidget {
  const _Facts(this.rows);
  final List<_Fact> rows;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 4),
        decoration: surface(radius: rCard, shadow: e1),
        child: Column(children: [
          for (final (i, r) in rows.indexed) ...[
            if (i > 0) Container(height: 1, color: hairline),
            Pressable(
              onTap: r.busy ? null : r.onTap,
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 14),
                child: Row(children: [
                  Text(r.label, style: bodyStyle.copyWith(fontSize: 14, color: muted, fontWeight: FontWeight.w500)),
                  const SizedBox(width: 16),
                  Expanded(
                    child: r.busy
                        ? Align(alignment: Alignment.centerRight, child: LoadingDots(color: muted, size: 4))
                        : Text(
                            r.value,
                            style: (r.mono ? numStyle(size: 15, weight: FontWeight.w600) : rowTitleStyle.copyWith(fontSize: 15))
                                .copyWith(color: r.faintValue ? faint : ink),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            textAlign: TextAlign.right,
                          ),
                  ),
                  if (r.onTap != null) ...[const SizedBox(width: 8), Icon(Ph.caretRight, size: 16, color: faint)],
                ]),
              ),
            ),
          ],
        ]),
      );
}

/// A setting that is on or off, with what it does under its name.
class _SwitchRow extends StatelessWidget {
  const _SwitchRow({required this.title, required this.body, required this.on, this.onTap});
  final String title;
  final String body;
  final bool on;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => Semantics(
        toggled: on,
        child: Pressable(
          onTap: onTap,
          child: Container(
            padding: const EdgeInsets.fromLTRB(17, 15, 17, 15),
            decoration: surface(radius: rCard, shadow: e1),
            child: Row(children: [
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(title, style: rowTitleStyle),
                  const SizedBox(height: 3),
                  Fig(body, style: labelStyle.copyWith(color: muted)),
                ]),
              ),
              const SizedBox(width: 14),
              _Switch(on),
            ]),
          ),
        ),
      );
}

/// Drawn by hand, with no slide: green with the knob at the right when on, grey with it at the left when off.
class _Switch extends StatelessWidget {
  const _Switch(this.on);
  final bool on;

  @override
  Widget build(BuildContext context) => Container(
        width: 46,
        height: 28,
        padding: const EdgeInsets.all(3),
        alignment: on ? Alignment.centerRight : Alignment.centerLeft,
        decoration: BoxDecoration(color: on ? success : faint, borderRadius: BorderRadius.circular(rPill)),
        child: Container(
          width: 22,
          height: 22,
          decoration: const BoxDecoration(
            color: Colors.white,
            shape: BoxShape.circle,
            boxShadow: [BoxShadow(color: Color(0x2E000000), blurRadius: 3, offset: Offset(0, 1))],
          ),
        ),
      );
}

/// Changes an amount: the field, what the change does, and Save. Pops with the new amount in paise.
class _AmountCard extends StatefulWidget {
  const _AmountCard({required this.paise, required this.most, required this.note});
  final int paise;
  final int most;
  final String note;

  @override
  State<_AmountCard> createState() => _AmountCardState();
}

class _AmountCardState extends State<_AmountCard> {
  late final _amount = TextEditingController(text: _typed(widget.paise));

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = f.paiseOf(_amount.text);
    final ok = p != null && p <= widget.most;
    final reason = p == null ? 'Type the amount in rupees, like 2.40.' : (p > widget.most ? 'At most ${f.inr(widget.most)}.' : null);
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
      Fig(widget.note, style: bodyStyle.copyWith(color: muted)),
      const SizedBox(height: 20),
      PrimaryButton('Save', onTap: ok ? () => Navigator.of(context).pop(p) : null, disabledReason: reason),
    ]);
  }
}

/// Changes a line of text: the field, a note, and Save. Pops with the new text, trimmed ('' clears it).
class _TextCard extends StatefulWidget {
  const _TextCard({required this.text, required this.max, required this.placeholder, this.note, this.upi = false});
  final String text;
  final int max;
  final String placeholder;
  final String? note;

  /// A UPI id: the email keyboard, and the shape checked before it is sent.
  final bool upi;

  @override
  State<_TextCard> createState() => _TextCardState();
}

class _TextCardState extends State<_TextCard> {
  late final _c = TextEditingController(text: widget.text);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = _c.text.trim();
    final wrong = widget.upi && t.isNotEmpty && !_upiShape.hasMatch(t);
    return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      _Box(
        child: BareField(
          controller: _c,
          placeholder: widget.placeholder,
          maxLength: widget.max,
          autofocus: true,
          keyboard: widget.upi ? TextInputType.emailAddress : TextInputType.name,
          capitalization: widget.upi ? TextCapitalization.none : TextCapitalization.words,
          action: TextInputAction.done,
          onChanged: (_) => setState(() {}),
        ),
      ),
      if (widget.note != null) ...[const SizedBox(height: 12), Fig(widget.note!, style: bodyStyle.copyWith(color: muted))],
      const SizedBox(height: 20),
      PrimaryButton(
        'Save',
        onTap: wrong ? null : () => Navigator.of(context).pop(t),
        disabledReason: wrong ? 'That UPI id does not look right. It is written like name@bank.' : null,
      ),
    ]);
  }
}

// ---------------------------------------------------------------- a client's credit

/// A client's AI credit at the top of its page: what is left, this month's use, Add credit, and the requests waiting.
class ClientCredit extends StatefulWidget {
  const ClientCredit({super.key, required this.clientId, required this.clientName, required this.credit, required this.aiWorthInr, required this.onChanged});
  final String clientId;
  final String clientName;

  /// The `credit` part of GET /admin/clients/:id.
  final Map<String, dynamic> credit;

  /// What this month's AI work would cost at list prices.
  final double aiWorthInr;

  /// Loads the page again, after credit was added or a request decided.
  final Future<void> Function() onChanged;

  @override
  State<ClientCredit> createState() => _ClientCreditState();
}

class _ClientCreditState extends State<ClientCredit> {
  final _busy = <String>{};

  Future<void> _add() async {
    final now = await addCreditByHand(context,
        clientId: widget.clientId, clientName: widget.clientName, balance: f.asInt(widget.credit['balance_paise']));
    if (now != null) await widget.onChanged();
  }

  Future<void> _receive(Map<String, dynamic> r) async {
    final id = '${r['id']}';
    if (_busy.contains(id)) return;
    final reload = await settleRequest(context, {...r, 'client': widget.clientName}, receive: true, onSending: () => setState(() => _busy.add(id)));
    if (reload) await widget.onChanged();
    if (mounted) setState(() => _busy.remove(id));
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.credit;
    final waiting = (c['waiting'] as List? ?? const []).cast<Map<String, dynamic>>();
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Container(
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
        decoration: surface(radius: rHero, shadow: e3),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Credit left', style: labelStyle.copyWith(fontSize: 12.5, color: muted)),
          const SizedBox(height: 10),
          Text(f.inr(f.asInt(c['balance_paise'])), style: numStyle(size: 46)),
          const SizedBox(height: 12),
          Fig('${f.inr(f.asInt(c['used_month_paise']))} used this month · AI worth ${f.rupees(widget.aiWorthInr)}',
              style: bodyStyle.copyWith(fontSize: 13, color: muted), numColor: ink),
          const SizedBox(height: 16),
          PrimaryButton('Add credit', leadingIcon: Ph.plus, onTap: _add),
        ]),
      ),
      if (waiting.isNotEmpty) ...[
        SectionRule('Waiting', count: waiting.length, padding: _rule),
        for (final (i, r) in waiting.indexed) ...[
          if (i > 0) const SizedBox(height: gapRow),
          Container(
            padding: const EdgeInsets.fromLTRB(17, 14, 15, 14),
            decoration: surface(radius: rCard, shadow: e1),
            child: Row(children: [
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Fig('${f.inr(f.asInt(r['amount_paise']))} · code ${r['code']}', style: rowTitleStyle, maxLines: 2),
                  if (f.parseTime(r['created_at']) case final asked?) ...[
                    const SizedBox(height: 2),
                    Fig('Asked ${_whenInLine(asked)}', style: labelStyle.copyWith(color: muted), maxLines: 1),
                  ],
                ]),
              ),
              const SizedBox(width: 10),
              _ActButton('Mark received', primary: true, height: 38, busy: _busy.contains('${r['id']}'), onTap: () => _receive(r)),
            ]),
          ),
        ],
      ],
    ]);
  }
}
