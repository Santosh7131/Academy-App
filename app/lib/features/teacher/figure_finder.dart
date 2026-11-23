// Finding a figure on a page picture by edge detection.
//
// The reader (AI) says which questions need a figure and gives a box for it, but the box is a guess: often loose enough to take in
// an option line, now and then cut short, and sometimes written with x and y swapped, which lands it on a thin strip of the page.
// The figure itself is plain to see on the page: its lines are long strokes joined together, where text is rows of small letters.
// So the page is looked at once for its edges (where the grey level changes sharply), the edge pixels that touch are grouped into
// pieces, and a figure is a big piece, or a few close together, with the lines and labels right beside it. AI's box then only says
// which figure on the page is the question's, and the figure is cut along its own edges.
//
// Everything here is plain Dart on bytes, so the tests run it on made-up pages and the app runs it away from the screen's thread.
import 'dart:math' as math;
import 'dart:typed_data';

/// A box as fractions of a page: left, top, right, bottom, with 0,0 at the page's top left corner.
typedef FigureBox = List<double>;

/// The width a page is looked at: wide enough for the thinnest line of a figure, small enough to be quick on a phone.
const lookWidth = 800;

/// The most room left round a figure cut along its edges, as a fraction of the page's width, so no stroke or label touches the cut.
/// Less is left on a side where something else is printed closer, so the cut never takes in a sliver of a line of text.
const figureMargin = 0.012;

/// A page as grey levels, [w] by [h], one byte a pixel (0 is black, 255 white).
class GreyPage {
  GreyPage(this.w, this.h, this.px) : assert(px.length == w * h);
  final int w;
  final int h;
  final Uint8List px;
}

/// [rgba] (a picture [w] by [h], four bytes a pixel) as a grey page no wider than [width]. Each grey pixel is the average of the
/// pixels it covers, so a thin line fades a little but never vanishes.
GreyPage greyPage(Uint8List rgba, int w, int h, {int width = lookWidth}) {
  final f = w > width ? w / width : 1.0;
  final ow = math.max(1, (w / f).round());
  final oh = math.max(1, (h / f).round());
  final colOf = Int32List(w);
  for (var x = 0; x < w; x++) {
    colOf[x] = math.min(ow - 1, x ~/ f);
  }
  final out = Uint8List(ow * oh);
  final sum = Int32List(ow);
  final count = Int32List(ow);
  var row = 0;
  void flush(int r) {
    for (var ox = 0; ox < ow; ox++) {
      final c = count[ox];
      // An average of grey levels, so never above 255.
      out[r * ow + ox] = c == 0 ? 255 : (sum[ox] / (c * 1000)).round();
      sum[ox] = 0;
      count[ox] = 0;
    }
  }

  for (var y = 0; y < h; y++) {
    final r = math.min(oh - 1, y ~/ f);
    if (r != row) {
      flush(row);
      row = r;
    }
    var i = y * w * 4;
    for (var x = 0; x < w; x++, i += 4) {
      final ox = colOf[x];
      // The grey a photo of the page would have (ITU-R 601), times 1000.
      sum[ox] += rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114;
      count[ox]++;
    }
  }
  flush(row);
  return GreyPage(ow, oh, out);
}

/// What was seen on a picture given as RGBA bytes: see [lookAt]. One plain call, so it can be run away from the screen's thread.
PageLook lookAtRgba(Uint8List rgba, int w, int h) => lookAt(greyPage(rgba, w, h));

/// A figure whose box is at least this much darker than the paper is a photo pasted on the page, not a drawing (a drawing is mostly
/// paper between its lines).
const photoFill = 0.55;

/// What the figure finder saw on a page: its figures, how much of each is ink, and the marks that belong to no figure.
class PageLook {
  const PageLook(this.figures, {this.fills = const [], this.marks = const [], this.aspect = 1.414});

  /// The figures, top to bottom: see [findFigures].
  final List<FigureBox> figures;

  /// For each figure, the share of its box that is darker than the paper: little for a drawing, most of it for a photo pasted on the
  /// page (which edge detection sees as one block, whatever is in it).
  final List<double> fills;

  /// Small marks that are part of no figure and no line of text, such as a triangle or an arrowhead set a little apart from a drawing.
  final List<FigureBox> marks;

  /// The page's height over its width, so a distance down the page can be weighed against one across it.
  final double aspect;
}

