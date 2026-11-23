import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/google.dart';
import '../../core/session.dart';
import '../../theme.dart';
import '../../ui/kit.dart';

/// Signs in with Google. A Google account that has no login yet makes one: of [role] when the screen knows it (a sign-up
/// screen), else the person is asked whether they are a student or a tutor. Returns a message to show when it did not work,
/// or null (signed in, or Google's sheet was closed). The router moves on by itself once signed in.
Future<String?> continueWithGoogle(BuildContext context, {String? role}) async {
  try {
    final token = await GoogleAuth.idToken();
    if (token == null) return null;
    try {
      await session.signInWithGoogle(token, role: role);
    } on ApiException catch (e) {
      if (e.code != 'no_account' || !context.mounted) rethrow;
      final chosen = await askStudentOrTutor(context);
      if (chosen == null) return null;
      await session.signInWithGoogle(token, role: chosen);
    }
    return null;
  } on ApiException catch (e) {
    return e.message;
  }
}

/// "Are you a student or a tutor?", for a Google account with no login yet: 'student', 'teacher', or null for neither.
Future<String?> askStudentOrTutor(BuildContext context) => showCentredCard<String>(
      context,
      title: 'New here?',
      subtitle: 'This Google account has no login yet. Are you a student or a tutor?',
      builder: (ctx) => Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        PrimaryButton('I am a student', onTap: () => Navigator.of(ctx).pop('student')),
        const SizedBox(height: 10),
        SecondaryButton('I am a tutor', onTap: () => Navigator.of(ctx).pop('teacher')),
      ]),
    );

/// The "Continue with Google" button, in the style of the app's other plain buttons, with Google's "G".
class GoogleButton extends StatelessWidget {
  const GoogleButton({super.key, required this.onTap, this.busy = false, this.label = 'Continue with Google'});
  final VoidCallback onTap;
  final bool busy;
  final String label;

  @override
  Widget build(BuildContext context) => Pressable(
        onTap: busy ? null : onTap,
        label: label,
        child: Container(
          height: 52,
          padding: const EdgeInsets.symmetric(horizontal: 18),
          decoration: surface(radius: rSmall, shadow: e1),
          alignment: Alignment.center,
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            const SizedBox.square(dimension: 18, child: CustomPaint(painter: _GoogleG())),
            const SizedBox(width: 10),
            Flexible(child: Fig(label, style: buttonStyle.copyWith(color: ink), maxLines: 1)),
            if (busy) ...[const SizedBox(width: 10), LoadingDots(color: ink, size: 4.5)],
          ]),
        ),
      );
}

/// Google's "G", drawn: four coloured quarter-ish arcs and the blue bar, the way sign-in buttons show it.
class _GoogleG extends CustomPainter {
  const _GoogleG();

  @override
  void paint(Canvas canvas, Size size) {
    final s = size.shortestSide;
    final w = s * 0.22;
    final box = Rect.fromLTWH(w / 2, w / 2, s - w, s - w);
    Paint ring(int argb) => Paint()
      ..color = Color(argb)
      ..style = PaintingStyle.stroke
      ..strokeWidth = w;
    double deg(double d) => d * math.pi / 180;
    canvas.drawArc(box, deg(-150), deg(110), false, ring(0xFFEA4335)); // red, the top
    canvas.drawArc(box, deg(150), deg(60), false, ring(0xFFFBBC05)); // yellow, the left
    canvas.drawArc(box, deg(40), deg(110), false, ring(0xFF34A853)); // green, the bottom
    canvas.drawArc(box, deg(0), deg(40), false, ring(0xFF4285F4)); // blue, the right
    canvas.drawRect(Rect.fromLTWH(s / 2, s / 2 - w / 2, s / 2, w), Paint()..color = const Color(0xFF4285F4));
  }

  @override
  bool shouldRepaint(_GoogleG old) => false;
}
