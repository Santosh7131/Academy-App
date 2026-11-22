// Finding a figure on a page by edge detection (lib/features/teacher/figure_finder.dart), on made-up grey pages: a drawing with its
// labels between a question line and its options, pages of text alone, the uneven light and grain of a photo, the border of a
// photographed sheet, a table with an option right under it, a label at the end of a leader line, and AI's box pointing at a figure
// loosely, with x and y swapped, or at nothing.
//   flutter test test/figure_finder_test.dart
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:tuition_app/features/teacher/figure_finder.dart';
import 'package:flutter_test/flutter_test.dart';

/// A white page, 800 by 1130 (an A4 page at the width figures are looked for at), to draw on in black.
class _Page {
  _Page() : px = Uint8List(_w * _h)..fillRange(0, _w * _h, 255);

  static const _w = 800, _h = 1130;
  int get w => _w;
  int get h => _h;
  final Uint8List px;

  void dot(int x, int y, [int grey = 0]) {
    if (x >= 0 && y >= 0 && x < w && y < h) px[y * w + x] = grey;
  }

  void fill(int x0, int y0, int x1, int y1, [int grey = 0]) {
    for (var y = y0; y < y1; y++) {
      for (var x = x0; x < x1; x++) {
        dot(x, y, grey);
      }
    }
  }

  /// A straight stroke [t] pixels thick.
  void line(int x0, int y0, int x1, int y1, {int t = 2}) {
    final n = math.max((x1 - x0).abs(), (y1 - y0).abs());
    for (var i = 0; i <= n; i++) {
      final x = (x0 + (x1 - x0) * i / math.max(1, n)).round(), y = (y0 + (y1 - y0) * i / math.max(1, n)).round();
      fill(x, y, x + t, y + t);
    }
  }

  void ring(int cx, int cy, int r, {int t = 3}) {
    for (var y = cy - r - t; y <= cy + r + t; y++) {
      for (var x = cx - r - t; x <= cx + r + t; x++) {
        final d = math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
        if (d >= r && d < r + t) dot(x, y);
      }
    }
  }

  void outline(int x0, int y0, int x1, int y1, {int t = 2}) {
    fill(x0, y0, x1, y0 + t);
    fill(x0, y1 - t, x1, y1);
    fill(x0, y0, x0 + t, y1);
    fill(x1 - t, y0, x1, y1);
  }

  /// A word of [letters] letters, 7 by 10 pixels with 3 between them, starting at [x]; returns where the word ends.
  int word(int x, int y, int letters) {
    for (var i = 0; i < letters; i++) {
      fill(x + i * 10, y, x + i * 10 + 7, y + 10);
    }
    return x + letters * 10;
  }

  /// A line of text from [x0] to about [x1]: words of four or five letters with 8 pixels between them.
  void text(int x0, int y, int x1) {
    var x = x0, k = 0;
    while (x < x1) {
      x = word(x, y, 4 + k++ % 2) + 8;
    }
  }

  GreyPage get grey => GreyPage(w, h, px);
}

/// [box] (fractions of a page [w] by [h]) in pixels, rounded.
List<int> _px(FigureBox box, [int w = 800, int h = 1130]) => [(box[0] * w).round(), (box[1] * h).round(), (box[2] * w).round(), (box[3] * h).round()];

/// A drawing between a question line (y 200) and its options (y 393): a circle with a label above it, one to its right and one inside.
_Page _questionWithFigure() {
  final p = _Page()..text(80, 200, 700);
  p.ring(400, 300, 70);
  p.word(396, 217, 1); // "A", 4 pixels above the circle
  p.word(478, 296, 1); // "B", right of it
  p.word(392, 296, 1); // "O", inside
  p.text(80, 393, 520); // the options, 20 pixels under the circle
  return p;
}

