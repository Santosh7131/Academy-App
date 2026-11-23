import 'dart:io';
import 'dart:math';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:intl/intl.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/api.dart';
import '../../core/format.dart' as f;
import '../../core/levels.dart';
import '../../core/session.dart';
import '../../core/web_bits.dart' show saveOrShareFile, savesFiles;
import '../../theme.dart';
import '../../ui/kit.dart';
import 'common.dart';
import 'subjects.dart';

/// A student's progress as a picture for their parents: the tuition's name, one period's marks, the tests written and
/// missed, the chapters to practise and the ones going well, and a line from the tutor. The tutor sees the picture
/// here, then shares it (WhatsApp, or anything else on the phone). Opened from a course, it covers that course's tests.
class ParentReportScreen extends StatefulWidget {
  const ParentReportScreen({super.key, required this.id, this.courseId, this.courseName});

  final String id;
  final String? courseId;
  final String? courseName;

  /// Around the picture's boundary, so the screenshot tests can save the very picture that is shared.
  static const cardKey = ValueKey('parent-report-card');

  @override
  State<ParentReportScreen> createState() => _ParentReportScreenState();
}

enum ReportPeriod { thisMonth, lastMonth, all }

/// The period's first moment and the moment after its last, in the phone's own time; nulls for all time.
(DateTime?, DateTime?) reportRange(ReportPeriod p, DateTime now) => switch (p) {
  ReportPeriod.thisMonth => (DateTime(now.year, now.month), DateTime(now.year, now.month + 1)),
  ReportPeriod.lastMonth => (DateTime(now.year, now.month - 1), DateTime(now.year, now.month)),
  ReportPeriod.all => (null, null),
};

/// How the picture names its period: "November 2026", or "Up to 23 November 2026" for all time.
String reportPeriodName(ReportPeriod p, DateTime now) =>
    p == ReportPeriod.all ? 'Up to ${DateFormat('d MMMM y').format(now)}' : DateFormat('MMMM y').format(reportRange(p, now).$1!);

/// The card as the picture that is shared: 1080 pixels wide, three to each of its 360 points.
Future<Uint8List> reportPicture(RenderRepaintBoundary boundary) async {
  final image = await boundary.toImage(pixelRatio: 3);
  final data = await image.toByteData(format: ui.ImageByteFormat.png);
  image.dispose();
  return data!.buffer.asUint8List();
}