/// Where each part of a page is an edge: a pixel whose grey level changes sharply against its neighbours (Sobel, after a slight
/// blur that takes out the grain of a photo). How sharp is judged against the page's own strongest edges, so a pale photo and a
/// crisp PDF both work, and never below a floor that the specks of a compressed picture could reach.
Uint8List edgesOf(GreyPage page) {
  final w = page.w, h = page.h, n = w * h;
  // A Gaussian blur of radius 2 (sigma 0.7), across and then down; the edge of the page repeats its last pixel.
  const k0 = 0.569914, k1 = 0.205425, k2 = 0.009619;
  final px = page.px;
  final across = Float32List(n);
  for (var y = 0; y < h; y++) {
    final o = y * w;
    for (var x = 0; x < w; x++) {
      final l1 = x < 1 ? 0 : x - 1, l2 = x < 2 ? 0 : x - 2;
      final r1 = x + 1 >= w ? w - 1 : x + 1, r2 = x + 2 >= w ? w - 1 : x + 2;
      across[o + x] = k0 * px[o + x] + k1 * (px[o + l1] + px[o + r1]) + k2 * (px[o + l2] + px[o + r2]);
    }
  }
  final soft = Float32List(n);
  for (var y = 0; y < h; y++) {
    final u1 = (y < 1 ? 0 : y - 1) * w, u2 = (y < 2 ? 0 : y - 2) * w;
    final d1 = (y + 1 >= h ? h - 1 : y + 1) * w, d2 = (y + 2 >= h ? h - 1 : y + 2) * w;
    final o = y * w;
    for (var x = 0; x < w; x++) {
      soft[o + x] = k0 * across[o + x] + k1 * (across[u1 + x] + across[d1 + x]) + k2 * (across[u2 + x] + across[d2 + x]);
    }
  }
  // Sobel: how fast the grey changes across and down, as grey levels a pixel.
  final mag = Float32List(n);
  const bins = 2048, binWidth = 0.25;
  final hist = Int32List(bins);
  for (var y = 0; y < h; y++) {
    final up = (y < 1 ? 0 : y - 1) * w, mid = y * w, down = (y + 1 >= h ? h - 1 : y + 1) * w;
    for (var x = 0; x < w; x++) {
      final l = x < 1 ? 0 : x - 1, r = x + 1 >= w ? w - 1 : x + 1;
      final gx = (soft[up + r] + 2 * soft[mid + r] + soft[down + r]) - (soft[up + l] + 2 * soft[mid + l] + soft[down + l]);
      final gy = (soft[down + l] + 2 * soft[down + x] + soft[down + r]) - (soft[up + l] + 2 * soft[up + x] + soft[up + r]);
      final m = math.sqrt(gx * gx + gy * gy) / 8;
      mag[mid + x] = m;
      hist[math.min(bins - 1, m ~/ binWidth)]++;
    }
  }
  // The page's strong edges: the level only half a percent of its pixels pass.
  final want = (0.995 * (n - 1)).floor();
  var seen = 0, at = 0;
  while (at < bins - 1 && seen + hist[at] <= want) {
    seen += hist[at];
    at++;
  }
  final strong = (at + 0.5) * binWidth;
  final threshold = math.max(14.0, 0.22 * strong);
  final edge = Uint8List(n);
  for (var i = 0; i < n; i++) {
    if (mag[i] > threshold) edge[i] = 1;
  }
  return edge;
}

/// What a piece of a page is, judged from its size alone.
enum _Kind { frame, seed, line, small }

/// Edge pixels that touch one another: a stroke of a drawing, a letter (or a word whose letters touch), or the border of a block.
class _Piece {
  _Piece(this.x0, this.y0, this.x1, this.y1, this.n);
  int x0, y0, x1, y1; // pixels; x1 and y1 are one past the last
  int n; // edge pixels in it
  _Kind kind = _Kind.small;
  bool text = false; // part of a line of text
  late List<int> row = [x0, y0, x1, y1]; // the line of pieces it sits in (itself when it sits in none)
  bool taken = false;
  int get w => x1 - x0;
  int get h => y1 - y0;
  List<int> get box => [x0, y0, x1, y1];
}