void main() {
  group('findFigures', () {
    test('a drawing between a question line and its options is found with its labels, and nothing else', () {
      final figs = findFigures(_questionWithFigure().grey);
      expect(figs, hasLength(1));
      final b = _px(figs.single);
      // The circle's ink runs from 327 to 473 across and 227 to 373 down; label A starts at 217, label B ends at 485.
      expect(b[0], inInclusiveRange(315, 327), reason: 'the whole circle, with a little room');
      expect(b[2], inInclusiveRange(485, 497), reason: 'past the label to its right');
      expect(b[1], lessThanOrEqualTo(217), reason: 'the label above the circle is in');
      expect(b[1], greaterThan(210), reason: 'the question line above it is not, not even a sliver');
      expect(b[3], greaterThanOrEqualTo(373), reason: 'the bottom of the circle');
      expect(b[3], lessThan(393), reason: 'the options under it are not');
    });

    test('a page of text alone has no figures', () {
      final p = _Page();
      for (var y = 80; y < 1080; y += 24) {
        p.text(80, y, 720);
      }
      expect(findFigures(p.grey), isEmpty);
    });

    test('a blank page has no figures', () {
      expect(findFigures(_Page().grey), isEmpty);
    });

    test('the uneven light and grain of a photo make no figures, and the drawing on it is still found', () {
      final p = _questionWithFigure();
      final rnd = math.Random(7);
      for (var y = 0; y < p.h; y++) {
        for (var x = 0; x < p.w; x++) {
          final i = y * p.w + x;
          // Light falling from the top left: the paper goes from bright to a dull grey, and the ink with it; plus grain.
          final light = 1 - 0.25 * (x / p.w + y / p.h) / 2;
          p.px[i] = (p.px[i] * light + rnd.nextInt(13) - 6).round().clamp(0, 255);
        }
      }
      final figs = findFigures(p.grey);
      expect(figs, hasLength(1));
      final b = _px(figs.single);
      expect(b[1], allOf(greaterThan(210), lessThanOrEqualTo(217)), reason: 'label A in, the question line out');
      expect(b[3], allOf(greaterThanOrEqualTo(373), lessThan(393)), reason: 'the circle in, the options out');
    });

    test('the room left round a figure stops short of a line printed close to it', () {
      final figs = findFigures(_questionWithFigure().grey);
      final b = _px(figs.single);
      // Label A's ink starts 7 pixels under the question line's: the cut gets at most that, where the open sides get more.
      expect(b[1], greaterThan(210));
      expect(327 - b[0], greaterThan(217 - b[1]), reason: 'more room on the open left side than towards the line above');
    });

    test('the border of a photographed sheet is not a figure', () {
      final p = _Page();
      // The table the sheet lies on shows round it.
      p
        ..fill(0, 0, 800, 30, 60)
        ..fill(0, 1100, 800, 1130, 60)
        ..fill(0, 0, 25, 1130, 60)
        ..fill(775, 0, 800, 1130, 60);
      for (var y = 80; y < 1060; y += 24) {
        p.text(80, y, 700);
      }
      expect(findFigures(p.grey), isEmpty);
    });

    test('a table is found without the option printed right under it', () {
      final p = _Page()..text(60, 600, 700);
      // Two rows of five cells, 300 by 50 pixels.
      p.outline(80, 630, 380, 680);
      p.line(80, 654, 380, 654);
      for (var x = 140; x < 380; x += 60) {
        p.line(x, 630, x, 680);
      }
      p.word(60, 688, 3); // "(a) P", 8 pixels under the table, starting left of it
      p.word(60, 712, 3);
      final figs = findFigures(p.grey);
      expect(figs, hasLength(1));
      final b = _px(figs.single);
      expect(b[3], lessThan(688), reason: 'the option under the table is not part of it');
      expect(b[0], inInclusiveRange(75, 80));
    });

    test('a label at the end of a leader line belongs to the figure', () {
      final p = _Page()..ring(300, 400, 60);
      p.line(362, 400, 470, 400); // the leader line, out of the circle
      p.word(476, 395, 4); // its label, "Core"
      final figs = findFigures(p.grey);
      expect(figs, hasLength(1));
      expect(_px(figs.single)[2], greaterThanOrEqualTo(512), reason: 'the label at the end of the line is in');
    });

    test('two drawings far apart are two figures, top to bottom', () {
      final p = _Page()
        ..ring(400, 800, 60)
        ..ring(400, 300, 60);
      final figs = findFigures(p.grey);
      expect(figs, hasLength(2));
      expect(figs[0][1], lessThan(figs[1][1]));
    });
  });

  group('greyPage', () {
    test('a picture wider than the look width is shrunk, each grey pixel the average of those it covers', () {
      // 1600 by 4, columns alternating black and white: shrunk to 800 wide, every pixel is half grey.
      final rgba = Uint8List(1600 * 4 * 4);
      for (var y = 0; y < 4; y++) {
        for (var x = 0; x < 1600; x++) {
          final v = x.isEven ? 0 : 255;
          final i = (y * 1600 + x) * 4;
          rgba
            ..[i] = v
            ..[i + 1] = v
            ..[i + 2] = v
            ..[i + 3] = 255;
        }
      }
      final g = greyPage(rgba, 1600, 4);
      expect(g.w, 800);
      expect(g.h, 2);
      expect(g.px.toSet(), {128});
    });

    test('colours become the grey a photo of them would have', () {
      final rgba = Uint8List.fromList([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
      final g = greyPage(rgba, 3, 1);
      expect(g.px, [76, 150, 29]);
    });
  });

  group('pickFigure', () {
    const circle = [0.40, 0.20, 0.60, 0.33];
    const graph = [0.10, 0.60, 0.50, 0.75];

    test('a loose box that takes in the options too picks the figure in it', () {
      expect(pickFigure([circle, graph], const [0.35, 0.18, 0.65, 0.40])?.box, circle);
    });

    test('a box cut short picks the figure it cuts', () {
      expect(pickFigure([circle, graph], const [0.45, 0.25, 0.55, 0.30])?.box, circle);
    });

    test('a box written with x and y swapped picks the figure it was meant for', () {
      final p = pickFigure([circle, graph], const [0.20, 0.40, 0.33, 0.60]);
      expect(p?.box, circle);
      expect(p?.swapped, isTrue);
    });

    test('a box that fits as it is wins over its swapped reading', () {
      // Two figures that are each other swapped: the box fits the first as it is, and the second only when read swapped.
      const first = [0.2, 0.3, 0.4, 0.5], second = [0.3, 0.2, 0.5, 0.4];
      final p = pickFigure([second, first], first);
      expect(p?.box, first);
      expect(p?.swapped, isFalse);
    });

    test('a box over blank paper picks nothing', () {
      expect(pickFigure([circle, graph], const [0.70, 0.85, 0.95, 0.95]), isNull);
    });

    test('a box over two figures picks the one it covers more of', () {
      final top = [0.1, 0.10, 0.5, 0.20], bottom = [0.1, 0.22, 0.5, 0.32];
      expect(pickFigure([top, bottom], const [0.1, 0.12, 0.5, 0.25])?.box, top);
    });

    test('no figures on the page, nothing to pick', () {
      expect(pickFigure(const [], const [0.1, 0.1, 0.5, 0.5]), isNull);
    });
  });

  // The cut for AI's box on a whole page: what the paper screen attaches.
  group('pickFigure on a page', () {
    ({FigureBox box, bool swapped, bool inPhoto})? cutFor(_Page p, List<int> hint) {
      final look = lookAt(p.grey);
      return pickFigure(look.figures, [hint[0] / 800, hint[1] / 1130, hint[2] / 800, hint[3] / 1130],
          fills: look.fills, marks: look.marks, aspect: look.aspect);
    }

    test('a figure drawn in parts side by side keeps every part within AI\'s box, and only those', () {
      // Two stages of a process, 194 pixels apart: two figures to the finder.
      final p = _Page()
        ..ring(250, 400, 50)
        ..ring(550, 400, 50);
      expect(findFigures(p.grey), hasLength(2));
      final both = _px(cutFor(p, [190, 330, 620, 470])!.box);
      expect(both[0], lessThanOrEqualTo(197), reason: 'the left stage is in');
      expect(both[2], greaterThanOrEqualTo(603), reason: 'and the right one');
      final one = _px(cutFor(p, [190, 330, 330, 470])!.box);
      expect(one[2], lessThan(400), reason: 'a box round the left stage alone does not take in the right one');
    });

    test('a mark set a little apart from a drawing is cut with it when AI\'s box takes it in', () {
      // A wire, and under it the triangle the question asks about: 16 pixels away, too far to be a label of the wire.
      final p = _Page()..outline(200, 300, 600, 360, t: 3);
      p.fill(394, 376, 408, 388);
      final with_ = _px(cutFor(p, [190, 290, 610, 400])!.box);
      expect(with_[3], greaterThanOrEqualTo(388), reason: 'the triangle is in the cut');
      final without = _px(cutFor(p, [190, 290, 610, 365])!.box);
      expect(without[3], lessThan(376), reason: 'a box that stops at the wire leaves it out');
    });

    test('a big block that mostly lies outside AI\'s box is passed over, so AI\'s box is cut instead', () {
      // A frame a sixth of the page in size, with a small circle in it: the shadow of a photographed sheet behaves like this.
      final p = _Page()
        ..outline(150, 300, 650, 600)
        ..ring(300, 400, 30);
      expect(cutFor(p, [250, 350, 350, 450]), isNull);
      expect(_px(cutFor(p, [140, 290, 660, 610])!.box)[2], greaterThanOrEqualTo(650), reason: 'a box that covers it picks it');
    });

    test('a photo pasted on the page is cut at AI\'s box within it, not as one block', () {
      // A grey photo with a line of the book's text at its top and a drawing under it.
      final p = _Page()..fill(200, 300, 600, 550, 150);
      p.text(220, 312, 560);
      p.ring(400, 450, 50);
      final look = lookAt(p.grey);
      expect(look.figures, hasLength(1), reason: 'the photo is one block to edge detection');
      expect(look.fills.single, greaterThan(photoFill));
      final cut = cutFor(p, [340, 390, 460, 510])!;
      expect(cut.inPhoto, isTrue);
      final b = _px(cut.box);
      expect(b[1], greaterThan(330), reason: 'the book\'s text above the drawing is left out');
      expect(b[0], greaterThan(300));
      expect(b[2], lessThan(500));
      final whole = cutFor(p, [195, 295, 605, 555])!;
      expect(whole.inPhoto, isFalse, reason: 'AI\'s box round the whole photo takes the whole photo');
    });

    test('a drawing is mostly paper, so it is never taken for a photo', () {
      final look = lookAt(_questionWithFigure().grey);
      expect(look.fills.single, lessThan(0.3));
    });
  });
}
