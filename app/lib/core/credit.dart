import 'package:flutter/foundation.dart';
import 'package:intl/intl.dart';

import 'api.dart';
import 'changes.dart';

/// AI credit: the tuition's balance for AI work (the server's lib/credit.ts). Reading a page and writing a question each have a
/// price; tests, students and results never need credit. Every amount is in paise.
class Credit {
  const Credit({required this.balance, required this.free, required this.pagePaise, required this.questionPaise});

  /// From Home's `credit` ({balance_paise, free_paise, page_paise, question_paise}), or the AI credit screen's answer
  /// ({credit: {balance_paise, free_paise}, prices: {page_paise, question_paise}}). Null when there is none (a server before credit).
  static Credit? from(Object? j) {
    if (j is! Map) return null;
    final c = j['credit'] is Map ? j['credit'] as Map : j;
    final p = j['prices'] is Map ? j['prices'] as Map : j;
    if (c['balance_paise'] is! num || p['page_paise'] is! num || p['question_paise'] is! num) return null;
    final balance = (c['balance_paise'] as num).toInt();
    return Credit(
      balance: balance,
      free: c['free_paise'] is num ? (c['free_paise'] as num).toInt() : balance,
      pagePaise: (p['page_paise'] as num).toInt(),
      questionPaise: (p['question_paise'] as num).toInt(),
    );
  }

  final int balance;

  /// What can be spent now: the balance, less what AI work under way has set aside.
  final int free;
  final int pagePaise;
  final int questionPaise;

  /// How many pages, or questions, an amount pays for.
  int pagesFor(int paise) => pagePaise <= 0 ? 0 : paise ~/ pagePaise;
  int questionsFor(int paise) => questionPaise <= 0 ? 0 : paise ~/ questionPaise;

  /// True when there is not enough for a page: the balance turns amber.
  bool get low => balance < pagePaise;

  /// True when there is not enough for anything AI does, a page or a question: the balance turns red and Home says so.
  bool get out => balance < (pagePaise < questionPaise ? pagePaise : questionPaise);
}

/// The credit the app last heard, for the balance on Home and the price shown before AI work. It belongs to one tuition: switching
/// tuitions forgets it until the next load.
class CreditStore extends ChangeNotifier {
  CreditStore() {
    // AI work and a request for more credit change the balance: anything showing it hears the new one.
    changes.addListener(() {
      if (changes.last.contains(Area.credit) && hasListeners) refresh();
    });
  }

  Credit? _value;
  String? _tuition;

  Credit? get value => _tuition == api.tuitionId ? _value : null;

  void set(Credit? c) {
    _value = c;
    _tuition = api.tuitionId;
    notifyListeners();
  }

  /// Loads it again. Null when it cannot be had (no connection, or a server before credit): the server still holds AI to it.
  Future<Credit?> refresh() async {
    try {
      final c = Credit.from(await api.get('/teacher/credit'));
      if (c != null) set(c);
      return c;
    } on ApiException {
      return value;
    }
  }
}

final credit = CreditStore();

final _inr = NumberFormat.currency(locale: 'en_IN', symbol: '₹', decimalDigits: 2);
final _inrWhole = NumberFormat.currency(locale: 'en_IN', symbol: '₹', decimalDigits: 0);

/// "₹80.40", "₹1,000.00".
String inr(int paise) => _inr.format(paise / 100);

/// "₹250", "₹1,000": an amount in whole rupees, as the amounts on offer are written.
String inrWhole(int paise) => paise % 100 == 0 ? _inrWhole.format(paise / 100) : inr(paise);

/// True when the server refused AI work because the credit does not cover it.
bool isNoCredit(Object e) => e is ApiException && e.code == 'no_credit';
