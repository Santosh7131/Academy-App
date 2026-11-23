import 'package:intl/intl.dart';

import 'credit.dart' show inrWhole;
import 'format.dart' as f;

// Fees (api/src/routes/fees.ts): a monthly fee per student and the payments against it, each for one month. Money is whole
// paise. What the screens and messages say about a month is worked out here, the same for the tutor and the student.

int paiseOf(Object? v) => v is num ? v.toInt() : int.tryParse('$v') ?? 0;

DateTime _month(String ym) {
  final p = ym.split('-').map(int.parse).toList();
  return DateTime(p[0], p[1]);
}

/// "November 2026" from "2026-11".
String monthName(String ym) => DateFormat('MMMM y').format(_month(ym));

/// "Nov 2026", for a payment note.
String monthShort(String ym) => DateFormat('MMM y').format(_month(ym));

/// "2026-12" from "2026-11" and 1.
String shiftMonth(String ym, int by) {
  final d = _month(ym);
  final m = DateTime(d.year, d.month + by);
  return '${m.year}-${m.month.toString().padLeft(2, '0')}';
}

/// "November 2026", "October and November 2026", "December 2026 and January 2027": months oldest first.
String monthsList(List<String> months) {
  if (months.isEmpty) return '';
  if (months.length == 1) return monthName(months.first);
  final sameYear = months.every((m) => m.substring(0, 4) == months.first.substring(0, 4));
  final names = [for (final m in months) sameYear ? DateFormat('MMMM').format(_month(m)) : monthName(m)];
  final listed = '${names.sublist(0, names.length - 1).join(', ')} and ${names.last}';
  return sameYear ? '$listed ${months.first.substring(0, 4)}' : listed;
}

/// "Thu 5 Nov" from "2026-11-05".
String dueDay(String ymd) => f.shortDate(f.dayOf(ymd));

/// "the 5th", for "due on the 5th of each month".
String ordinalDay(int d) {
  final tens = d % 100 ~/ 10;
  final s = tens == 1 ? 'th' : switch (d % 10) { 1 => 'st', 2 => 'nd', 3 => 'rd', _ => 'th' };
  return 'the $d$s';
}

enum MonthTone { paid, waiting, owed, late }

/// What a month row says, and how it looks: "Paid ₹1,500", "₹1,000 left of ₹1,500 · was due Thu 5 Nov". [forStudent] words a
/// payment waiting to be confirmed for the student, who said they paid, rather than for the tutor, who has to confirm it.
({String text, MonthTone tone}) monthLine(Map<String, dynamic> m, {bool forStudent = false}) {
  final fee = paiseOf(m['fee']);
  final paid = paiseOf(m['paid']);
  final left = paiseOf(m['left']);
  final due = m['due_on'] == null ? null : dueDay('${m['due_on']}');
  final late = m['late'] == true;
  switch ('${m['status']}') {
    case 'paid':
      return (text: 'Paid ${inrWhole(paid)}', tone: MonthTone.paid);
    case 'none':
      return (text: 'Paid ${inrWhole(paid)}, with no fee set', tone: MonthTone.paid);
    case 'claimed':
      return (
        text: forStudent ? 'You said you paid ${inrWhole(paiseOf(m['claimed']))}. Waiting for your tutor' : '${inrWhole(paiseOf(m['claimed']))} to confirm',
        tone: MonthTone.waiting,
      );
  }
  final owed = paid > 0 ? '${inrWhole(left)} left of ${inrWhole(fee)}' : '${inrWhole(fee)} to pay';
  if (due == null) return (text: owed, tone: MonthTone.owed);
  return late ? (text: '$owed · was due $due', tone: MonthTone.late) : (text: '$owed · due $due', tone: MonthTone.owed);
}

/// How a payment was made, as a word: "Cash", "UPI", "Other".
String methodName(Object? m) => switch ('$m') { 'cash' => 'Cash', 'upi' => 'UPI', _ => 'Other' };

/// The note a UPI payment carries, so the tutor knows it in their bank's list: "Harini Venkatesh fee Nov 2026".
String payNote(String student, String month) => '$student fee ${monthShort(month)}';

/// The message a tutor sends a parent about fees owed: how much, for which months, and where to pay. [owing] is the months
/// not paid, oldest first, each {month, left, due_on, late}.
String feeReminder({required String student, required List<Map<String, dynamic>> owing, Map<String, dynamic>? upi, required String tuition}) {
  final total = owing.fold<int>(0, (n, m) => n + paiseOf(m['left']));
  final String what;
  if (owing.length == 1) {
    final m = owing.first;
    final due = m['due_on'] == null ? '' : m['late'] == true ? ', was due on ${dueDay('${m['due_on']}')}' : ', is due on ${dueDay('${m['due_on']}')}';
    what = "$student's tuition fee for ${monthName('${m['month']}')}, ${inrWhole(total)}$due.";
  } else {
    what = "$student's tuition fees for ${monthsList([for (final m in owing) '${m['month']}'])} come to ${inrWhole(total)}.";
  }
  final how = upi == null ? 'You can pay at the class.' : 'You can pay by UPI to ${upi['id']}${_named(upi)}, or in cash at the class.';
  return 'Dear parent, $what $how\n\n$tuition';
}

/// The message a student sends a parent so the parent can pay from their own phone.
String payRequest({required String student, required String month, required int paise, required Map<String, dynamic> upi, required String tuition}) =>
    'Please pay ${inrWhole(paise)} by UPI to ${upi['id']}${_named(upi)}. It is $student\'s fee for ${monthName(month)} at $tuition. '
    'Add the note "${payNote(student, month)}". Tell me once it is paid, and I will mark it in the app.';

String _named(Map<String, dynamic> upi) {
  final n = '${upi['name'] ?? ''}'.trim();
  return n.isEmpty ? '' : ' ($n)';
}
