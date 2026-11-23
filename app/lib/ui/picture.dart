import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/rendering.dart';

/// What a boundary has drawn, as a PNG: [pixelRatio] pixels to each of its points. A report for parents is shared this way
/// (parent_report.dart), and the screenshot tests save their pictures with it.
Future<Uint8List> pngOf(RenderRepaintBoundary boundary, {double pixelRatio = 3}) async {
  final image = await boundary.toImage(pixelRatio: pixelRatio);
  final data = await image.toByteData(format: ui.ImageByteFormat.png);
  image.dispose();
  return data!.buffer.asUint8List();
}
