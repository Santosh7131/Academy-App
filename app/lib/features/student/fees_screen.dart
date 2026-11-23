import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/changes.dart';
import '../../core/credit.dart' show inrWhole;
import '../../core/fees.dart';
import '../../core/format.dart' as f;
import '../../core/session.dart';
import '../../core/share_text.dart';
import '../../core/upi.dart';
import '../../core/web_bits.dart' show savesFiles;
import '../../theme.dart';
import '../../ui/kit.dart';
import '../../ui/qr.dart';
import '../teacher/common.dart' show showProblem;

// A student's fees in the tuition on screen (api/src/routes/fees.ts): what is owed and by when, and paying it by UPI straight to
// the tutor. A parent often pays from their own phone, so the payment shows as a code to scan, with the UPI id to copy and the
// details to send; or a UPI app on this phone opens with it filled in. The app never learns whether a payment went through, so
// the student says "I have paid" and the tutor confirms it. Receipts come once the tutor has.

List<Map<String, dynamic>> _list(Object? v) => [for (final x in (v as List?) ?? const []) Map<String, dynamic>.from(x as Map)];

class MyFeesScreen extends StatefulWidget {
  const MyFeesScreen({super.key});

  @override
  State<MyFeesScreen> createState() => _MyFeesScreenState();
}

class _MyFeesScreenState extends State<MyFeesScreen> with WidgetsBindingObserver, AutoRefresh<MyFeesScreen> {
  Map<String, dynamic>? _d;
  String? _error;
  String? _notice;
  var _busy = false;
  var _copied = false;

  @override
  Set<Area> get refreshAreas => {Area.student};

  // The tutor confirms at any time: look again every minute while this is on screen.
  @override
  Duration? get pollEvery => const Duration(minutes: 1);

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
      final d = Map<String, dynamic>.from(await api.get('/student/fees'));
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

  String get _me => '${session.user?['display_name'] ?? ''}'.trim();

