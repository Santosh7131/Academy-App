import 'package:flutter/material.dart';

import '../../core/format.dart' as f;
import '../../theme.dart';
import '../../ui/desk.dart';
import '../../ui/kit.dart';
import 'tests_screens.dart' show testState, testStateTag;

// A group's and a course's page in a computer's browser (group_screens.dart, course_screens.dart): the tests and the people as
// tables across the page, in place of the phone's rows.

int _n(Object? v) => v is num ? v.toInt() : int.tryParse('$v') ?? 0;

/// The class's tests as a table, in the phone's order: open now first, then coming up, then not posted, then the finished ones (the
/// first three, and the rest on a click). [go] opens a test's page, or the editor of one not posted yet; [empty] is what the page
/// says when there are none.
List<Widget> deskClassTests(
  List<Map<String, dynamic>> tests, {
  required bool allFinished,
  required VoidCallback onToggleFinished,
  required void Function(String path) go,
  required String empty,
}) {
  if (tests.isEmpty) return [EmptyState(icon: Ph.exam, title: 'No tests yet', body: empty)];
  List<Map<String, dynamic>> of(String s) => tests.where((t) => testState(t) == s).toList();
  final finished = [...of('done'), ...of('closed')];
  final shown = [...of('open'), ...of('upcoming'), ...of('draft'), ...(allFinished ? finished : finished.take(3))];
  return [
    DeskTable(
      columns: const [
        DeskColumn('Test', flex: 3),
        DeskColumn('State', width: 100),
        DeskColumn('Questions', width: 74),
        DeskColumn('When', flex: 2),
        DeskColumn('Handed in', width: 150),
        DeskColumn('', width: 16),
      ],
      rows: [for (final t in shown) _testRow(t, go)],
    ),
    if (finished.length > 3)
      Align(
        alignment: Alignment.centerLeft,
        child: TextAction(allFinished ? 'Show fewer' : 'Show all ${finished.length} finished tests', onTap: onToggleFinished),
      ),
  ];
}

DeskRow _testRow(Map<String, dynamic> t, void Function(String path) go) {
  final s = testState(t);
  final opens = f.parseTime(t['opens_at']);
  final closes = f.parseTime(t['closes_at']);
  final when = switch (s) {
    'open' => closes == null ? 'Open, no closing time' : 'Closes ${f.whenDate(closes)}',
    'upcoming' => opens == null ? 'Opens later' : 'Opens ${f.whenDate(opens)}',
    'closed' => closes == null ? 'Closed' : 'Closed ${f.whenDate(closes)}',
    'done' => 'Everyone handed it in',
    _ => 'Not posted yet',
  };
  final counted = s == 'open' || s == 'done' || s == 'closed';
  final submitted = _n(t['submitted']);
  final assigned = _n(t['assigned']);
  final writing = s == 'open' ? _n(t['writing']) : 0;
  return DeskRow(
    [
      deskCellTitle('${t['title']}'),
      Align(alignment: Alignment.centerLeft, child: testStateTag(s)),
      deskCell('${_n(t['question_count'])}'),
      deskCell(when),
      if (!counted)
        const SizedBox.shrink()
      else
        Row(children: [
          Text('$submitted/$assigned', style: numStyle(size: 13, weight: FontWeight.w600)),
          const SizedBox(width: 10),
          Expanded(
            child: writing > 0
                ? Fig('$writing writing now', style: labelStyle.copyWith(color: warning), maxLines: 1)
                : Track(assigned == 0 ? 0 : submitted / assigned, height: 6),
          ),
        ]),
      deskChevron(),
    ],
    onTap: () => go(t['status'] == 'published' ? '/t/tests/${t['id']}' : '/t/tests/${t['id']}/edit'),
  );
}

/// The class's students (or a course's people) as a table: the name, the tests written and the average, with a tag on anyone whose
/// login is turned off. [open] opens one.
Widget deskPeople(List<Map<String, dynamic>> people, {required void Function(Map<String, dynamic> person) open}) => DeskTable(
      columns: const [DeskColumn('Name', flex: 3), DeskColumn('Tests written', width: 110), DeskColumn('Average', width: 90), DeskColumn('', width: 16)],
      rows: [
        for (final p in people)
          DeskRow(
            [
              Row(children: [
                AppAvatar(name: '${p['display_name']}', seed: '${p['id']}', size: 30),
                const SizedBox(width: 12),
                Flexible(child: deskCellTitle('${p['display_name']}')),
                if (p['active'] != true) ...[const SizedBox(width: 10), const TagChip('Login turned off', tone: Tone.warning)],
              ]),
              deskCell('${_n(p['tests_done'])}'),
              deskCell(p['avg_pct'] == null ? '' : f.percent(p['avg_pct'] as num)),
              deskChevron(),
            ],
            onTap: () => open(p),
          ),
      ],
    );

/// The tabs of a class's page, as wide as they need and no wider.
Widget deskTabs({required List<String> labels, required List<int?> counts, required int index, required ValueChanged<int> onChanged}) => Align(
      alignment: Alignment.centerLeft,
      child: SizedBox(
        width: 150.0 * labels.length,
        child: SegmentedToggle(labels: labels, counts: counts, index: index, onChanged: onChanged),
      ),
    );
