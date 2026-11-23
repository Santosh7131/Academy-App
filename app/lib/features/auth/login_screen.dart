import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/google.dart';
import '../../core/session.dart';
import '../../theme.dart';
import '../../ui/brand_mark.dart';
import '../../ui/kit.dart';
import '../student/join_invite.dart';
import 'google_flow.dart';

/// One login for everyone, students and tutors alike: a username and password, or Google when the server has it on. New
/// people make their own account from here. A join link that opened the app shows what it is for at the top.
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _user = TextEditingController();
  final _secret = TextEditingController();
  bool _busy = false;
  bool _googleBusy = false;
  bool _google = false;
  bool _show = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    // A join link can arrive while this screen is open.
    session.addListener(_onSession);
    GoogleAuth.clientId().then((id) {
      if (mounted && id != null) setState(() => _google = true);
    });
  }

  @override
  void dispose() {
    session.removeListener(_onSession);
    _user.dispose();
    _secret.dispose();
    super.dispose();
  }

  void _onSession() {
    if (mounted) setState(() {});
  }

  Future<void> _submit() async {
    if (_busy || _googleBusy) return;
    FocusScope.of(context).unfocus();
    final name = _user.text.trim();
    final secret = _secret.text;
    final problem = name.isEmpty ? 'Type your username.' : (secret.isEmpty ? 'Type your password.' : null);
    if (problem != null) {
      setState(() => _error = problem);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await session.login(name, secret);
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _error = e.message;
          // A login the server refused starts the password again; one that never reached it keeps it, so trying again is one tap.
          if (!e.offline) _secret.clear();
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _withGoogle() async {
    if (_busy || _googleBusy) return;
    FocusScope.of(context).unfocus();
    setState(() {
      _googleBusy = true;
      _error = null;
    });
    final problem = await continueWithGoogle(context);
    if (mounted) {
      setState(() {
        _googleBusy = false;
        _error = problem;
      });
    }
  }

  void _clearError() {
    if (_error != null) setState(() => _error = null);
  }

  @override
  Widget build(BuildContext context) {
    final invite = session.pendingJoin;
    return Scaffold(
      body: SafeArea(
        child: AutofillGroup(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(gutter, 28, gutter, 24),
            keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
            children: staggered([
              // The tick edge to edge, so it lines up with the heading under it.
              SizedBox(
                height: 46,
                child: Row(children: [
                  const BrandMark(size: 22, tight: true),
                  const SizedBox(width: 14),
                  Expanded(child: Kicker(session.tuitionName)),
                ]),
              ),
              const SizedBox(height: 30),
              Text(invite == null ? 'Welcome back' : 'You are invited', style: displayStyle),
              const SizedBox(height: 26),
              if (invite != null) ...[
                JoinInviteCard(
                  code: invite,
                  footer: (_) => Fig('Log in, or make a student account below, then ask to join.', style: labelStyle),
                ),
                const SizedBox(height: 18),
              ],
              GroupedInputs(children: [
                BareField(
                  controller: _user,
                  placeholder: 'Username',
                  keyboard: TextInputType.visiblePassword,
                  action: TextInputAction.next,
                  autofillHints: const [AutofillHints.username],
                  onChanged: (_) => _clearError(),
                ),
                BareField(
                  controller: _secret,
                  placeholder: 'Password',
                  obscure: !_show,
                  keyboard: TextInputType.visiblePassword,
                  action: TextInputAction.done,
                  autofillHints: const [AutofillHints.password],
                  onSubmitted: (_) => _submit(),
                  onChanged: (_) => _clearError(),
                  suffix: Pressable(
                    label: _show ? 'Hide' : 'Show',
                    onTap: () => setState(() => _show = !_show),
                    child: Padding(padding: const EdgeInsets.all(6), child: Icon(_show ? Ph.eyeSlash : Ph.eye, size: 20, color: muted)),
                  ),
                ),
              ]),
              AnimatedSize( // motion: approved
                duration: const Duration(milliseconds: 200),
                curve: Curves.easeOutCubic,
                alignment: Alignment.topCenter,
                child: _error == null
                    ? const SizedBox(width: double.infinity, height: 16)
                    : Padding(padding: const EdgeInsets.only(top: 14, bottom: 14), child: InlineNotice(_error!, tone: Tone.danger, icon: Ph.warning)),
              ),
              PrimaryButton('Log in', busy: _busy, onTap: _submit),
              if (_google) ...[
                const SizedBox(height: 12),
                GoogleButton(busy: _googleBusy, onTap: _withGoogle),
              ],
              const SizedBox(height: 22),
              Center(child: TextAction('New student? Make your account', color: ink, onTap: () => context.push('/signup/student'))),
              Center(child: TextAction('New tutor? Create your tuition', onTap: () => context.push('/signup'))),
            ], prefix: 'login', stepMs: 70),
          ),
        ),
      ),
    );
  }
}