  Future<void> _payHere(String link) async {
    if (await openUpiApp(link) || !mounted) return;
    await showCentredCard<void>(
      context,
      title: 'No UPI app here',
      builder: (ctx) => Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Fig('This phone has no UPI app. A parent can scan the code with theirs, or you can send them the details.', style: bodyStyle),
        const SizedBox(height: 18),
        PrimaryButton('OK', onTap: () => Navigator.of(ctx).pop()),
      ]),
    );
  }

  void _copy(String id) {
    Clipboard.setData(ClipboardData(text: id));
    setState(() => _copied = true);
  }

  Future<void> _send(Map<String, dynamic> m, Map<String, dynamic> upi) async {
    try {
      final copied = await shareText(payRequest(student: _me, month: '${m['month']}', paise: paiseOf(m['left']), upi: upi, tuition: session.tuitionName));
      if (copied && mounted) setState(() => _notice = copiedNotice);
    } catch (e) {
      if (mounted) await showProblem(context, e);
    }
  }

  /// "I have paid": with the UPI reference number if they have it. Null when they back out.
  Future<String?> _askReference(Map<String, dynamic> m) {
    final ref = TextEditingController();
    return showCentredCard<String>(
      context,
      title: 'Paid ${inrWhole(paiseOf(m['left']))}?',
      subtitle: 'Your tutor checks that it reached them, then confirms it.',
      builder: (ctx) => Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        GroupedInputs(children: [BareField(controller: ref, placeholder: 'UPI reference number (optional)', maxLength: 60)]),
        const SizedBox(height: 8),
        Fig('It is the 12-digit number the UPI app shows after paying.', style: labelStyle),
        const SizedBox(height: 18),
        PrimaryButton('Yes, I have paid', onTap: () => Navigator.of(ctx).pop(ref.text.trim())),
        const SizedBox(height: 6),
        Center(child: TextAction('Not yet', onTap: () => Navigator.of(ctx).pop())),
      ]),
    );
  }

  Future<void> _paid(Map<String, dynamic> m) async {
    final ref = await _askReference(m);
    if (ref == null || !mounted) return;
    setState(() => _busy = true);
    try {
      await api.post('/student/fees/paid', {'month': m['month'], if (ref.isNotEmpty) 'reference': ref});
      if (mounted) setState(() => _notice = 'Marked as paid. It waits for your tutor to confirm it.');
    } on ApiException catch (e) {
      if (mounted) await showProblem(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    if (mounted) _load(quiet: true);
  }

  Future<void> _takeBack(Map<String, dynamic> claim) async {
    final ok = await confirmCard(
      context,
      title: 'Take it back?',
      body: 'For a payment marked by mistake. Your tutor is no longer asked to confirm it.',
      confirm: 'Take it back',
      destructive: true,
    );
    if (!ok || !mounted) return;
    try {
      await api.delete('/student/fees/claims/${claim['id']}');
      if (mounted) setState(() => _notice = null);
    } on ApiException catch (e) {
      if (mounted) await showProblem(context, e);
    }
    if (mounted) _load(quiet: true);
  }

  @override
  Widget build(BuildContext context) {
    final d = _d;
    final owing = _list(d?['owing']);
    final months = _list(d?['months']);
    final payments = _list(d?['payments']);
    final receipts = payments.where((p) => p['status'] == 'confirmed').toList();
    final upi = (d?['upi'] as Map?)?.cast<String, dynamic>();
    final first = owing.firstOrNull;
    final payable = first != null && first['status'] == 'unpaid' && upi != null;
    return PushedPanel(
      kicker: session.tuitionName,
      title: 'Fees',
      onRefresh: _load,
      footer: payable ? PrimaryButton('I have paid ${inrWhole(paiseOf(first['left']))}', busy: _busy, onTap: _busy ? null : () => _paid(first)) : null,
      children: [
        if (d == null && _error != null)
          ErrorState(message: _error!, onRetry: _load)
        else if (d == null)
          const LoadingState(rows: 4)
        else ...[
          const SizedBox(height: 14),
          if (_notice != null) ...[InlineNotice(_notice!, tone: Tone.success, icon: Ph.checkCircle), const SizedBox(height: 12)],
          if (first != null) _owed(first, payments, upi),
          if (months.isNotEmpty) ...[
            const SectionRule('Months', padding: EdgeInsets.fromLTRB(0, 22, 0, 10)),
            for (final (i, m) in months.indexed) ...[if (i > 0) const SizedBox(height: gapRow), _monthRow(m)],
          ],
          if (receipts.isNotEmpty) ...[
            SectionRule('Receipts', count: receipts.length, padding: const EdgeInsets.fromLTRB(0, 22, 0, 10)),
            for (final (i, p) in receipts.indexed) ...[
              if (i > 0) const SizedBox(height: gapRow),
              RowTile(
                leading: Icon(Ph.receipt, size: 22, color: ink),
                title: '${inrWhole(paiseOf(p['amount_paise']))} · ${monthName('${p['month']}')}',
                meta: '${methodName(p['method'])} · ${f.shortDate(f.dayOf('${p['paid_on']}'))} · Receipt ${p['receipt_no']}',
                chevron: true,
                onTap: () => context.push('/s/fees/receipt', extra: {...p, 'class_level': session.classLevel}),
              ),
            ],
          ],
          if (owing.isEmpty && months.isEmpty && receipts.isEmpty)
            const EmptyState(icon: Ph.currencyInr, title: 'No fees here', body: 'Your tutor has not set a fee in the app.'),
        ],
      ],
    );
  }

  Widget _monthRow(Map<String, dynamic> m) {
    final line = monthLine(m, forStudent: true);
    return RowTile(
      title: monthName('${m['month']}'),
      meta: line.text,
      metaColor: switch (line.tone) { MonthTone.paid => success, MonthTone.late => danger, MonthTone.waiting => warning, MonthTone.owed => null },
    );
  }

  /// The month owed first: how much and by when, and how to pay it, or that it waits for the tutor.
  Widget _owed(Map<String, dynamic> m, List<Map<String, dynamic>> payments, Map<String, dynamic>? upi) {
    final left = paiseOf(m['left']);
    final late = m['late'] == true;
    final due = m['due_on'] == null ? null : dueDay('${m['due_on']}');
    final claim = payments.where((p) => p['status'] == 'claimed' && p['month'] == m['month']).firstOrNull;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Surface(
        shadow: e1,
        padding: const EdgeInsets.fromLTRB(18, 16, 18, 16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Kicker(monthName('${m['month']}')),
          const SizedBox(height: 8),
          Text(inrWhole(left), style: numStyle(size: 34, color: late && claim == null ? danger : ink)),
          if (due != null) ...[
            const SizedBox(height: 4),
            Fig(late ? 'Was due $due' : 'Due $due', style: bodyStyle.copyWith(color: late && claim == null ? danger : muted)),
          ],
        ]),
      ),
      if (claim != null) ...[
        const SizedBox(height: 12),
        InlineNotice(
          'You said you paid ${inrWhole(paiseOf(claim['amount_paise']))} on ${f.shortDate(f.dayOf('${claim['paid_on']}'))}. It waits for your tutor to confirm it.',
          tone: Tone.neutral,
          icon: Ph.hourglassMedium,
        ),
        const SizedBox(height: 8),
        Center(child: TextAction('Take it back', onTap: () => _takeBack(claim))),
      ] else if (upi == null) ...[
        const SizedBox(height: 12),
        Fig('Pay your tutor at the class. They will mark it here.', style: bodyStyle.copyWith(color: muted)),
      ] else ...[
        const SectionRule('Pay by UPI', padding: EdgeInsets.fromLTRB(0, 22, 0, 12)),
        Center(
          child: QrBox(
            data: upiLink(id: '${upi['id']}', name: '${upi['name']}', paise: left, note: payNote(_me, '${m['month']}')),
            size: 210,
            label: 'A UPI code to pay ${inrWhole(left)}',
          ),
        ),
        const SizedBox(height: 10),
        Fig('Scan it with any UPI app, from another phone too.', style: labelStyle, textAlign: TextAlign.center),
        const SizedBox(height: 16),
        Row(children: [
          Expanded(
            child: Container(
              height: 44,
              padding: const EdgeInsets.symmetric(horizontal: 14),
              alignment: Alignment.centerLeft,
              decoration: BoxDecoration(color: fill, borderRadius: BorderRadius.circular(12)),
              child: Text('${upi['id']}', style: numStyle(size: 14.5), maxLines: 1, overflow: TextOverflow.ellipsis),
            ),
          ),
          const SizedBox(width: 10),
          Pressable(
            label: 'Copy the UPI id',
            onTap: () => _copy('${upi['id']}'),
            child: Container(
              height: 44,
              padding: const EdgeInsets.symmetric(horizontal: 14),
              decoration: surface(radius: 12, shadow: e1),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(_copied ? Ph.check : Ph.copy, size: 16, color: ink),
                const SizedBox(width: 6),
                Text(_copied ? 'Copied' : 'Copy', style: chipStyle.copyWith(color: ink, fontWeight: FontWeight.w700)),
              ]),
            ),
          ),
        ]),
        const SizedBox(height: 6),
        Fig('The UPI app shows the name ${upi['name']}.', style: labelStyle),
        const SizedBox(height: 14),
        // A computer has no UPI app: there the code above is scanned with a phone.
        if (!savesFiles) ...[
          SecondaryButton(
            'Pay in a UPI app on this phone',
            icon: Ph.arrowSquareOut,
            onTap: () => _payHere(upiLink(id: '${upi['id']}', name: '${upi['name']}', paise: left, note: payNote(_me, '${m['month']}'))),
          ),
          const SizedBox(height: 10),
        ],
        SecondaryButton('Send the details to a parent', icon: Ph.shareNetwork, onTap: () => _send(m, upi)),
        const SizedBox(height: 12),
        Fig(
          'If your UPI app will not pay from here, copy the UPI id and pay it in the app yourself, or ask a parent to scan the code. '
          'Once the money has gone, tap I have paid. Your tutor checks it and confirms.',
          style: labelStyle,
        ),
      ],
    ]);
  }
}
