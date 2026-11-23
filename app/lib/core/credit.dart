import 'package:flutter/foundation.dart';
import 'package:intl/intl.dart';

import 'api.dart';
import 'changes.dart';

/// AI credit: the tuition's balance for AI work (the server's lib/credit.ts). Reading a page, writing a question and writing a
/// worked solution each have a price; tests, students and results never need credit. Every amount is in paise.
class Credit {
  const Credit({
    required this.balance, required this.free, required this.pagePaise, required this.questionPaise, this.solutionPaise, this.plan, this.nextMonthOn,
    this.plansOnSale,
  });

  /// From Home's `credit` ({balance_paise, free_paise, page_paise, question_paise, solution_paise}), or the AI credit screen's answer
  /// ({credit: {balance_paise, free_paise}, prices: {page_paise, question_paise, solution_paise}}). Null when there is none (a server
  /// before credit). A server before worked solutions sends no solution_paise.
  static Credit? from(Object? j) {
    if (j is! Map) return null;
    final c = j['credit'] is Map ? j['credit'] as Map : j;
    final p = j['prices'] is Map ? j['prices'] as Map : j;
    if (c['balance_paise'] is! num || p['page_paise'] is! num || p['question_paise'] is! num) return null;
    final balance = (c['balance_paise'] as num).toInt();
    // The plan: Home's credit says {plan: 'basic', next_month_on}, the AI credit screen {plan: {name, next_month_on}}.
    final pl = j['plan'] is Map ? j['plan'] as Map : c;
    final plan = pl == c ? c['plan'] : pl['name'];
    return Credit(
      balance: balance,
      free: c['free_paise'] is num ? (c['free_paise'] as num).toInt() : balance,
      pagePaise: (p['page_paise'] as num).toInt(),
      questionPaise: (p['question_paise'] as num).toInt(),
      solutionPaise: p['solution_paise'] is num ? (p['solution_paise'] as num).toInt() : null,
      plan: plan is String ? plan : null,
      nextMonthOn: pl['next_month_on'] is String ? pl['next_month_on'] as String : null,
      plansOnSale: pl['plans_on_sale'] is List ? [for (final p in pl['plans_on_sale'] as List) '$p'] : null,
    );
  }

  final int balance;

  /// What can be spent now: the balance, less what AI work under way has set aside.
  final int free;
  final int pagePaise;
  final int questionPaise;

  /// The price of one worked solution; null from a server before them.
  final int? solutionPaise;

  /// The plan the AI comes with ('free', 'basic' or 'pro'; the server's lib/plans.ts), and the day its next month's AI comes, as
  /// "2026-12-24" (null on Free and in a plan's last month). Both null from a server before plans.
  final String? plan;
  final String? nextMonthOn;

  /// The paid plans that can be bought now ('basic', 'pro'): none until the developer sets a price and a UPI id. Null from a server
  /// that does not say.
  final List<String>? plansOnSale;

  /// True on a paid plan: AI comes every month, and running out waits for the next one.
  bool get monthly => plan == 'basic' || plan == 'pro';

  /// How many pages, or questions, an amount pays for.
  int pagesFor(int paise) => pagePaise <= 0 ? 0 : paise ~/ pagePaise;
  int questionsFor(int paise) => questionPaise <= 0 ? 0 : paise ~/ questionPaise;

  /// True when there is not enough for a page: the balance turns amber.
  bool get low => balance < pagePaise;

  /// True when there is not enough for anything AI does, a page, a question or a worked solution: the balance turns red and Home
  /// says so.
  bool get out => balance < [pagePaise, questionPaise, ?solutionPaise].reduce((a, b) => a < b ? a : b);
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
