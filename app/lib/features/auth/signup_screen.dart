import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/google.dart';
import '../../core/session.dart';
import '../../theme.dart';
import '../../ui/kit.dart';
import 'google_flow.dart';

/// A new tutor makes their own login. The tuition itself is set up next (SetupScreen): the router sends a signed-in tutor with
/// no tuition there.
class TutorSignUpScreen extends StatelessWidget {
  const TutorSignUpScreen({super.key});

  @override
  Widget build(BuildContext context) => const _SignUp(role: 'teacher');
}

/// A new student makes their own login, then asks to join with the link, QR code or code their tutor shares: the router sends
/// a signed-in student with no tuition to the join screen.
class StudentSignUpScreen extends StatelessWidget {
  const StudentSignUpScreen({super.key});

  @override
  Widget build(BuildContext context) => const _SignUp(role: 'student');
}

class _SignUp extends StatefulWidget {
  const _SignUp({required this.role});

  /// 'teacher' or 'student'.
  final String role;

  @override
  State<_SignUp> createState() => _SignUpState();
}

class _SignUpState extends State<_SignUp> {
  final _name = TextEditingController();
  final _user = TextEditingController();
  final _pass = TextEditingController();
  bool _busy = false;
  bool _googleBusy = false;
  bool _google = false;
  bool _show = false;
  String? _error;

  bool get _student => widget.role == 'student';

  @override
  void initState() {
    super.initState();
    GoogleAuth.clientId().then((id) {
      if (mounted && id != null) setState(() => _google = true);
    });
  }

  @override
  void dispose() {
    for (final c in [_name, _user, _pass]) {
      c.dispose();
    }
    super.dispose();
  }

  String? _check() {
    if (_name.text.trim().isEmpty) return 'Type your name.';
    if (!RegExp(r'^[a-z0-9._]{3,24}$').hasMatch(_user.text.trim().toLowerCase())) {
      return 'The username uses 3 to 24 lowercase letters, numbers, dots or underscores.';
    }
    if (_pass.text.length < 8) return 'The password needs 8 or more characters.';
    return null;
  }

  Future<void> _submit() async {
    if (_busy || _googleBusy) return;
    FocusScope.of(context).unfocus();
    final problem = _check();
    if (problem != null) {
      setState(() => _error = problem);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      if (_student) {
        await session.signUpStudent(name: _name.text, username: _user.text, password: _pass.text);
      } else {
        await session.signUpTutor(name: _name.text, username: _user.text, password: _pass.text);
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
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
    final problem = await continueWithGoogle(context, role: widget.role);
    if (mounted) {
      setState(() {
        _googleBusy = false;
        _error = problem;
      });
    }
  }

  @override
  Widget build(BuildContext context) => PushedPanel(
        // Opened straight from the website's Start free, there is no login under it to go back to: Back opens the login.
        onBack: Navigator.of(context).canPop() ? null : () => context.go('/login'),
        kicker: _student ? 'New student' : 'New tutor',
        title: 'Make your account',
        children: [
          const SizedBox(height: 14),
          Fig(
            _student
                ? 'Then ask to join with the link, QR code or code your tutor shares.'
                : 'Then you set up your tuition: its name, classes and subjects.',
            style: bodyStyle.copyWith(color: muted),
          ),
          const SizedBox(height: 20),
          GroupedInputs(children: [
            BareField(controller: _name, placeholder: 'Your name', maxLength: 60, capitalization: TextCapitalization.words, action: TextInputAction.next),
            BareField(
              controller: _user,
              placeholder: 'Username, in lowercase letters',
              maxLength: 24,
              keyboard: TextInputType.visiblePassword,
              action: TextInputAction.next,
              autofillHints: const [AutofillHints.newUsername],
            ),
            BareField(
              controller: _pass,
              placeholder: 'Password, 8 or more characters',
              obscure: !_show,
              keyboard: TextInputType.visiblePassword,
              action: TextInputAction.done,
              autofillHints: const [AutofillHints.newPassword],
              onSubmitted: (_) => _submit(),
              suffix: Pressable(
                label: _show ? 'Hide password' : 'Show password',
                onTap: () => setState(() => _show = !_show),
                child: Padding(padding: const EdgeInsets.all(6), child: Icon(_show ? Ph.eyeSlash : Ph.eye, size: 20, color: muted)),
              ),
            ),
          ]),
          AnimatedSize( // motion: approved
            duration: const Duration(milliseconds: 200),
            curve: Curves.easeOutCubic,
            alignment: Alignment.topCenter,
            child: _error == null ? const SizedBox(width: double.infinity) : Padding(padding: const EdgeInsets.only(top: 14), child: InlineNotice(_error!, tone: Tone.danger, icon: Ph.warning)),
          ),
          const SizedBox(height: 20),
          PrimaryButton('Make account', busy: _busy, onTap: _submit),
          if (_google) ...[
            const SizedBox(height: 12),
            GoogleButton(label: 'Use Google instead', busy: _googleBusy, onTap: _withGoogle),
          ],
        ],
      );
}
