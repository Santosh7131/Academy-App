import 'package:flutter/material.dart';

import '../theme.dart';

/// The launcher icon's mark: a tick, the mark a marked test gets, with the same path and stroke as
/// design/icon/icon.html. [draw] runs from 0 (not drawn yet) to 1 (done), so the opening can draw it in the
/// way a pen marks a paper. By default it keeps the icon's square 108-unit canvas and its margin; [tight]
/// draws the tick edge to edge in a box [size] wide (and about three quarters as tall), so it lines up with
/// text beside or under it.
class BrandMark extends StatelessWidget {
  const BrandMark({super.key, this.size = 40, this.draw = 1, this.color, this.tight = false});
  final double size;
  final double draw;
  final Color? color;
  final bool tight;

  // The tick's bounds on the 108-unit canvas, its round ends and corner included.
  static const _left = 28.95, _top = 34.65, _width = 50.1, _height = 38.6;

  @override
  Widget build(BuildContext context) => SizedBox(
        width: size,
        height: tight ? size * _height / _width : size,
        child: CustomPaint(painter: _MarkPainter(draw: draw, color: color ?? ink, tight: tight)),
      );
}

class _MarkPainter extends CustomPainter {
  _MarkPainter({required this.draw, required this.color, required this.tight});
  final double draw;
  final Color color;
  final bool tight;

  @override
  void paint(Canvas canvas, Size size) {
    if (draw <= 0) return;
    final unit = size.width / (tight ? BrandMark._width : 108);
    if (tight) canvas.translate(-BrandMark._left * unit, -BrandMark._top * unit);
    // The short stroke down to the corner, then the long one up, as a pen draws it.
    final tick = Path()
      ..moveTo(34.2 * unit, 54.3 * unit)
      ..lineTo(48 * unit, 68 * unit)
      ..lineTo(73.8 * unit, 39.9 * unit);
    final stroke = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 10.5 * unit
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    if (draw >= 1) {
      canvas.drawPath(tick, stroke);
      return;
    }
    final metric = tick.computeMetrics().first;
    canvas.drawPath(metric.extractPath(0, metric.length * draw), stroke);
  }

  @override
  bool shouldRepaint(_MarkPainter old) => old.draw != draw || old.color != color || old.tight != tight;
}
