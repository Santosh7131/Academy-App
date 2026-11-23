// Fees (lib/core/fees.dart, lib/core/upi.dart, lib/features/teacher/fees_screens.dart, lib/features/student/fees_screen.dart):
// what a month says and what reminders say, the UPI link, and the screens: a month's fees with payments to confirm or turn
// down, a student's fees, a payment recorded for the oldest month owed with its receipt, a fee set from this month or the next,
// the UPI id, and the student paying by UPI and saying so, or taking it back.
//   flutter test test/fees_test.dart
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:intl/intl.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:tuition_app/core/api.dart';
import 'package:tuition_app/core/fees.dart';
import 'package:tuition_app/core/session.dart';
import 'package:tuition_app/core/upi.dart';
import 'package:tuition_app/features/student/fees_screen.dart';
import 'package:tuition_app/features/teacher/fees_screens.dart';
import 'package:tuition_app/theme.dart';
import 'package:tuition_app/ui/qr.dart';

final _thisMonth = DateFormat('yyyy-MM').format(DateTime.now());
final _lastMonth = shiftMonth(_thisMonth, -1);
final _today = DateFormat('yyyy-MM-dd').format(DateTime.now());

Map<String, dynamic> _month(String m, {int fee = 150000, int paid = 0, int claimed = 0, String status = 'unpaid', bool late = false}) => {
      'month': m, 'fee': fee, 'due_day': 5, 'due_on': '$m-05', 'paid': paid, 'claimed': claimed, 'status': status, 'late': late,
      'left': status == 'paid' ? 0 : fee - paid,
    };

Map<String, dynamic> _payment(String id, String month, {int amount = 150000, String status = 'confirmed', int? receipt, String method = 'cash', String? reference}) => {
      'id': id, 'student_id': 's1', 'student_name': 'Asha Rao', 'month': month, 'amount_paise': amount, 'method': method,
      'paid_on': _today, 'reference': reference, 'status': status, 'receipt_no': receipt, 'created_at': '${_today}T05:00:00Z',
      'confirmed_at': status == 'confirmed' ? '${_today}T05:00:00Z' : null, 'confirmed_by': status == 'confirmed' ? 'Priya' : null,
    };

/// The server's side: what each fee route answers, and what it was sent.
class _Server {
  Map<String, dynamic>? upi = {'id': 'priya.classes@examplebank', 'name': 'Priya Sharma'};
  List<Map<String, dynamic>> claims = [_payment('c1', _thisMonth, status: 'claimed', method: 'upi', reference: '998877665544')];
  List<Map<String, dynamic>> studentMonths = [_month(_thisMonth), _month(_lastMonth, late: true)];
  List<Map<String, dynamic>> studentPayments = [_payment('p1', shiftMonth(_thisMonth, -2), receipt: 1)];

  final sent = <String>[];
  final bodies = <Map<String, dynamic>>[];

  http.Response _ok(Object body, [int status = 200]) => http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json'});

  Map<String, dynamic> get _owing => {
        'fee': 150000, 'due_day': 5, 'set': true,
        'month': studentMonths.where((m) => m['month'] == _thisMonth).firstOrNull,
        'owing': [for (final m in studentMonths.reversed) if (m['status'] == 'unpaid' || m['status'] == 'claimed') m],
        'left': studentMonths.where((m) => m['status'] == 'unpaid').fold<int>(0, (n, m) => n + (m['left'] as int)),
      };

