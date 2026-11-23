import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/changes.dart';
import '../../core/format.dart' as f;
import '../../core/levels.dart';
import '../../theme.dart';
import '../../ui/kit.dart';
import 'common.dart';
import 'subjects.dart';

/// Students waiting to be let in. Those who used a group's or course's link asked for that group or course, so letting them
/// in is one tap, or one for all of them. Those who typed the tuition's join code get their class and subjects chosen here.
class JoinRequestsScreen extends StatefulWidget {
  const JoinRequestsScreen({super.key});

  @override
  State<JoinRequestsScreen> createState() => _JoinRequestsScreenState();
}

class _JoinRequestsScreenState extends State<JoinRequestsScreen> with WidgetsBindingObserver, AutoRefresh<JoinRequestsScreen> {
  List<Map<String, dynamic>>? _rows;
  List<Map<String, dynamic>> _links = [];
  String? _error;
  bool _lettingAll = false;

  @override
  Set<Area> get refreshAreas => {Area.students, Area.settings};

  @override
  Duration? get pollEvery => const Duration(seconds: 30);

  @override
  Future<void> refreshQuietly() => _load();

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    markLoaded();
    try {
      final r = await api.get('/teacher/join-requests');
      if (mounted) {
        setState(() {
          _rows = (r['requests'] as List).cast<Map<String, dynamic>>();
          _links = ((r['link_requests'] as List?) ?? const []).cast<Map<String, dynamic>>();
          _error = null;
        });
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  String _first(Map<String, dynamic> r) => '${r['display_name']}'.split(' ').first;

  /// One student who asked with a link: let them into what they asked for, or decline.
  Future<void> _reviewLink(Map<String, dynamic> r) async {
    final first = _first(r);
    final answer = await showCentredCard<String>(
      context,
      title: first,
      subtitle: '${r['display_name']} asked to join ${r['label']}${r['place'] == 'active' ? '. They are already in your tuition.' : '.'}',
      builder: (ctx) => Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        PrimaryButton('Let $first in', onTap: () => Navigator.of(ctx).pop('accept')),
        const SizedBox(height: 10),
        SecondaryButton('Decline', tint: danger, onTap: () => Navigator.of(ctx).pop('decline')),
      ]),
    );
    if (answer == null || !mounted) return;
    try {
      await api.post('/teacher/link-requests/${r['id']}/${answer == 'accept' ? 'accept' : 'decline'}');
    } on ApiException catch (e) {
      if (mounted) await showProblem(context, e);
    }
    _load();
  }