class _ParentReportScreenState extends State<ParentReportScreen> {
  final _boundary = GlobalKey();
  final _note = TextEditingController();
  var _period = ReportPeriod.thisMonth;
  Map<String, dynamic>? _d;
  String? _error;
  var _sharing = false;
  // Only the answer to the latest choice of period is shown, whichever arrives last.
  var _asked = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final ask = ++_asked;
    final (from, to) = reportRange(_period, DateTime.now());
    final query = {
      if (widget.courseId != null) 'course': widget.courseId!,
      if (from != null) 'from': from.toUtc().toIso8601String(),
      if (to != null) 'to': to.toUtc().toIso8601String(),
    };
    try {
      final d = await api.get(Uri(path: '/teacher/students/${widget.id}', queryParameters: query.isEmpty ? null : query).toString());
      if (!mounted || ask != _asked) return;
      setState(() {
        _d = Map<String, dynamic>.from(d);
        _error = null;
      });
    } on ApiException catch (e) {
      if (mounted && ask == _asked) setState(() => _error = e.message);
    }
  }

  void _choose(int i) {
    if (i == _period.index) return;
    setState(() => _period = ReportPeriod.values[i]);
    _load();
  }

  Future<void> _share(Map<String, dynamic> s) async {
    setState(() => _sharing = true);
    try {
      final now = DateTime.now();
      final png = await reportPicture(_boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary);
      final month = DateFormat('yyyy-MM').format(reportRange(_period, now).$1 ?? now);
      final name = 'report-${s['username'] ?? widget.id}-$month.png';
      final text = "${s['display_name']}'s progress report from ${session.tuitionName}: ${reportPeriodName(_period, now)}.";
      if (kIsWeb) {
        await saveOrShareFile(png, name: name, mimeType: 'image/png', text: text);
        return;
      }
      final dir = await getTemporaryDirectory();
      final file = File('${dir.path}/$name');
      await file.writeAsBytes(png, flush: true);
      await SharePlus.instance.share(ShareParams(files: [XFile(file.path, mimeType: 'image/png')], text: text));
    } catch (e) {
      if (mounted) await showProblem(context, e);
    } finally {
      if (mounted) setState(() => _sharing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = _d;
    final s = d == null ? null : Map<String, dynamic>.from(d['student']);
    return PushedPanel(
      kicker: s == null ? 'Student' : '${s['display_name']}',
      title: 'Report for parents',
      footer: PrimaryButton(savesFiles ? 'Save as a picture' : 'Share as a picture', icon: savesFiles ? Ph.downloadSimple : Ph.shareNetwork, busy: _sharing, onTap: s == null || _sharing ? null : () => _share(s)),
      children: [
        const SizedBox(height: 18),
        SegmentedToggle(labels: const ['This month', 'Last month', 'All time'], index: _period.index, onChanged: _choose),
        const SizedBox(height: 14),
        GroupedInputs(
          children: [
            BareField(
              controller: _note,
              placeholder: 'A line for the parents (optional)',
              minLines: 2,
              maxLines: 4,
              maxLength: 240,
              capitalization: TextCapitalization.sentences,
              onChanged: (_) => setState(() {}),
            ),
          ],
        ),
        const SizedBox(height: 18),
        if (d == null && _error != null)
          ErrorState(message: _error!, onRetry: _load)
        else if (d == null)
          const LoadingState(rows: 4)
        else
          // Drawn at 360 points whatever the phone's width or text size, then fitted to the screen: every picture
          // comes out the same, 1080 pixels wide. Rounded here like the app's cards; the picture itself stays square.
          ClipRRect(
            borderRadius: BorderRadius.circular(rCard),
            child: FittedBox(
              fit: BoxFit.fitWidth,
              child: MediaQuery(
                data: MediaQuery.of(context).copyWith(textScaler: TextScaler.noScaling),
                child: KeyedSubtree(
                  key: ParentReportScreen.cardKey,
                  child: RepaintBoundary(
                    key: _boundary,
                    child: SizedBox(
                      width: 360,
                      child: ReportCard(data: d, period: _period, now: DateTime.now(), note: _note.text.trim(), courseName: widget.courseName),
                    ),
                  ),
                ),
              ),
            ),
          ),
        const SizedBox(height: 12),
        Text('This is the picture parents get, on white whatever your phone shows.', style: bodyStyle.copyWith(color: muted)),
      ],
    );
  }
}

/// The light tokens of theme.dart, fixed: the picture goes to parents, so it is light whatever the tutor's phone shows.
abstract final class _Paper {
  static const page = Color(0xFFFFFFFF);
  static const panel = Color(0xFFF6F6F8);
  static const track = Color(0xFFEDEDF1);
  static const ink = Color(0xFF0E0E11);
  static const body = Color(0xFF3A3A42);
  static const muted = Color(0xFF8E8E99);
  static const danger = Color(0xFFE4483D);
  static const warning = Color(0xFFC77B1E);
  static const success = Color(0xFF1A9E62);
}

/// The picture itself, 360 points wide. Public so its tests can draw it with made-up results.
class ReportCard extends StatelessWidget {
  const ReportCard({super.key, required this.data, required this.period, required this.now, this.note = '', this.courseName});

  final Map<String, dynamic> data;
  final ReportPeriod period;
  final DateTime now;
  final String note;
  final String? courseName;

  /// At most this many tests are listed; the rest are counted.
  static const testsShown = 8;

  @override
  Widget build(BuildContext context) {
    final s = Map<String, dynamic>.from(data['student']);
    final written = (data['attempts'] as List).cast<Map<String, dynamic>>().where((a) => a['submitted_at'] != null).toList();
    final missed = (data['missed'] as List).cast<Map<String, dynamic>>();
    // Attendance in the period, on the same registers as the results; shown once a register with the student on it was taken.
    final att = data['attendance'] is Map ? (data['attendance'] as Map).cast<String, dynamic>() : null;
    final classes = (att?['classes'] as num?)?.toInt() ?? 0;
    final cameTo = (att?['present'] as num?)?.toInt() ?? 0;
    // "No chapter" means the tutor never gave those questions one: nothing a parent could act on.
    final chapters = (data['chapters'] as List).cast<Map<String, dynamic>>().where((c) => c['chapter'] != 'No chapter').toList();

    double mark(Map<String, dynamic> a) => (a['score'] as num) / max(a['max_score'] as num, 1);
    double ratio(Map<String, dynamic> c) => (c['correct'] as num) / max(c['total'] as num, 1);
    final avg = written.isEmpty ? null : written.map(mark).reduce((x, y) => x + y) / written.length;
    // The same rule as the student's page: below 80% is a chapter to practise, weakest first. Going well needs a few
    // questions behind it, or one lucky answer would count.
    final weak = ([...chapters]..sort((a, b) => ratio(a).compareTo(ratio(b)))).where((c) => ratio(c) < 0.8).take(3).toList();
    final strong = ([
      ...chapters,
    ]..sort((a, b) => ratio(b).compareTo(ratio(a)))).where((c) => ratio(c) >= 0.8 && (c['total'] as num) >= 3).take(3).toList();
    final rows = <(DateTime, Map<String, dynamic>, bool)>[
      for (final a in written) (f.parseTime(a['submitted_at']) ?? now, a, false),
      for (final m in missed) (f.parseTime(m['closes_at']) ?? now, m, true),
    ]..sort((a, b) => b.$1.compareTo(a.$1));

    final who = courseName ?? [className(s['class_level']), ...subjectNames(s['subjects'])].where((p) => p.isNotEmpty).join(' · ');
    final tutor = '${session.user?['display_name'] ?? ''}'.trim();
    final day = DateFormat('d MMM y');

    Widget heading(String text) => Padding(
      padding: const EdgeInsets.only(top: 22, bottom: 8),
      child: Text(
        text.toUpperCase(),
        style: labelStyle.copyWith(color: _Paper.muted, fontWeight: FontWeight.w600, letterSpacing: 0.9),
      ),
    );

    return ColoredBox(
      color: _Paper.page,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(24, 26, 24, 22),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              session.tuitionName.toUpperCase(),
              style: kickerStyle.copyWith(color: _Paper.ink, fontWeight: FontWeight.w700, letterSpacing: 1.3, fontSize: 12.5),
              maxLines: 2,
            ),
            const SizedBox(height: 4),
            Text('Progress report · ${reportPeriodName(period, now)}', style: bodyStyle.copyWith(color: _Paper.muted)),
            const SizedBox(height: 18),
            Text(
              '${s['display_name']}',
              style: titleStyle.copyWith(color: _Paper.ink, fontSize: 25),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
            if (who.isNotEmpty) ...[
              const SizedBox(height: 3),
              Text(
                who,
                style: bodyStyle.copyWith(color: _Paper.body),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
            ],
            const SizedBox(height: 16),
            DecoratedBox(
              decoration: BoxDecoration(color: _Paper.panel, borderRadius: BorderRadius.circular(rSmall)),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(6, 14, 6, 14),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _Stat(avg == null ? '-' : '${(avg * 100).round()}%', 'Average marks'),
                    _Stat('${written.length}', written.length == 1 ? 'Test written' : 'Tests written'),
                    _Stat('${missed.length}', 'Missed', tone: missed.isEmpty ? null : _Paper.danger),
                    if (classes > 0) _Stat('$cameTo/$classes', 'Classes attended'),
                  ],
                ),
              ),
            ),
            heading('Tests'),
            if (rows.isEmpty)
              Text('No tests in this period.', style: bodyStyle.copyWith(color: _Paper.muted))
            else ...[
              for (final (at, t, isMissed) in rows.take(testsShown))
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 5),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          '${t['title']}${!isMissed && (t['attempt_no'] as int? ?? 1) > 1 ? ' (retake)' : ''}',
                          style: rowTitleStyle.copyWith(color: _Paper.ink),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      const SizedBox(width: 10),
                      Text(DateFormat('d MMM').format(at), style: labelStyle.copyWith(color: _Paper.muted)),
                      const SizedBox(width: 12),
                      SizedBox(
                        width: 58,
                        child: isMissed
                            ? Text(
                                'Missed',
                                textAlign: TextAlign.right,
                                style: labelStyle.copyWith(color: _Paper.danger, fontWeight: FontWeight.w700),
                              )
                            : Text(
                                '${f.marks(t['score'])}/${f.marks(t['max_score'])}',
                                textAlign: TextAlign.right,
                                style: numStyle(size: 14, color: _Paper.ink),
                              ),
                      ),
                    ],
                  ),
                ),
              if (rows.length > testsShown)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text('and ${rows.length - testsShown} more', style: labelStyle.copyWith(color: _Paper.muted)),
                ),
            ],
            if (weak.isNotEmpty) ...[
              heading('Needs practice'),
              for (final c in weak) _ChapterRow('${c['chapter']}', ratio(c), ratio(c) < 0.5 ? _Paper.danger : _Paper.warning),
            ],
            if (strong.isNotEmpty) ...[heading('Doing well'), for (final c in strong) _ChapterRow('${c['chapter']}', ratio(c), _Paper.success)],
            if (note.isNotEmpty) ...[
              heading('From the tutor'),
              Text(note, style: bodyStyle.copyWith(color: _Paper.ink, fontSize: 14.5, height: 1.45)),
            ],
            const SizedBox(height: 22),
            const SizedBox(
              height: 1,
              width: double.infinity,
              child: ColoredBox(color: _Paper.track),
            ),
            const SizedBox(height: 10),
            Text([if (tutor.isNotEmpty) 'From $tutor', day.format(now)].join(' · '), style: labelStyle.copyWith(color: _Paper.muted)),
          ],
        ),
      ),
    );
  }
}

