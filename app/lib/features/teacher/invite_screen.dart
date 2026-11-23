import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/api.dart';
import '../../core/brand.dart';
import '../../core/levels.dart';
import '../../core/session.dart';
import '../../theme.dart';
import '../../ui/kit.dart';
import '../../ui/qr.dart';
import 'common.dart';

/// A group's or course's join link and its QR code. A student opens the link, or scans the code with their phone's camera,
/// makes an account if they have none, and asks to join; they wait on Home's list until a tutor lets them in. A new link
/// stops the old link and code from working.
class InviteScreen extends StatefulWidget {
  const InviteScreen({super.key, this.classLevel, this.subjectId, this.courseId, required this.name});

  /// A group's class and subject, with [name] the subject's name; or a course's [courseId], with [name] the course's.
  final int? classLevel;
  final String? subjectId;
  final String? courseId;
  final String name;

  @override
  State<InviteScreen> createState() => _InviteScreenState();
}

class _InviteScreenState extends State<InviteScreen> {
  Map<String, dynamic>? _link;
  String? _error;
  String? _notice;
  bool _sharing = false;
  bool _renewing = false;

  String get _path => widget.courseId != null ? '/teacher/courses/${widget.courseId}/link' : '/teacher/groups/${widget.classLevel}/${widget.subjectId}/link';

  String get _label => widget.courseId != null ? widget.name : groupName(widget.classLevel ?? 0, widget.name, tuition: session.activeTuition);

  String get _url => '${_link?['url'] ?? ''}';
  String get _code => '${_link?['code_shown'] ?? ''}';

  String get _message => 'Join $_label at ${session.tuitionName} on $appName.\n'
      'Open this link on your phone: $_url\n'
      'Or open the app and type the code $_code.';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await api.get(_path);
      if (mounted) {
        setState(() {
          _link = Map<String, dynamic>.from(r['link'] as Map);
          _error = null;
        });
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _renew() async {
    final ok = await confirmCard(
      context,
      title: 'Make a new link?',
      body: 'The old link and QR code stop working at once. Students who already asked stay on your list.',
      confirm: 'Make a new link',
      destructive: true,
    );
    if (!ok || !mounted) return;
    setState(() => _renewing = true);
    try {
      final r = await api.post('$_path/new');
      if (mounted) {
        setState(() {
          _link = Map<String, dynamic>.from(r['link'] as Map);
          _notice = 'New link made. The old link and QR code no longer work.';
        });
      }
    } on ApiException catch (e) {
      if (mounted) await showProblem(context, e);
    } finally {
      if (mounted) setState(() => _renewing = false);
    }
  }

  void _copy() {
    Clipboard.setData(ClipboardData(text: _url));
    setState(() => _notice = 'Link copied. Paste it into a message.');
  }

  Future<void> _shareQr() async {
    setState(() => _sharing = true);
    try {
      final bytes = await qrPicture(data: _url, title: _label, subtitle: session.tuitionName, code: _code);
      final dir = await getTemporaryDirectory();
      final file = File('${dir.path}/join-${_code.replaceAll('-', '')}.png');
      await file.writeAsBytes(bytes, flush: true);
      await SharePlus.instance.share(ShareParams(files: [XFile(file.path, mimeType: 'image/png')], text: _message));
    } catch (e) {
      if (mounted) await showProblem(context, e);
    } finally {
      if (mounted) setState(() => _sharing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final link = _link;
    return PushedPanel(
      kicker: session.tuitionName,
      title: 'Invite students',
      children: [
        const SizedBox(height: 14),
        Fig(
          'Students scan this with their phone camera, or open the link, and ask to join $_label. You let them in from Home.',
          style: bodyStyle.copyWith(color: muted),
        ),
        const SizedBox(height: 20),
        if (link == null && _error != null)
          ErrorState(message: _error!, onRetry: _load)
        else if (link == null)
          const LoadingState(rows: 3)
        else ...[
          Surface(
            shadow: e1,
            padding: const EdgeInsets.fromLTRB(20, 22, 20, 20),
            child: Column(children: [
              QrBox(data: _url, size: 232, label: 'QR code to join $_label'),
              const SizedBox(height: 16),
              Fig(_label, style: rowTitleStyle, textAlign: TextAlign.center),
              const SizedBox(height: 4),
              Fig('Code $_code', style: numStyle(size: 22, weight: FontWeight.w600).copyWith(letterSpacing: 2), textAlign: TextAlign.center),
            ]),
          ),
          const SizedBox(height: 16),
          Row(children: [
            Expanded(child: SecondaryButton('Copy link', icon: Ph.copy, onTap: _copy)),
            const SizedBox(width: 10),
            Expanded(child: PrimaryButton('Share link', icon: Ph.shareNetwork, onTap: () => SharePlus.instance.share(ShareParams(text: _message)))),
          ]),
          const SizedBox(height: 10),
          SecondaryButton(_sharing ? 'Making the picture…' : 'Share the QR code as a picture', icon: Ph.image, onTap: _sharing ? null : _shareQr),
          if (_notice != null) ...[const SizedBox(height: 14), InlineNotice(_notice!, tone: Tone.success, icon: Ph.checkCircle)],
          const SizedBox(height: 24),
          Center(child: TextAction(_renewing ? 'Making a new link…' : 'Make a new link', color: danger, onTap: _renewing ? null : _renew)),
          Fig('Do this if the link reached someone it should not have.', style: labelStyle, textAlign: TextAlign.center),
        ],
      ],
    );
  }
}