/// The pieces of an edge map: pixels that touch, corners included, in the order a reader meets them (top to bottom, left to right).
List<_Piece> _piecesOf(Uint8List edge, int w, int h) {
  final label = Int32List(w * h);
  final parent = <int>[0];
  int find(int a) {
    while (parent[a] != a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  }

  int join(int a, int b) {
    final ra = find(a), rb = find(b);
    if (ra == rb) return ra;
    final lo = math.min(ra, rb), hi = math.max(ra, rb);
    parent[hi] = lo;
    return lo;
  }

  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      final i = y * w + x;
      if (edge[i] == 0) continue;
      // The neighbours already labelled: left, and the three above.
      var l = 0;
      for (var k = 0; k < 4; k++) {
        final int j;
        if (k == 0) {
          if (x == 0) continue;
          j = i - 1;
        } else {
          if (y == 0) break;
          final dx = k - 2; // -1, 0, 1
          if (x + dx < 0 || x + dx >= w) continue;
          j = i - w + dx;
        }
        final m = label[j];
        if (m == 0) continue;
        l = l == 0 ? find(m) : join(l, m);
      }
      if (l == 0) {
        l = parent.length;
        parent.add(l);
      }
      label[i] = l;
    }
  }
  final pieceOf = Int32List(parent.length)..fillRange(0, parent.length, -1);
  final pieces = <_Piece>[];
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      final l = label[y * w + x];
      if (l == 0) continue;
      final r = find(l);
      var p = pieceOf[r];
      if (p < 0) {
        p = pieceOf[r] = pieces.length;
        pieces.add(_Piece(x, y, x + 1, y + 1, 0));
      }
      final q = pieces[p];
      if (x < q.x0) q.x0 = x;
      if (x + 1 > q.x1) q.x1 = x + 1;
      if (y + 1 > q.y1) q.y1 = y + 1;
      q.n++;
    }
  }
  return pieces;
}

/// The distance between two boxes in pixels (0 when they touch or overlap): the larger of the gap across and the gap down.
int _gap(List<int> a, List<int> b) {
  final dx = math.max<int>(0, math.max<int>(a[0], b[0]) - math.min<int>(a[2], b[2]));
  final dy = math.max<int>(0, math.max<int>(a[1], b[1]) - math.min<int>(a[3], b[3]));
  return math.max<int>(dx, dy);
}

List<int> _union(List<int> a, List<int> b) => [math.min(a[0], b[0]), math.min(a[1], b[1]), math.max(a[2], b[2]), math.max(a[3], b[3])];

bool _inside(List<int> p, List<int> b, double pad) => p[0] >= b[0] - pad && p[1] >= b[1] - pad && p[2] <= b[2] + pad && p[3] <= b[3] + pad;

/// How much of the stretch a0..a1 lies within b0..b1, as a fraction of a0..a1.
double _along(int a0, int a1, int b0, int b1) => math.max<int>(0, math.min<int>(a1, b1) - math.max<int>(a0, b0)) / math.max<int>(1, a1 - a0);

