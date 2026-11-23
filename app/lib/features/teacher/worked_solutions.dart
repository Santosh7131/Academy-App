import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/credit.dart';
import '../../core/format.dart' as f;
import '../../core/options.dart' show optionLetter;
import '../../theme.dart';
import '../../ui/kit.dart';

/// How many questions one request asks for (SOLUTIONS_PER_REQUEST in the server's lib/solutions.ts): one AI call answers them all.
const _perRequest = 4;

/// Whether a test's question has a worked solution: the test's settings send the solution itself, its results whether there is one.
bool hasSolution(Map<String, dynamic> q) => q['has_solution'] == true || '${q['solution'] ?? ''}'.trim().isNotEmpty;

/// "question 4", "questions 4 and 9", "questions 4, 9 and 12".
String _questionsNamed(List<int> ns) {
  if (ns.length == 1) return 'question ${ns.single}';
  return 'questions ${ns.take(ns.length - 1).join(', ')} and ${ns.last}';
}

/// What came of writing solutions once: how many were written, and the questions AI could not do, by their number in the test.
class _Run {
  int written = 0;
  final different = <({int n, int? ai, int? marked})>[];
  final figure = <int>[];
  final unusable = <int>[];
  String? stopped;

  /// "question 4 (it reached B; A is marked)": the letters as the tutor sees them, in the question's own order.
  static String _differs(({int n, int? ai, int? marked}) d) {
    final reached = d.ai == null ? 'it matched no option' : 'it reached ${optionLetter(d.ai!)}';
    return 'question ${d.n} ($reached${d.marked == null ? '' : '; ${optionLetter(d.marked!)} is marked'})';
  }

  String get report {
    final out = <String>[
      if (written > 0) 'Wrote ${f.count(written, 'worked solution')}.',
      if (different.isNotEmpty)
        'AI reached a different answer for ${different.map(_differs).join(', ')}. '
            'Check ${different.length == 1 ? 'that answer' : 'those answers'}: once the answer marked is the one AI reaches, it writes the solution.',
      if (figure.isNotEmpty) '${_questionsNamed(figure).replaceFirst('q', 'Q')} ${figure.length == 1 ? 'needs its figure' : 'need their figures'}, which AI cannot see.',
      if (unusable.isNotEmpty) 'AI could not write a usable one for ${_questionsNamed(unusable)}. You can try again.',
      if (stopped != null) 'Stopped: $stopped',
    ];
    return out.isEmpty ? 'Nothing was written.' : out.join('\n\n');
  }

  Tone get tone => stopped != null || different.isNotEmpty ? Tone.warning : (written > 0 ? Tone.success : Tone.neutral);
}

/// Worked solutions for a test's questions, written by AI (the server's routes/solutions.ts): how many questions have one, and a
/// button that writes the rest, a few at a time, at the price shown before it starts. AI works each question out on its own and a
/// solution is kept only when it reaches the answer marked; the ones it could not match are listed by number, so the tutor can check
/// those answers. Students see a solution after they hand the test in, as they see one the tutor wrote.
class WorkedSolutions extends StatefulWidget {
  const WorkedSolutions({super.key, required this.testId, required this.questions, this.onWritten, this.beforeWriting});
  final String testId;

  /// The test's questions in order, each with its id, its answer (`correct_option`) and its `solution` or `has_solution`.
  final List<Map<String, dynamic>> questions;

  /// After solutions were written, so the page can load its questions again.
  final VoidCallback? onWritten;

  /// Runs before anything is written (a draft is saved, so its questions are the test's). False stops.
  final Future<bool> Function()? beforeWriting;

  @override
  State<WorkedSolutions> createState() => _WorkedSolutionsState();
}

class _WorkedSolutionsState extends State<WorkedSolutions> {
  /// Questions this page saw get a solution, until the page loads them again.
  final _written = <String>{};
  bool _busy = false;
  int _done = 0;
  int _total = 0;
  _Run? _last;

  @override
  void initState() {
    super.initState();
    credit.addListener(_heard);
    // The price is shown on the button; a page opened from a notification has not loaded it yet.
    if (credit.value == null) credit.refresh();
  }

  @override
  void dispose() {
    credit.removeListener(_heard);
    super.dispose();
  }

  void _heard() {
    if (mounted) setState(() {});
  }

  bool _has(Map<String, dynamic> q) => hasSolution(q) || _written.contains('${q['id']}');