  /// Lets in everyone who asked with a link. Anyone who cannot be let in that way (in another class here, say) stays on the
  /// list, and the card says why.
  Future<void> _letAllIn() async {
    setState(() => _lettingAll = true);
    try {
      final r = await api.post('/teacher/link-requests/accept-all');
      final left = ((r['left'] as List?) ?? const []).cast<Map<String, dynamic>>();
      if (left.isNotEmpty && mounted) {
        await showCentredCard<void>(
          context,
          title: '${f.count((r['accepted'] as num?)?.toInt() ?? 0, 'student')} let in',
          subtitle: left.length == 1 ? 'One is still waiting:' : '${left.length} are still waiting:',
          builder: (ctx) => Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            for (final l in left) ...[
              Fig('${l['name']}', style: rowTitleStyle),
              const SizedBox(height: 2),
              Fig('${l['reason']}', style: labelStyle),
              const SizedBox(height: 12),
            ],
            PrimaryButton('OK', onTap: () => Navigator.of(ctx).pop()),
          ]),
        );
      }
    } on ApiException catch (e) {
      if (mounted) await showProblem(context, e);
    } finally {
      if (mounted) setState(() => _lettingAll = false);
    }
    _load();
  }

  /// One student who typed the tuition's code: choose their class and subjects as they are let in, or decline.
  Future<void> _review(Map<String, dynamic> req) async {
    List<Subject> subjects;
    try {
      subjects = await loadSubjects();
    } on ApiException catch (e) {
      if (mounted) showProblem(context, e);
      return;
    }
    if (!mounted) return;
    int? cls = (req['class_level'] as num?)?.toInt();
    final chosen = <String>{};
    final first = _first(req);
    final answer = await showCentredCard<String>(
      context,
      title: first,
      subtitle: 'Choose their class and what they study here.',
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, set) => Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          const FormLabel('Class', top: 4),
          ClassField(value: cls, onChanged: (c) => set(() => cls = c)),
          const FormLabel('Subjects'),
          SubjectToggles(subjects: subjects, value: chosen, onChanged: (v) => set(() {
                chosen
                  ..clear()
                  ..addAll(v);
              })),
          const SizedBox(height: 18),
          PrimaryButton(
            'Let $first in',
            onTap: cls == null || chosen.isEmpty ? null : () => Navigator.of(ctx).pop('accept'),
            disabledReason: cls == null || chosen.isEmpty ? 'Choose a class and at least one subject.' : null,
          ),
          const SizedBox(height: 10),
          SecondaryButton('Decline', tint: danger, onTap: () => Navigator.of(ctx).pop('decline')),
        ]),
      ),
    );
    if (answer == null || !mounted) return;
    try {
      if (answer == 'accept') {
        await api.post('/teacher/join-requests/${req['id']}/accept', {'class_level': cls, 'subject_ids': chosen.toList()});
      } else {
        await api.post('/teacher/join-requests/${req['id']}/decline');
      }
    } on ApiException catch (e) {
      if (mounted) showProblem(context, e);
    }
    _load();
  }

  String _asked(Map<String, dynamic> r) => 'asked ${f.when(f.parseTime(r['asked_at']) ?? DateTime.now())}';

  @override
  Widget build(BuildContext context) {
    final rows = _rows;
    final links = _links;
    return PushedPanel(
      kicker: 'Students',
      title: 'Join requests',
      children: [
        const SizedBox(height: 14),
        if (rows == null && _error != null)
          ErrorState(message: _error!, onRetry: _load)
        else if (rows == null)
          const LoadingState()
        else if (rows.isEmpty && links.isEmpty)
          const EmptyState(
            icon: Ph.userPlus,
            title: 'No requests',
            body: 'When a student opens a group\'s or course\'s link, or types your join code, they wait here until you let them in.',
          )
        else ...[
          if (links.isNotEmpty) ...[
            SectionRule('Asked with a link', count: links.length, padding: const EdgeInsets.fromLTRB(0, 4, 0, 11)),
            if (links.length > 1) ...[
              PrimaryButton('Let all ${links.length} in', busy: _lettingAll, onTap: _letAllIn),
              const SizedBox(height: 12),
            ],
            for (final (i, r) in links.indexed) ...[
              if (i > 0) const SizedBox(height: gapRow),
              RowTile(
                leading: AppAvatar(name: '${r['display_name']}', seed: '${r['student_id']}'),
                title: '${r['display_name']}',
                meta: '${r['label']} · ${r['place'] == 'active' ? 'in your tuition' : 'new'} · ${_asked(r)}',
                chevron: true,
                onTap: () => _reviewLink(r),
              ),
            ],
          ],
          if (rows.isNotEmpty) ...[
            SectionRule('Asked with your join code', count: rows.length, padding: EdgeInsets.fromLTRB(0, links.isEmpty ? 4 : 26, 0, 11)),
            for (final (i, r) in rows.indexed) ...[
              if (i > 0) const SizedBox(height: gapRow),
              RowTile(
                leading: AppAvatar(name: '${r['display_name']}', seed: '${r['id']}'),
                title: '${r['display_name']}',
                meta: '${r['class_level'] == null ? 'No class yet' : className(r['class_level'])} · ${_asked(r)}',
                chevron: true,
                onTap: () => _review(r),
              ),
            ],
          ],
        ],
      ],
    );
  }
}