/// Marks the pieces that sit in a line of text: pieces side by side at about the same height, at least three of them across a tenth
/// of the page (whole words can be one piece each), or six or more. Every piece is also given the box of the line it sits in.
void _markText(List<_Piece> ps, int pageW) {
  final link = 0.028 * pageW;
  final parent = List<int>.generate(ps.length, (i) => i);
  int find(int a) {
    while (parent[a] != a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  }

  final order = List<int>.generate(ps.length, (i) => i)..sort((a, b) => ps[a].x0.compareTo(ps[b].x0));
  for (var k = 0; k < order.length; k++) {
    final a = ps[order[k]];
    for (var j = k + 1; j < order.length; j++) {
      final b = ps[order[j]];
      // Sorted by left edge: once one piece starts too far to the right of a, every later one does.
      if (b.x0 - a.x1 > link) break;
      final overlap = math.min(a.y1, b.y1) - math.max(a.y0, b.y0);
      if (overlap >= 0.5 * math.min(a.h, b.h)) {
        final ra = find(order[k]), rb = find(order[j]);
        if (ra != rb) parent[ra] = rb;
      }
    }
  }
  final rows = <int, List<int>>{};
  for (var i = 0; i < ps.length; i++) {
    rows.putIfAbsent(find(i), () => []).add(i);
  }
  for (final members in rows.values) {
    var x0 = ps[members.first].x0, y0 = ps[members.first].y0, x1 = ps[members.first].x1, y1 = ps[members.first].y1;
    for (final i in members) {
      x0 = math.min(x0, ps[i].x0);
      y0 = math.min(y0, ps[i].y0);
      x1 = math.max(x1, ps[i].x1);
      y1 = math.max(y1, ps[i].y1);
    }
    final text = (members.length >= 3 && x1 - x0 >= 0.10 * pageW) || members.length >= 6;
    for (final i in members) {
      ps[i]
        ..text = text
        ..row = [x0, y0, x1, y1];
    }
  }
}

/// The figures on a page, top to bottom, each as a box (fractions of the page) around its drawing and labels, with a little room
/// round it ([figureMargin]) where the page is clear. Text, blank paper and the edge of a photographed sheet are never figures.
List<FigureBox> findFigures(GreyPage page) => lookAt(page).figures;

/// The page's figures ([findFigures]), how much of each is ink, and the marks beside them that joined no figure: what [pickFigure]
/// needs to cut the right one for AI's box.
PageLook lookAt(GreyPage page) {
  final w = page.w, h = page.h;
  final pieces = _piecesOf(edgesOf(page), w, h);
  final area = w * h;
  for (final p in pieces) {
    final a = p.w * p.h;
    if (a >= 0.3 * area && p.n <= 0.05 * a) {
      // Thin and as big as much of the page: the edge of a photographed sheet, or a border round the page.
      p.kind = _Kind.frame;
    } else if (math.min(p.w, p.h) >= 0.04 * w && math.max(p.w, p.h) >= 0.07 * w) {
      p.kind = _Kind.seed;
    } else if (math.max(p.w, p.h) >= 0.06 * w) {
      p.kind = _Kind.line;
    }
  }
  final live = [for (final p in pieces) if (p.kind != _Kind.frame) p];
  // Lines of text: only pieces of a text line's height take part, so a drawing never makes its own labels look like a line of text.
  _markText([for (final p in live) if (p.h <= 0.06 * w) p], w);
  for (final p in live) {
    // A big piece that is a word in a line of text (a title, a Hindi word joined by its headline) is not a drawing.
    if (p.kind == _Kind.seed && p.text && p.h < 0.06 * w) p.kind = _Kind.small;
  }
  // Big pieces close together are one figure.
  final figures = [for (final p in live) if (p.kind == _Kind.seed) _Figure(p)];
  for (var merged = true; merged;) {
    merged = false;
    outer:
    for (var i = 0; i < figures.length; i++) {
      for (var j = i + 1; j < figures.length; j++) {
        if (_gap(figures[i].core, figures[j].core) <= 0.015 * w) {
          figures[i].core = _union(figures[i].core, figures[j].core);
          figures[i].parts.addAll(figures[j].parts);
          figures.removeAt(j);
          merged = true;
          break outer;
        }
      }
    }
  }
  final near = 0.011 * w;
  final rest = [for (final p in live) if (p.kind == _Kind.line || p.kind == _Kind.small) p];
  for (final f in figures) {
    // Lines join one after another (a leader line reaching out to its label); a line of text never does.
    for (var round = 0; round < 6; round++) {
      var grew = false;
      for (final p in rest) {
        if (p.taken || p.kind != _Kind.line || p.text || _gap(f.core, p.box) > near) continue;
        f.core = _union(f.core, p.box);
        f.parts.add(p);
        p.taken = true;
        grew = true;
      }
      if (!grew) break;
    }
    // Labels: small pieces inside the drawing, or a short group of them right beside it (above or below it within its width, or to
    // its side within its height). A group that mostly sits outside both is the next line of the paper, such as an option under it.
    f.box = f.core;
    final c = f.core;
    for (final p in rest) {
      if (p.taken) continue;
      final r = p.row;
      final label = _inside(p.box, c, 0.005 * w) ||
          (!p.text && _gap(c, r) <= near && math.max(_along(r[0], r[2], c[0], c[2]), _along(r[1], r[3], c[1], c[3])) >= 0.5);
      if (!label) continue;
      f.box = _union(f.box, p.box);
      f.parts.add(p);
      p.taken = true;
    }
  }
  figures.sort((a, b) => a.box[1].compareTo(b.box[1]));
  final room = (figureMargin * w).round();
  final boxes = [for (final f in figures) _withRoom(f, pieces, room, w, h)];
  // The paper's grey: what nine pixels in ten are no brighter than (the paper itself, on a printed page or a photo of one).
  final hist = Int32List(256);
  for (final v in page.px) {
    hist[v]++;
  }
  var paper = 255;
  for (var seen = 0; paper > 0; paper--) {
    seen += hist[paper];
    if (seen >= 0.1 * page.px.length) break;
  }
  final dark = paper - 48;
  final fills = <double>[];
  for (final f in figures) {
    final b = f.box;
    var n = 0;
    for (var y = b[1]; y < b[3]; y++) {
      final o = y * w;
      for (var x = b[0]; x < b[2]; x++) {
        if (page.px[o + x] < dark) n++;
      }
    }
    fills.add(n / math.max(1, (b[2] - b[0]) * (b[3] - b[1])));
  }
  // Marks: a piece on its own (no line of text, no figure) and big enough not to be a speck of grain.
  final marks = <FigureBox>[];
  for (final p in live) {
    if (p.taken || p.text || p.kind == _Kind.seed || p.n < 4 || math.max(p.w, p.h) < 0.006 * w) continue;
    final r = p.row;
    if (r[0] != p.x0 || r[1] != p.y0 || r[2] != p.x1 || r[3] != p.y1) continue; // it sits in a row with others: a word, not a mark
    if (figures.any((f) => f.parts.contains(p) || _inside(p.box, f.box, 0))) continue;
    marks.add([p.x0 / w, p.y0 / h, p.x1 / w, p.y1 / h]);
  }
  return PageLook(boxes, fills: fills, marks: marks, aspect: h / w);
}

/// [f]'s box with up to [room] pixels more on each side, less where anything else on the page (another figure, a line of text, the
/// edge of the sheet) comes closer than that, as fractions of the page.
FigureBox _withRoom(_Figure f, List<_Piece> pieces, int room, int w, int h) {
  final b = f.box;
  var left = room, top = room, right = room, bottom = room;
  for (final p in pieces) {
    if (f.parts.contains(p)) continue;
    // Something above or below the figure, within its width (and the room beside it), limits the room above or below.
    if (p.x0 < b[2] + room && p.x1 > b[0] - room) {
      if (p.y1 <= b[1]) top = math.min(top, b[1] - p.y1 - 1);
      if (p.y0 >= b[3]) bottom = math.min(bottom, p.y0 - b[3] - 1);
    }
    if (p.y0 < b[3] + room && p.y1 > b[1] - room) {
      if (p.x1 <= b[0]) left = math.min(left, b[0] - p.x1 - 1);
      if (p.x0 >= b[2]) right = math.min(right, p.x0 - b[2] - 1);
    }
  }
  double at(int v, int size) => (v / size).clamp(0.0, 1.0);
  return [at(b[0] - math.max(0, left), w), at(b[1] - math.max(0, top), h), at(b[2] + math.max(0, right), w), at(b[3] + math.max(0, bottom), h)];
}

class _Figure {
  _Figure(_Piece seed)
      : core = seed.box,
        box = seed.box,
        parts = {seed};

  /// The drawing itself: its big pieces and the lines joined to them.
  List<int> core;

  /// The drawing with its labels.
  List<int> box;

  /// Every piece of it.
  final Set<_Piece> parts;
}

double _area(List<double> b) => math.max(0.0, b[2] - b[0]) * math.max(0.0, b[3] - b[1]);

/// Where two boxes overlap (a box of no area when they do not).
FigureBox _meet(List<double> a, List<double> b) => [math.max(a[0], b[0]), math.max(a[1], b[1]), math.min(a[2], b[2]), math.min(a[3], b[3])];

FigureBox _joined(List<double> a, List<double> b) => [math.min(a[0], b[0]), math.min(a[1], b[1]), math.max(a[2], b[2]), math.max(a[3], b[3])];

/// A figure big on the page that mostly lies outside the box looked in ([hint]) is not the question's figure alone: the shadow of a
/// photographed sheet, or a drawing run together with the page's heading or text. AI's box is the better guess then.
bool _tooBig(List<double> f, List<double> hint) => _area(f) > 0.12 && _area(_meet(f, hint)) < 0.5 * _area(f);

/// The figure [hint] (AI's box for it) points at, among the page's [figures], and the box to cut for it. AI's box may be loose, cut
/// short, or written with x and y swapped, so the figure it overlaps most, measured against the smaller of the two, is the one;
/// swapped is tried too and wins only when it fits clearly better. Then:
/// - a figure in parts keeps every part within AI's box: stages drawn side by side, or a drawing with a mark set a little apart from
///   it ([marks], such as the triangle a question asks about);
/// - a photo pasted on the page ([fills] says a figure is mostly darker than the paper) is one block to edge detection, so the cut is
///   AI's box within it, when AI's box lies within it ([inPhoto]);
/// - a figure big on the page that mostly lies outside AI's box is passed over (see [_tooBig]).
/// [aspect] is the page's height over its width. Null when the box overlaps no figure well enough to say.
({FigureBox box, bool swapped, bool inPhoto})? pickFigure(List<FigureBox> figures, FigureBox hint,
    {List<double> fills = const [], List<FigureBox> marks = const [], double aspect = 1.414}) {
  if (hint.length != 4) return null;
  final x1 = math.min(hint[0], hint[2]), x2 = math.max(hint[0], hint[2]);
  final y1 = math.min(hint[1], hint[3]), y2 = math.max(hint[1], hint[3]);
  final tries = <(FigureBox, bool)>[([x1, y1, x2, y2], false), if (x1 != y1 || x2 != y2) ([y1, x1, y2, x2], true)];
  (double, double, int, FigureBox, bool)? best;
  for (final (box, swapped) in tries) {
    final a = _area(box);
    if (a <= 0) continue;
    for (var i = 0; i < figures.length; i++) {
      final f = figures[i];
      final meet = _area(_meet(f, box));
      if (meet <= 0) continue;
      // A photo that holds AI's box is cut at AI's box (below), however big the photo is.
      final photoAround = i < fills.length && fills[i] >= photoFill && meet >= 0.8 * a;
      if (!photoAround && _tooBig(f, box)) continue;
      final score = meet / math.min(_area(f), a) - (swapped ? 0.2 : 0);
      if (score < 0.3) continue;
      if (best == null || score > best.$1 + 1e-9 || ((score - best.$1).abs() <= 1e-9 && meet > best.$2)) best = (score, meet, i, box, swapped);
    }
  }
  if (best == null) return null;
  final (_, _, i, hintBox, swapped) = best;
  final f = figures[i].sublist(0, 4);
  final a = _area(hintBox);
  // A little room round a cut that is not along the figure's own edges: as across the page, the same distance down it.
  final roomX = figureMargin / 2, roomY = figureMargin / 2 / aspect;
  FigureBox clamp(List<double> b) => [for (final v in b) v.clamp(0.0, 1.0)];
  // The photo itself, without the room left round it: AI's box only a little smaller than that is AI's box round the whole photo.
  final photo = [f[0] + figureMargin, f[1] + figureMargin / aspect, f[2] - figureMargin, f[3] - figureMargin / aspect];
  if (i < fills.length && fills[i] >= photoFill && _area(_meet(f, hintBox)) >= 0.8 * a && a < 0.85 * _area(photo)) {
    final grown = [hintBox[0] - roomX, hintBox[1] - roomY, hintBox[2] + roomX, hintBox[3] + roomY];
    return (box: clamp(_meet(grown, f)), swapped: swapped, inPhoto: true);
  }
  var box = f;
  for (var j = 0; j < figures.length; j++) {
    final g = figures[j];
    if (j != i && _area(_meet(g, hintBox)) >= 0.6 * _area(g)) box = _joined(box, g);
  }
  // Marks within AI's box join when they are close to the figure (or to a mark that joined): twice round, so a mark beside a mark
  // that joined joins too.
  final reachX = 2.5 * figureMargin, reachY = reachX / aspect;
  final left = [for (final m in marks) if (_area(_meet(m, hintBox)) >= 0.6 * _area(m)) m];
  for (var round = 0; round < 2; round++) {
    left.removeWhere((m) {
      final gapX = math.max(0.0, math.max(m[0], box[0]) - math.min(m[2], box[2]));
      final gapY = math.max(0.0, math.max(m[1], box[1]) - math.min(m[3], box[3]));
      if (gapX > reachX || gapY > reachY) return false;
      box = _joined(box, [m[0] - roomX, m[1] - roomY, m[2] + roomX, m[3] + roomY]);
      return true;
    });
  }
  return (box: clamp(box), swapped: swapped, inPhoto: false);
}