  Future<void> _write(List<Map<String, dynamic>> missing) async {
    final price = credit.value?.solutionPaise;
    final ok = await confirmCard(
      context,
      title: 'Write ${f.count(missing.length, 'worked solution')} with AI?',
      body: 'AI works each question out on its own and keeps a solution only when it reaches the answer you marked. '
          '${price == null ? 'Each one kept uses AI credit' : 'Each one kept costs ${inr(price)} of AI credit, ${missing.length == 1 ? '' : 'up to ${inr(price * missing.length)} in all, '}'}'
          'and the ones it cannot match cost nothing.',
      confirm: missing.length == 1 ? 'Write it' : 'Write them',
    );
    if (!ok || !mounted) return;
    if (widget.beforeWriting != null && !await widget.beforeWriting!()) return;
    if (!mounted) return;
    final at = {for (final (i, q) in widget.questions.indexed) '${q['id']}': (n: i + 1, marked: q['correct_option'] as int?)};
    final run = _Run();
    setState(() {
      _busy = true;
      _done = 0;
      _total = missing.length;
      _last = null;
    });
    try {
      for (var i = 0; i < missing.length; i += _perRequest) {
        final chunk = missing.skip(i).take(_perRequest).toList();
        final r = await api.post('/teacher/tests/${widget.testId}/solutions', {'question_ids': [for (final q in chunk) q['id']]}, const Duration(minutes: 2));
        for (final s in (r['solutions'] as List).cast<Map<String, dynamic>>()) {
          final q = at['${s['id']}'];
          if (q == null) continue;
          switch (s['outcome']) {
            case 'written':
              run.written++;
              _written.add('${s['id']}');
            case 'has_solution':
              _written.add('${s['id']}');
            case 'different':
              run.different.add((n: q.n, ai: s['ai_answer'] as int?, marked: q.marked));
            case 'figure':
              run.figure.add(q.n);
            default:
              run.unusable.add(q.n);
          }
        }
        // Leaving the page stops the run after the request under way; what was written is kept.
        if (!mounted) return;
        setState(() => _done = i + chunk.length);
      }
    } on ApiException catch (e) {
      run.stopped = e.message;
    } finally {
      credit.refresh();
      if (mounted) {
        setState(() {
          _busy = false;
          _last = run;
        });
        widget.onWritten?.call();
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final qs = widget.questions;
    final missing = qs.where((q) => !_has(q)).toList();
    final have = qs.length - missing.length;
    final price = credit.value?.solutionPaise;
    final which = missing.length == qs.length
        ? (qs.length == 1 ? 'it' : qs.length == 2 ? 'both' : 'all ${qs.length}')
        : (missing.length == 1 ? 'the last one' : 'the other ${missing.length}');
    final line = labelStyle.copyWith(fontSize: 13, fontWeight: FontWeight.w600);
    return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Surface(
        shadow: e1,
        padding: const EdgeInsets.fromLTRB(17, 14, 15, 14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Padding(padding: const EdgeInsets.only(top: 1), child: Icon(Ph.notePencil, size: 16, color: faint)),
            const SizedBox(width: 8),
            Expanded(
              child: Fig(
                missing.isEmpty
                    ? (qs.length == 1 ? 'The question has a worked solution' : 'Every question has a worked solution')
                    : '$have of ${f.count(qs.length, 'question')} ${have == 1 ? 'has' : 'have'} a worked solution',
                style: line.copyWith(color: ink),
              ),
            ),
          ]),
          const SizedBox(height: 4),
          Padding(
            padding: const EdgeInsets.only(left: 24),
            child: Fig('Students see it after they hand the test in.', style: labelStyle.copyWith(fontSize: 12, height: 1.4)),
          ),
          if (missing.isNotEmpty) ...[
            const SizedBox(height: 12),
            SecondaryButton(
              _busy
                  ? 'Writing: $_done of $_total done'
                  : 'Write $which with AI${price == null || price == 0 ? '' : ' · ${inr(price * missing.length)}'}',
              icon: Ph.sparkle,
              onTap: _busy ? null : () => _write(missing),
            ),
          ],
        ]),
      ),
      if (_last != null) ...[
        const SizedBox(height: 10),
        InlineNotice(_last!.report, tone: _last!.tone, icon: _last!.tone == Tone.warning ? Ph.warning : Ph.checkCircle),
      ],
    ]);
  }
}
