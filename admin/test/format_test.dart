import 'package:admin/core/format.dart';
import 'package:admin/screens/credit.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('paiseOf reads rupees typed in a field as whole paise', () {
    expect(paiseOf('250'), 25000);
    expect(paiseOf('250.5'), 25050);
    expect(paiseOf('250.50'), 25050);
    expect(paiseOf('2.40'), 240);
    expect(paiseOf('0.6'), 60);
    expect(paiseOf('0.05'), 5);
    expect(paiseOf('₹1,000'), 100000);
    expect(paiseOf(' 12. '), 1200);
    expect(paiseOf('0'), 0);
    expect(paiseOf('9999999.99'), 999999999);
  });

  test('paiseOf refuses what is not an amount', () {
    for (final t in ['', ' ', '.5', '2.405', 'abc', '12345678', '-5', '1.2.3', '1e3', '₹']) {
      expect(paiseOf(t), isNull, reason: '"$t"');
    }
  });

  test('inr writes paise as rupees with Indian grouping', () {
    expect(inr(240), '₹2.40');
    expect(inr(8040), '₹80.40');
    expect(inr(0), '₹0.00');
    expect(inr(10000000), '₹1,00,000.00');
  });

  test('a long payment reference is shortened, a short one kept whole', () {
    expect(shortRef('428193650217'), '428193650217');
    expect(shortRef('4281936502170'), '4281…2170');
    expect(shortRef('CR-4TXH'), 'CR-4TXH');
  });

  test('a credit history line says what it was', () {
    expect(ledgerTitle({'kind': 'page', 'pages': 4, 'label': 'Practice Paper 2'}), 'Read 4 pages · Practice Paper 2');
    expect(ledgerTitle({'kind': 'page', 'pages': 1, 'label': null}), 'Read 1 page');
    expect(ledgerTitle({'kind': 'questions', 'questions': 10, 'label': '10th Maths'}), 'Wrote 10 questions · 10th Maths');
    expect(ledgerTitle({'kind': 'start'}), 'Free credit to start');
    expect(ledgerTitle({'kind': 'topup', 'ref': 'CR-7K3Q'}), 'Credit added · UPI');
    expect(ledgerTitle({'kind': 'by_hand'}), 'Credit added by hand');
  });
}
