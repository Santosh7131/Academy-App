import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tuition_app/core/session.dart';
import 'package:tuition_app/features/teacher/parent_report.dart';

Map<String, dynamic> _data({List<Map<String, dynamic>> attempts = const [], List<Map<String, dynamic>> missed = const [], List<Map<String, dynamic>> chapters = const []}) => {
      'student': {'id': 's-1', 'display_name': 'Harini Venkatesh', 'username': 'harini.v', 'class_level': 9, 'subjects': []},
      'attempts': attempts,
      'missed': missed,
      'chapters': chapters,
    };

Future<void> _card(WidgetTester t, Map<String, dynamic> data) async {
  session.tuitionName = 'Priya Maths Classes';
  await t.pumpWidget(MaterialApp(
    home: Scaffold(
      body: SingleChildScrollView(
        child: SizedBox(width: 360, child: ReportCard(data: data, period: ReportPeriod.thisMonth, now: DateTime(2026, 11, 23))),
      ),
    ),
  ));
}

void main() {
  test('a month runs from its first day to the next month, across a year end too', () {
    expect(reportRange(ReportPeriod.thisMonth, DateTime(2026, 12, 31, 23, 59)), (DateTime(2026, 12), DateTime(2027)));
    expect(reportRange(ReportPeriod.lastMonth, DateTime(2027, 1, 2)), (DateTime(2026, 12), DateTime(2027)));
    expect(reportRange(ReportPeriod.all, DateTime(2026, 11, 23)), (null, null));
  });

  test('the picture names its period', () {
    expect(reportPeriodName(ReportPeriod.thisMonth, DateTime(2026, 11, 23)), 'November 2026');
    expect(reportPeriodName(ReportPeriod.lastMonth, DateTime(2027, 1, 2)), 'December 2026');
    expect(reportPeriodName(ReportPeriod.all, DateTime(2026, 11, 23)), 'Up to 23 November 2026');
  });

  testWidgets('a period with no tests says so, and shows no chapters', (t) async {
    await _card(t, _data());
    expect(find.text('No tests in this period.'), findsOneWidget);
    expect(find.text('NEEDS PRACTICE'), findsNothing);
    expect(find.text('DOING WELL'), findsNothing);
    expect(find.text('PRIYA MATHS CLASSES'), findsOneWidget);
  });

  testWidgets('chapters without a name are left out, and at most eight tests are listed', (t) async {
    final at = DateTime(2026, 11, 20).toUtc().toIso8601String();
    await _card(
      t,
      _data(
        attempts: [
          for (var i = 0; i < 10; i++)
            {'id': 'a-$i', 'title': 'Test $i', 'attempt_no': 1, 'score': 5, 'max_score': 10, 'started_at': at, 'submitted_at': at},
        ],
        chapters: [
          {'chapter': 'No chapter', 'correct': 0, 'total': 9},
          {'chapter': 'Polynomials', 'correct': 2, 'total': 10},
          {'chapter': 'Statistics', 'correct': 4, 'total': 4},
        ],
      ),
    );
    expect(find.text('and 2 more'), findsOneWidget);
    expect(find.text('No chapter'), findsNothing);
    expect(find.text('Polynomials'), findsOneWidget);
    expect(find.text('Statistics'), findsOneWidget);
    expect(find.text('50%'), findsOneWidget);
  });
}