  Future<http.Response> handle(http.Request r) async {
    sent.add('${r.method} ${r.url.path}');
    if (r.body.isNotEmpty) bodies.add(Map<String, dynamic>.from(jsonDecode(r.body) as Map));
    final p = r.url.path;
    if (r.method == 'GET' && p == '/teacher/fees') {
      return _ok({
        'month': r.url.queryParameters['month'] ?? _thisMonth, 'this_month': _thisMonth, 'today': _today, 'upi': upi,
        'totals': {'expected': 450000, 'collected': 150000, 'waiting': 150000, 'left': 300000, 'students': 3, 'paid': 1, 'unpaid': 1, 'late': 1},
        'students': [
          {'id': 's2', 'display_name': 'Ravi Kumar', 'username': 'ravi', 'class_level': 9, 'active': true, ..._month(_thisMonth, paid: 50000, late: true)},
          {'id': 's3', 'display_name': 'Meena Iyer', 'username': 'meena', 'class_level': 9, 'active': true, ..._month(_thisMonth, paid: 150000, status: 'paid')},
          {'id': 's1', 'display_name': 'Asha Rao', 'username': 'asha', 'class_level': 9, 'active': true, ..._month(_thisMonth, claimed: 150000, status: 'claimed')},
        ],
        'others': [_payment('o1', _thisMonth, receipt: 2)..['student_name'] = 'Kiran Das'],
        'no_fee': [{'id': 's4', 'display_name': 'Divya Nair', 'username': 'divya', 'class_level': 9}],
        'claims': claims,
      });
    }
    if (r.method == 'POST' && p.startsWith('/teacher/fees/payments/') && p.endsWith('/confirm')) {
      claims = [];
      return _ok({'payment': _payment('c1', _thisMonth, receipt: 3, method: 'upi')});
    }
    if (r.method == 'DELETE' && p.startsWith('/teacher/fees/payments/')) {
      claims = [];
      return _ok({'ok': true});
    }
    if (r.method == 'GET' && p == '/teacher/fees/students/s1') {
      return _ok({
        'student': {'id': 's1', 'display_name': 'Asha Rao', 'username': 'asha', 'class_level': 9, 'active': true, 'joined': '2026-01'},
        'this_month': _thisMonth, 'today': _today, 'upi': upi, 'rates': [{'from_month': '2026-01', 'fee_paise': 150000, 'due_day': 5}],
        'months': studentMonths, 'payments': studentPayments, ..._owing,
      });
    }
    if (r.method == 'POST' && p == '/teacher/fees/payments') {
      return _ok({'payment': _payment('p9', '${bodies.last['month']}', amount: bodies.last['amount_paise'] as int, receipt: 7), 'settled_claim': false}, 201);
    }
    if (r.method == 'PUT' && p == '/teacher/fees/rates') return _ok({'students': 1});
    if (r.method == 'PUT' && p == '/teacher/fees/upi') return _ok({'upi': upi});
    if (r.method == 'GET' && p == '/student/fees') {
      return _ok({
        'tuition': {'id': 't-1', 'name': 'Priya Maths Classes'}, 'this_month': _thisMonth, 'today': _today, 'upi': upi,
        'months': studentMonths, 'payments': studentPayments, ..._owing,
      });
    }
    if (r.method == 'POST' && p == '/student/fees/paid') {
      final m = '${bodies.last['month']}';
      studentMonths = [for (final x in studentMonths) x['month'] == m ? {...x, 'status': 'claimed', 'claimed': x['left']} : x];
      studentPayments = [_payment('c9', m, status: 'claimed', method: 'upi'), ...studentPayments];
      return _ok({'payment': studentPayments.first}, 201);
    }
    if (r.method == 'DELETE' && p.startsWith('/student/fees/claims/')) {
      studentPayments = studentPayments.where((x) => x['status'] != 'claimed').toList();
      studentMonths = [for (final x in studentMonths) x['status'] == 'claimed' ? {...x, 'status': 'unpaid', 'claimed': 0} : x];
      return _ok({'ok': true});
    }
    return _ok({'error': {'code': 'not_found', 'message': 'No stub for ${r.method} $p'}}, 404);
  }
}

late _Server _s;

Future<void> _pump(WidgetTester t, [int ms = 800]) async {
  for (var left = ms; left > 0; left -= 50) {
    await t.pump(const Duration(milliseconds: 50));
  }
}

Future<void> _tap(WidgetTester t, Finder finder, [int ms = 800]) async {
  await t.ensureVisible(finder);
  await t.pump();
  await t.tap(finder);
  await _pump(t, ms);
}

