import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/changes.dart';
import '../../core/levels.dart';
import '../../core/session.dart';
import '../../theme.dart';
import '../../ui/kit.dart';
import 'join_invite.dart';

/// A student's tuitions, and asking to join: a group's or course's link (opened from the link or its QR code, or pasted here)
/// or a tuition's code. A student in no tuition yet (the router sends them here) can only do this; a tutor lets them in, and
/// then they land on Home.
class JoinScreen extends StatefulWidget {
  const JoinScreen({super.key});

  @override
  State<JoinScreen> createState() => _JoinScreenState();
}

class _JoinScreenState extends State<JoinScreen> with WidgetsBindingObserver, AutoRefresh<JoinScreen> {
  final _code = TextEditingController();
  bool _busy = false;
  String? _error;
  String? _sent;

  /// True when the student is in no tuition yet and is waiting to be let into the first.
  late final bool _waiting = session.needsTuition;

  @override
  Set<Area> get refreshAreas => {Area.student};

  // While waiting to be let in, check now and then so the first test appears by itself.
  @override
  Duration? get pollEvery => _waiting ? const Duration(seconds: 20) : null;

  @override
  Future<void> refreshQuietly() => session.refreshTuitions();

  @override
  void initState() {
    super.initState();
    session.addListener(_onSession);
  }

  @override
  void dispose() {
    session.removeListener(_onSession);
    _code.dispose();
    super.dispose();
  }

  void _onSession() {
    if (_waiting && !session.needsTuition && mounted) context.go('/s');
  }

  /// Asks to join with [code]: what the student typed or pasted, or the link that opened the app.
  Future<void> _ask(String code, {bool fromLink = false}) async {
    FocusScope.of(context).unfocus();
    if (code.trim().isEmpty) {
      setState(() => _error = 'Paste the link, or type the code, your tutor gave you.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
      _sent = null;
    });
    try {
      final r = await session.joinTuition(code);
      final tuition = '${r['tuition']?['name'] ?? ''}';
      final asked = r['asked'] is Map ? '${r['asked']['label']}' : null;
      if (fromLink) session.dropJoin();
      if (mounted) {
        setState(() {
          _sent = asked == null
              ? 'Asked $tuition. You will see their tests here once they let you in.'
              : r['status'] == 'active'
                  ? 'Asked to join $asked. You will see it once your tutor lets you in.'
                  : 'Asked to join $asked at $tuition. You will see their tests here once they let you in.';
          _code.clear();
        });
      }
    } on ApiException catch (e) {
      // Already in it, or the link stopped working: the link has nothing more to offer.
      if (fromLink && (e.code == 'already_member' || e.code == 'unknown_link')) session.dropJoin();
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _open(Map<String, dynamic> t) {
    session.switchTuition('${t['id']}');
    context.go('/s');
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        body: SafeArea(
          child: PullToRefresh(
            onRefresh: session.refreshTuitions,
            child: ListenableBuilder(
              listenable: session,
              builder: (context, _) {
                final invite = session.pendingJoin;
                final canPop = Navigator.of(context).canPop();
                // What asking said, by the link's card when it came from there, else by the box.
                final notices = [
                  if (_error != null) ...[const SizedBox(height: 14), InlineNotice(_error!, icon: Ph.warning)],
                  if (_sent != null) ...[const SizedBox(height: 14), InlineNotice(_sent!, tone: Tone.success, icon: Ph.checkCircle)],
                ];
                return ListView(
                  padding: const EdgeInsets.fromLTRB(gutter, 8, gutter, 28),
                  physics: const AlwaysScrollableScrollPhysics(),
                  children: [
                    Row(children: [
                      if (canPop)
                        CircleBtn(icon: Ph.arrowLeft, label: 'Back', onTap: () => Navigator.of(context).maybePop())
                      // A join link can open this screen on its own: Home is one tap away.
                      else if (!session.needsTuition)
                        CircleBtn(icon: Ph.house, label: 'Home', onTap: () => context.go('/s')),
                    ]),
                    const SizedBox(height: 22),
                    Kicker(_waiting ? 'Welcome' : 'Your tuitions'),
                    const SizedBox(height: 6),
                    Text('Join a tuition', style: displayStyle),
                    if (invite != null) ...[
                      const SizedBox(height: 22),
                      JoinInviteCard(
                        code: invite,
                        footer: (link) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                          PrimaryButton(
                            'Ask to join',
                            busy: _busy,
                            onTap: link['joining_open'] == false ? null : () => _ask(invite, fromLink: true),
                          ),
                          const SizedBox(height: 4),
                          Center(child: TextAction('Not now', onTap: session.dropJoin)),
                        ]),
                      ),
                      ...notices,
                    ],
                    if (session.tuitions.isNotEmpty) ...[
                      SectionRule('Your tuitions', count: session.tuitions.length, padding: const EdgeInsets.fromLTRB(0, 26, 0, 11)),
                      for (final (i, t) in session.tuitions.indexed) ...[
                        if (i > 0) const SizedBox(height: gapRow),
                        t['status'] == 'pending'
                            ? RowTile(title: '${t['name']}', meta: 'Waiting for the tutor to let you in', trailing: const TagChip('Waiting', tone: Tone.warning))
                            : RowTile(
                                title: '${t['name']}',
                                meta: '${className(t['class_level'], tuition: t)}${t['id'] == session.tuitionId ? ' · showing now' : ''}',
                                chevron: true,
                                onTap: () => _open(t),
                              ),
                      ],
                    ],
                    SectionRule('Join with a link or code', padding: const EdgeInsets.fromLTRB(0, 26, 0, 11)),
                    GroupedInputs(children: [
                      BareField(
                        controller: _code,
                        placeholder: 'Paste a link, or type a code',
                        capitalization: TextCapitalization.characters,
                        keyboard: TextInputType.visiblePassword,
                        action: TextInputAction.done,
                        onSubmitted: (_) => _ask(_code.text),
                      ),
                    ]),
                    const SizedBox(height: 10),
                    Fig('Your tutor can share a link, a QR code to scan with your phone camera, or a code like KR7-4MQ.', style: labelStyle),
                    if (invite == null) ...notices,
                    const SizedBox(height: 18),
                    if (invite == null)
                      PrimaryButton('Ask to join', busy: _busy, onTap: () => _ask(_code.text))
                    else
                      SecondaryButton('Ask to join with this', onTap: _busy ? null : () => _ask(_code.text)),
                    if (_waiting) ...[
                      const SizedBox(height: 22),
                      Center(
                        child: TextAction('Log out', onTap: () async {
                          final ok = await confirmCard(
                            context,
                            title: 'Log out?',
                            body: session.signedInWithGoogle
                                ? 'You can log back in with Google.'
                                : 'You will need your username and password to log back in.',
                            confirm: 'Log out',
                            destructive: true,
                          );
                          if (ok) session.logout();
                        }),
                      ),
                    ],
                  ],
                );
              },
            ),
          ),
        ),
      );
}
