import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/session.dart';
import '../../theme.dart';
import '../../ui/kit.dart';

/// What a join link that opened the app is for: its tuition, and its group or course (GET /join/:code, which needs no login).
/// The screen adds its own buttons below with [footer]. A link that stopped working says so, and is forgotten when the student
/// taps OK.
class JoinInviteCard extends StatefulWidget {
  const JoinInviteCard({super.key, required this.code, this.footer});
  final String code;
  final Widget Function(Map<String, dynamic> link)? footer;

  @override
  State<JoinInviteCard> createState() => _JoinInviteCardState();
}

class _JoinInviteCardState extends State<JoinInviteCard> {
  Map<String, dynamic>? _link;
  String? _problem;
  bool _gone = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(JoinInviteCard old) {
    super.didUpdateWidget(old);
    if (old.code != widget.code) _load();
  }

  Future<void> _load() async {
    setState(() {
      _link = null;
      _problem = null;
      _gone = false;
    });
    final code = widget.code;
    try {
      final r = await api.get('/join/$code');
      if (mounted && code == widget.code) setState(() => _link = Map<String, dynamic>.from(r['link'] as Map));
    } on ApiException catch (e) {
      if (mounted && code == widget.code) {
        setState(() {
          _problem = e.message;
          _gone = e.status == 404;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final link = _link;
    return Surface(
      shadow: e1,
      padding: const EdgeInsets.fromLTRB(20, 18, 20, 18),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        const Kicker('Invited to join'),
        const SizedBox(height: 8),
        if (link != null) ...[
          Fig('${link['tuition']?['name'] ?? ''}', style: rowTitleStyle.copyWith(fontSize: 22, fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          Fig('${link['label'] ?? ''}', style: bodyStyle.copyWith(color: muted)),
          if (link['joining_open'] == false) ...[
            const SizedBox(height: 12),
            const InlineNotice('This tuition is not taking new students right now.', icon: Ph.info),
          ],
          if (widget.footer != null) ...[const SizedBox(height: 16), widget.footer!(link)],
        ] else if (_problem != null) ...[
          InlineNotice(_problem!, icon: Ph.warning),
          const SizedBox(height: 6),
          Align(
            alignment: Alignment.centerLeft,
            child: TextAction(_gone ? 'OK' : 'Try again', color: ink, onTap: _gone ? session.dropJoin : _load),
          ),
        ] else
          Padding(padding: const EdgeInsets.symmetric(vertical: 10), child: LoadingDots(color: muted, size: 5)),
      ]),
    );
  }
}
