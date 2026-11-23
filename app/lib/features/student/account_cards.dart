import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/google.dart';
import '../../core/session.dart';
import '../../theme.dart';
import '../../ui/kit.dart';
import '../teacher/common.dart' show showProblem;

/// Asks for the current password and a new one, and changes it. Every other phone the student is logged in on is signed out.
Future<void> changePasswordCard(BuildContext context) async {
  final done = await showCentredCard<bool>(
    context,
    title: 'Change password',
    subtitle: 'Your other phones are logged out.',
    builder: (_) => const _ChangePassword(),
  );
  if (done == true && context.mounted) {
    await showCentredCard<void>(
      context,
      title: 'Password changed',
      subtitle: 'Use the new one next time you log in.',
      builder: (ctx) => PrimaryButton('OK', onTap: () => Navigator.of(ctx).pop()),
    );
  }
}

class _ChangePassword extends StatefulWidget {
  const _ChangePassword();

  @override
  State<_ChangePassword> createState() => _ChangePasswordState();
}

class _ChangePasswordState extends State<_ChangePassword> {
  final _current = TextEditingController();
  final _next = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _current.dispose();
    _next.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_busy) return;
    final problem = _current.text.isEmpty
        ? 'Type your current password.'
        : _next.text.length < 8
            ? 'The new password needs 8 or more characters.'
            : null;
    if (problem != null) {
      setState(() => _error = problem);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await session.changePassword(_current.text, _next.text);
      if (mounted) Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        GroupedInputs(children: [
          BareField(controller: _current, placeholder: 'Current password', obscure: true, keyboard: TextInputType.visiblePassword, action: TextInputAction.next),
          BareField(
            controller: _next,
            placeholder: 'New password, 8 or more characters',
            obscure: true,
            keyboard: TextInputType.visiblePassword,
            action: TextInputAction.done,
            autofillHints: const [AutofillHints.newPassword],
            onSubmitted: (_) => _save(),
          ),
        ]),
        if (_error != null) ...[const SizedBox(height: 12), InlineNotice(_error!, tone: Tone.danger, icon: Ph.warning)],
        const SizedBox(height: 16),
        PrimaryButton('Change password', busy: _busy, onTap: _save),
      ]);
}

/// Deletes the student's account for good, after they say yes: with their password, or by choosing their Google account again
/// for a login made with Google. The app then shows the login screen.
Future<void> deleteAccountFlow(BuildContext context) async {
  final ok = await confirmCard(
    context,
    title: 'Delete your account?',
    body: 'Your login, your places in your tuitions and all your results go for good. This cannot be undone.',
    confirm: 'Continue',
    destructive: true,
  );
  if (!ok || !context.mounted) return;
  if (session.signedInWithGoogle) {
    try {
      final token = await GoogleAuth.idToken();
      if (token != null) await session.deleteAccount(idToken: token);
    } on ApiException catch (e) {
      if (context.mounted) await showProblem(context, e);
    }
    return;
  }
  await showCentredCard<void>(
    context,
    title: 'Type your password',
    subtitle: 'To delete your account for good.',
    builder: (_) => const _DeleteWithPassword(),
  );
}

class _DeleteWithPassword extends StatefulWidget {
  const _DeleteWithPassword();

  @override
  State<_DeleteWithPassword> createState() => _DeleteWithPasswordState();
}

class _DeleteWithPasswordState extends State<_DeleteWithPassword> {
  final _secret = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _secret.dispose();
    super.dispose();
  }

  Future<void> _delete() async {
    if (_busy) return;
    if (_secret.text.isEmpty) {
      setState(() => _error = 'Type your password.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final nav = Navigator.of(context);
      await session.deleteAccount(secret: _secret.text);
      // Signed out now: the router shows the login screen under this card.
      if (mounted) nav.maybePop();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        GroupedInputs(children: [
          BareField(
            controller: _secret,
            placeholder: 'Password',
            obscure: true,
            keyboard: TextInputType.visiblePassword,
            action: TextInputAction.done,
            onSubmitted: (_) => _delete(),
          ),
        ]),
        if (_error != null) ...[const SizedBox(height: 12), InlineNotice(_error!, tone: Tone.danger, icon: Ph.warning)],
        const SizedBox(height: 16),
        SecondaryButton(_busy ? 'Deleting…' : 'Delete my account', icon: Ph.trash, tint: danger, onTap: _busy ? null : _delete),
      ]);
}