/// The fee screens inside a router, starting at [at].
Future<void> _show(WidgetTester t, String at) async {
  setResolvedDark(false);
  t.view.physicalSize = const Size(411 * 2.625, 1600 * 2.625);
  t.view.devicePixelRatio = 2.625;
  addTearDown(t.view.reset);
  Map<String, dynamic> extra(GoRouterState s) => Map<String, dynamic>.from(s.extra! as Map);
  final router = GoRouter(initialLocation: at, routes: [
    GoRoute(path: '/t/fees', builder: (_, s) => FeesScreen(month: s.uri.queryParameters['month'])),
    GoRoute(path: '/t/fees/students/:id', builder: (_, s) => FeeStudentScreen(id: s.pathParameters['id']!, name: s.uri.queryParameters['name'])),
    GoRoute(path: '/t/fees/record', builder: (_, s) => RecordPaymentScreen(data: extra(s))),
    GoRoute(path: '/t/fees/receipt', builder: (_, s) => ReceiptScreen(payment: extra(s))),
    GoRoute(path: '/t/fees/set', builder: (_, s) => SetFeeScreen(target: s.extra! as FeeTarget)),
    GoRoute(path: '/t/fees/upi', builder: (_, s) => const UpiIdScreen()),
    GoRoute(path: '/s/fees', builder: (_, s) => const MyFeesScreen()),
  ]);
  await t.pumpWidget(MaterialApp.router(theme: buildTheme(Brightness.light), routerConfig: router));
  await _pump(t);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    SharedPreferences.setMockInitialValues({});
    await session.loadPrefs();
    http.runWithClient(() => api.token = 'test', () => MockClient((r) => _s.handle(r)));
    session.user = {'id': 'u-1', 'role': 'teacher', 'username': 'priya', 'display_name': 'Priya', 'class_level': null};
    session.tuitions = [
      {'id': 't-1', 'name': 'Priya Maths Classes', 'role': 'owner', 'status': 'active'},
    ];
    session.tuitionId = 't-1';
    session.tuitionName = 'Priya Maths Classes';
  });

  setUp(() => _s = _Server());

  group('what a month says', () {
    test('months by name, and lists of them', () {
      expect(monthName('2026-11'), 'November 2026');
      expect(shiftMonth('2026-12', 1), '2027-01');
      expect(monthsList(['2026-10', '2026-11']), 'October and November 2026');
      expect(monthsList(['2026-09', '2026-10', '2026-11']), 'September, October and November 2026');
      expect(monthsList(['2026-12', '2027-01']), 'December 2026 and January 2027');
    });

    test('the day a fee is due', () {
      expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 28].map(ordinalDay).toList(),
          ['the 1st', 'the 2nd', 'the 3rd', 'the 4th', 'the 11th', 'the 12th', 'the 13th', 'the 21st', 'the 22nd', 'the 23rd', 'the 28th']);
    });

    test('each state of a month', () {
      expect(monthLine(_month('2026-11', paid: 150000, status: 'paid')).text, 'Paid ₹1,500');
      final nov5 = dueDay('2026-11-05');
      expect(nov5, 'Thu 5 Nov', reason: 'a date is never split across lines');
      expect(monthLine(_month('2026-11')).text, '₹1,500 to pay · due $nov5');
      expect(monthLine(_month('2026-11', paid: 50000, late: true)).text, '₹1,000 left of ₹1,500 · was due $nov5');
      expect(monthLine(_month('2026-11', late: true)).tone, MonthTone.late);
      expect(monthLine(_month('2026-11', claimed: 150000, status: 'claimed')).text, '₹1,500 to confirm');
      expect(monthLine(_month('2026-11', claimed: 150000, status: 'claimed'), forStudent: true).text, 'You said you paid ₹1,500. Waiting for your tutor');
    });

    test('a reminder for one month, with the UPI id', () {
      expect(
        feeReminder(student: 'Asha Rao', owing: [_month('2026-11', late: true)], upi: {'id': 'priya.classes@examplebank', 'name': 'Priya Sharma'}, tuition: 'Priya Maths Classes'),
        "Dear parent, Asha Rao's tuition fee for November 2026, ₹1,500, was due on ${dueDay('2026-11-05')}. "
        'You can pay by UPI to priya.classes@examplebank (Priya Sharma), or in cash at the class.\n\nPriya Maths Classes',
      );
    });

    test('a reminder for two months, with no UPI id', () {
      expect(
        feeReminder(student: 'Asha Rao', owing: [_month('2026-10'), _month('2026-11')], tuition: 'Priya Maths Classes'),
        "Dear parent, Asha Rao's tuition fees for October and November 2026 come to ₹3,000. You can pay at the class.\n\nPriya Maths Classes",
      );
    });

    test('a UPI link: the amount from paise, the name and note encoded, the note kept short', () {
      expect(upiAmount(150000), '1500.00');
      expect(upiAmount(150050), '1500.50');
      expect(upiAmount(5), '0.05');
      expect(
        upiLink(id: 'priya.classes@examplebank', name: 'Priya & Sons', paise: 150000, note: payNote('Asha Rao', '2026-11')),
        'upi://pay?pa=priya.classes@examplebank&pn=Priya%20%26%20Sons&am=1500.00&cu=INR&tn=Asha%20Rao%20fee%20Nov%202026',
      );
      final long = upiLink(id: 'a@b', name: 'P', paise: 100, note: 'x' * 80);
      expect(Uri.decodeComponent(long.split('tn=').last).length, upiNoteMax);
    });
  });

  group("the tutor's fees", () {
    testWidgets('a month: payments to confirm first, then who has not paid, the late first, then who has', (t) async {
      await _show(t, '/t/fees');
      expect(find.text('TO CONFIRM'), findsOneWidget);
      expect(find.text('Reference 998877665544'), findsOneWidget);
      expect(find.text('NOT PAID'), findsOneWidget);
      expect(find.text('₹1,000 left of ₹1,500 · was due ${dueDay('$_thisMonth-05')}'), findsOneWidget);
      expect(find.text('Paid ₹1,500'), findsOneWidget);
      expect(find.text('NO LONGER HERE'), findsOneWidget);
      expect(find.text('Kiran Das'), findsOneWidget);
      expect(find.text('Set a fee for Divya Nair'), findsOneWidget);
      expect(find.text('Asha Rao'), findsOneWidget, reason: 'a student whose month waits to be confirmed is shown once, with the payment');
    });

    testWidgets('confirming a payment', (t) async {
      await _show(t, '/t/fees');
      await _tap(t, find.text('Confirm'), 1200);
      expect(_s.sent, contains('POST /teacher/fees/payments/c1/confirm'));
      expect(find.text('Confirmed. Asha Rao gets receipt 3.'), findsOneWidget);
    });

    testWidgets('turning one down asks first', (t) async {
      await _show(t, '/t/fees');
      await _tap(t, find.text('Not received'));
      expect(find.text('Not received?'), findsOneWidget);
      await _tap(t, find.text('Not received').last, 1200);
      expect(_s.sent, contains('DELETE /teacher/fees/payments/c1'));
    });

    testWidgets('no UPI id: the screen asks for one', (t) async {
      _s.upi = null;
      await _show(t, '/t/fees');
      expect(find.text('Add your UPI id'), findsOneWidget);
    });

    testWidgets("a student's fees, and the parents reminded", (t) async {
      await _show(t, '/t/fees/students/s1?name=Asha%20Rao');
      expect(find.text('₹1,500 a month'), findsOneWidget);
      expect(find.text('₹3,000'), findsOneWidget);
      expect(find.text('still to pay for ${monthsList([_lastMonth, _thisMonth])}'), findsOneWidget);
      expect(find.text('Remind the parents'), findsOneWidget);
      expect(find.text('Receipt 1', findRichText: true), findsNothing);
      expect(find.textContaining('Receipt 1'), findsOneWidget);
    });

    testWidgets('recording a payment starts at the oldest month owed, and opens its receipt', (t) async {
      await _show(t, '/t/fees/students/s1?name=Asha%20Rao');
      await _tap(t, find.text('Record a payment'));
      expect(find.text(monthName(_lastMonth)), findsOneWidget);
      expect(find.text('Save ₹1,500'), findsOneWidget);
      await _tap(t, find.text('UPI'));
      await _tap(t, find.text('Save ₹1,500'), 1500);
      expect(_s.bodies.last, {'student_id': 's1', 'month': _lastMonth, 'amount_paise': 150000, 'method': 'upi', 'paid_on': _today});
      expect(find.text('RECEIPT 7'), findsOneWidget, reason: 'the receipt opens, its number above its title (a kicker is in capitals)');
      expect(find.text('No. 7'), findsOneWidget);
      expect(find.text('Received with thanks by Priya'), findsOneWidget);
    });

    testWidgets('a fee set from next month', (t) async {
      await _show(t, '/t/fees/students/s1?name=Asha%20Rao');
      await _tap(t, find.text('₹1,500 a month'));
      expect(find.text('Change the fee'), findsOneWidget);
      await t.enterText(find.byType(TextField).first, '1800');
      await _pump(t);
      await _tap(t, find.text(monthName(shiftMonth(_thisMonth, 1))));
      await _tap(t, find.text('Save ₹1,800 a month'), 1200);
      expect(_s.bodies.last, {'student_ids': ['s1'], 'fee_paise': 180000, 'due_day': 5, 'from': shiftMonth(_thisMonth, 1)});
    });

    testWidgets('the UPI id, with the warning about phone numbers', (t) async {
      await _show(t, '/t/fees/upi');
      expect(find.textContaining('If it has your phone number in it'), findsOneWidget);
      expect(find.text('priya.classes@examplebank'), findsOneWidget);
      await _tap(t, find.text('Save'), 1200);
      expect(_s.bodies.last, {'upi_id': 'priya.classes@examplebank', 'upi_name': 'Priya Sharma'});
    });
  });

  group("the student's fees", () {
    testWidgets('the oldest month owed, a code to scan, the UPI id, and I have paid', (t) async {
      await _show(t, '/s/fees');
      expect(find.text(monthName(_lastMonth).toUpperCase()), findsOneWidget);
      expect(find.byWidgetPredicate((w) => w is QrBox && w.label == 'A UPI code to pay ₹1,500'), findsOneWidget);
      expect(find.text('priya.classes@examplebank'), findsOneWidget);
      expect(find.text('The UPI app shows the name Priya Sharma.'), findsOneWidget);
      expect(find.text('MONTHS'), findsOneWidget);
      await _tap(t, find.text('I have paid ₹1,500'));
      expect(find.text('Paid ₹1,500?'), findsOneWidget);
      await t.enterText(find.byType(TextField).last, '612345678901');
      await _tap(t, find.text('Yes, I have paid'), 1500);
      expect(_s.bodies.last, {'month': _lastMonth, 'reference': '612345678901'});
      expect(find.text('Marked as paid. It waits for your tutor to confirm it.'), findsOneWidget);
      expect(find.textContaining('It waits for your tutor to confirm it.'), findsNWidgets(2));
    });

    testWidgets('taking it back', (t) async {
      _s.studentMonths = [_month(_lastMonth, claimed: 150000, status: 'claimed', late: true)];
      _s.studentPayments = [_payment('c9', _lastMonth, status: 'claimed', method: 'upi')];
      await _show(t, '/s/fees');
      expect(find.text('I have paid ₹1,500'), findsNothing);
      await _tap(t, find.text('Take it back'));
      await _tap(t, find.text('Take it back').last, 1200);
      expect(_s.sent, contains('DELETE /student/fees/claims/c9'));
    });

    testWidgets('no UPI id: pay at the class', (t) async {
      _s.upi = null;
      await _show(t, '/s/fees');
      expect(find.text('Pay your tutor at the class. They will mark it here.'), findsOneWidget);
      expect(find.text('I have paid ₹1,500'), findsNothing);
    });
  });
}
