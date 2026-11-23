import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:qr/qr.dart';

import '../theme.dart';

/// Dark on white always, in light and dark mode alike: a phone camera reads that best.
const _qrInk = Color(0xFF0E0E11);
const _qrPaper = Color(0xFFFFFFFF);

// qr 3, not 4: the pdf package (printed tests) needs it, and it makes the same standard codes.
QrImage qrFor(String data) => QrImage(QrCode.fromData(data: data, errorCorrectLevel: QrErrorCorrectLevel.M));

/// Paints [image] into a square of [side] at [at], with the four-module quiet zone around it that the QR standard asks for.
void paintQr(Canvas canvas, QrImage image, Offset at, double side) {
  final n = image.moduleCount;
  final cell = side / (n + 8);
  final origin = at + Offset(cell * 4, cell * 4);
  canvas.drawRect(at & Size(side, side), Paint()..color = _qrPaper);
  final dark = Path();
  for (var r = 0; r < n; r++) {
    for (var c = 0; c < n; c++) {
      if (image.isDark(r, c)) dark.addRect(Rect.fromLTWH(origin.dx + c * cell, origin.dy + r * cell, cell, cell));
    }
  }
  // Without anti-aliasing, cells that touch leave no hairline between them.
  canvas.drawPath(dark, Paint()
    ..color = _qrInk
    ..isAntiAlias = false);
}

/// A QR code for [data] on a white square with rounded corners. Nothing in it moves.
class QrBox extends StatelessWidget {
  const QrBox({super.key, required this.data, this.size = 232, this.label = 'QR code'});
  final String data;
  final double size;
  final String label;

  @override
  Widget build(BuildContext context) => Semantics(
        label: label,
        image: true,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(16),
          child: SizedBox.square(dimension: size, child: CustomPaint(painter: _QrPainter(qrFor(data)))),
        ),
      );
}

class _QrPainter extends CustomPainter {
  _QrPainter(this.image);
  final QrImage image;

  @override
  void paint(Canvas canvas, Size size) => paintQr(canvas, image, Offset.zero, size.shortestSide);

  @override
  bool shouldRepaint(_QrPainter old) => old.image != image;
}

/// The QR code as a picture to share, 1080 by 1350 (a phone screen's shape): the code, what it is for, the code to type.
Future<Uint8List> qrPicture({required String data, required String title, required String subtitle, required String code}) async {
  const w = 1080.0;
  const h = 1350.0;
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder);
  canvas.drawRect(const Rect.fromLTWH(0, 0, w, h), Paint()..color = _qrPaper);
  paintQr(canvas, qrFor(data), const Offset(150, 90), 780);
  var y = 900.0;
  // Drawn outside any screen, so there is no theme to take the font from: it is named here, or the picture has the phone's own font.
  void line(String text, double size, FontWeight weight, Color color, {double after = 18, String family = fontSans, double spacing = 0}) {
    final tp = TextPainter(
      text: TextSpan(
          text: text,
          style: TextStyle(fontFamily: family, fontSize: size, fontWeight: weight, color: color, height: 1.2, letterSpacing: spacing)),
      textDirection: TextDirection.ltr,
      textAlign: TextAlign.center,
      maxLines: 2,
      ellipsis: '…',
    )..layout(maxWidth: w - 160);
    tp.paint(canvas, Offset((w - tp.width) / 2, y));
    y += tp.height + after;
  }

  line(title, 56, FontWeight.w700, _qrInk);
  line(subtitle, 38, FontWeight.w500, const Color(0xFF5B5B66), after: 34);
  line('Scan with your phone camera, or type the code', 30, FontWeight.w400, const Color(0xFF5B5B66), after: 10);
  line(code, 52, FontWeight.w700, _qrInk, family: fontMono, spacing: 4);
  final image = await recorder.endRecording().toImage(w.toInt(), h.toInt());
  final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
  image.dispose();
  return bytes!.buffer.asUint8List();
}