/// One figure in the row at the top: big number, small label.
class _Stat extends StatelessWidget {
  const _Stat(this.value, this.label, {this.tone});

  final String value;
  final String label;
  final Color? tone;

  @override
  Widget build(BuildContext context) => Expanded(
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4),
      child: Column(
        children: [
          // A long figure (20/22) shrinks to fit its quarter of the row rather than being cut.
          FittedBox(fit: BoxFit.scaleDown, child: Text(value, style: numStyle(size: 24, color: tone ?? _Paper.ink), maxLines: 1)),
          const SizedBox(height: 6),
          Text(label, style: labelStyle.copyWith(color: _Paper.muted), textAlign: TextAlign.center),
        ],
      ),
    ),
  );
}

/// A chapter with how much of it the student got right, as a bar and a percentage.
class _ChapterRow extends StatelessWidget {
  const _ChapterRow(this.name, this.fraction, this.color);

  final String name;
  final double fraction;
  final Color color;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 6),
    child: Row(
      children: [
        Expanded(
          flex: 5,
          child: Text(
            name,
            style: rowTitleStyle.copyWith(color: _Paper.ink),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          flex: 4,
          child: ClipRRect(
            borderRadius: BorderRadius.circular(3),
            child: SizedBox(
              height: 6,
              child: ColoredBox(
                color: _Paper.track,
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: FractionallySizedBox(
                    widthFactor: fraction.clamp(0.0, 1.0),
                    heightFactor: 1,
                    child: ColoredBox(color: color),
                  ),
                ),
              ),
            ),
          ),
        ),
        const SizedBox(width: 12),
        SizedBox(
          width: 40,
          child: Text(
            f.percent(fraction),
            textAlign: TextAlign.right,
            style: numStyle(size: 13, color: _Paper.ink),
          ),
        ),
      ],
    ),
  );
}
