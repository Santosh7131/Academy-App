import 'dart:async';
import 'dart:collection';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart' show compute;
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';

import '../../core/api.dart';
import '../../theme.dart';
import '../../ui/kit.dart';
import 'figure_finder.dart';

/// Looks for the figures on a page picture given as RGBA bytes ([lookAtRgba]). The app runs it on another thread; tests may run it
/// straight away.
typedef FigureFinder = Future<PageLook> Function(Uint8List rgba, int width, int height);

Future<PageLook> _findAway(Uint8List rgba, int width, int height) => compute(_lookAt, (rgba, width, height));

PageLook _lookAt((Uint8List, int, int) page) => lookAtRgba(page.$1, page.$2, page.$3);

/// A box on a page as four fractions of it: left, top, right, bottom, with 0,0 at the page's top left corner.
typedef PageBox = List<double>;

/// A box the server sent ([x1, y1, x2, y2] of numbers), or null when it is not one.
PageBox? pageBoxOf(Object? raw) {
  if (raw is! List || raw.length != 4 || raw.any((v) => v is! num)) return null;
  final b = [for (final v in raw) (v as num).toDouble()];
  return b[2] > b[0] && b[3] > b[1] ? b : null;
}

/// A page and a box on it, from the server's `{"page": 2, "box": [...]}`.
({int page, PageBox box})? placedOf(Object? raw) {
  if (raw is! Map || raw['page'] is! int) return null;
  final box = pageBoxOf(raw['box']);
  return box == null ? null : (page: raw['page'] as int, box: box);
}

/// Whether a box could be a question as printed. A question runs across a good part of the page's width, and has some height. A model
/// that mixes up which number is which gives a thin tall sliver instead, and as a picture that is a long strip of nothing.
bool plausibleQuestionBox(PageBox b) => b[2] - b[0] >= 0.2 && b[3] - b[1] >= 0.012;

/// Where a question is printed, one entry per page it is on (two when it ran over the page edge). Empty when a box is not one a
/// question could have: half a question would mislead, so the page is offered instead.
List<({int page, PageBox box})> questionParts(Map<String, dynamic> draft) {
  final raw = draft['question_boxes'];
  if (raw is! List) return const [];
  final parts = [for (final p in raw) ?placedOf(p)];
  return parts.any((p) => !plausibleQuestionBox(p.box)) ? const [] : parts;
}

/// A paper's page pictures, each loaded once. The check list and the editor show parts of them, and a figure is cut out of one (or
/// out of a photo the tutor takes).
class PaperPictures {
  PaperPictures({Future<Uint8List?> Function(String url)? fetch, this.onStale, FigureFinder? findFigures, Future<Uint8List?> Function(ImageSource source)? pickPhoto})
      : _fetch = fetch ?? _download,
        _find = findFigures ?? _findAway,
        _pick = pickPhoto ?? _pickPhoto;

  final Future<Uint8List?> Function(String url) _fetch;
  final FigureFinder _find;
  final Future<Uint8List?> Function(ImageSource source) _pick;

  static Future<Uint8List?> _pickPhoto(ImageSource source) async {
    final file = await ImagePicker().pickImage(source: source, maxWidth: 1600, imageQuality: 85);
    return file?.readAsBytes();
  }

  /// The figures on any picture: a page turned on the cut screen, or a photo.
  Future<List<FigureBox>> findOn(ui.Image img) => figuresOn(img, _find);

  /// A photo of a figure, taken or chosen, then cut down by the tutor (see [cutPicture]). The cut as PNG bytes, or null when the tutor
  /// backs out.
  Future<Uint8List?> cutPhoto(BuildContext context, ImageSource source) async {
    final bytes = await _pick(source);
    if (bytes == null || !context.mounted) return null;
    return cutPicture(context, bytes, find: _find);
  }

  /// What was seen on each page so far, looked at once a page.
  final Map<int, Future<PageLook>> _looks = {};

  /// Where on [page] the figure is that [hint] (AI's box for it) points at, found by edge detection: a box tight round the drawing,
  /// its labels and any part of it set apart, or null when nothing there looks like a figure (or the page cannot be looked at). AI's
  /// box may be loose, cut short or have x and y swapped; it says which of the page's figures is meant, and where in a pasted photo.
  Future<PageBox?> figureAt(int page, PageBox hint) async {
    final look = await (_looks[page] ??= _lookAtPage(page));
    final pick = pickFigure(look.figures, hint, fills: look.fills, marks: look.marks, aspect: look.aspect);
    return pick == null ? null : [for (final v in pick.box) double.parse(v.toStringAsFixed(4))];
  }

  Future<PageLook> _lookAtPage(int page) async {
    try {
      final img = await image(page);
      final data = img == null ? null : await img.toByteData(format: ui.ImageByteFormat.rawRgba);
      if (img != null && data != null) return await _find(data.buffer.asUint8List(), img.width, img.height);
    } catch (_) {}
    // Not looked at: asking again tries again.
    _looks.remove(page);
    return const PageLook([]);
  }

  /// Asked to fetch new addresses (and hand them to [setPages]) when a page will not load: an address works for an hour, and a
  /// review can take longer.
  final Future<void> Function()? onStale;
  final Map<int, String> _urls = {};

  /// The pages decoded so far. A page is 14 MB once decoded, so only the last few are kept; a picture on screen
  /// holds its own page for as long as it needs it.
  final LinkedHashMap<int, Future<ui.Image?>> _images = LinkedHashMap();
  static const _kept = 4;

  /// Takes the paper's page list (each page with its `image_url`, or null while it is not uploaded).
  void setPages(List<Map<String, dynamic>> pages) {
    for (final pg in pages) {
      final url = pg['image_url'];
      if (pg['page_no'] is int && url is String) _urls[pg['page_no'] as int] = url;
    }
  }

  String? url(int page) => _urls[page];

  /// The page as a picture, or null when it has no picture or it could not be loaded (asking again tries again).
  Future<ui.Image?> image(int page) {
    final url = _urls[page];
    if (url == null) return Future.value(null);
    final have = _images.remove(page);
    final future = have ?? _loadPage(page, url).then((img) {
      if (img == null) _images.remove(page);
      return img;
    });
    _images[page] = future;
    while (_images.length > _kept) {
      _images.remove(_images.keys.first);
    }
    return future;
  }

  /// A new address for [page], or null when none can be had: for a screen that shows the page itself and finds its address stale.
  Future<String?> fresh(int page) async {
    try {
      await onStale?.call();
    } catch (_) {}
    return _urls[page];
  }

  /// The page, with one more try on a new address when the first does not load (it may have run out).
  Future<ui.Image?> _loadPage(int page, String url) async {
    final img = await _load(url);
    if (img != null || onStale == null) return img;
    final again = await fresh(page);
    return again == null || again == url ? null : _load(again);
  }

  Future<ui.Image?> _load(String url) async {
    try {
      final bytes = await _fetch(url);
      if (bytes == null) return null;
      final codec = await ui.instantiateImageCodec(bytes);
      return (await codec.getNextFrame()).image;
    } catch (_) {
      return null;
    }
  }

  static Future<Uint8List?> _download(String url) async {
    final res = await http.get(Uri.parse(url)).timeout(const Duration(seconds: 40));
    return res.statusCode == 200 ? res.bodyBytes : null;
  }
}

/// The part of a page picture inside [box], as PNG bytes (a drawing stays sharp as a PNG). [margin] adds room around it as a
/// fraction of the page's width.
Future<Uint8List?> cutOut(ui.Image page, PageBox box, {double margin = 0}) async {
  final w = page.width.toDouble();
  final h = page.height.toDouble();
  final src = Rect.fromLTRB(
    (box[0] - margin).clamp(0.0, 1.0) * w,
    (box[1] - margin * w / h).clamp(0.0, 1.0) * h,
    (box[2] + margin).clamp(0.0, 1.0) * w,
    (box[3] + margin * w / h).clamp(0.0, 1.0) * h,
  );
  final outW = src.width.round().clamp(1, 4000);
  final outH = src.height.round().clamp(1, 4000);
  final recorder = ui.PictureRecorder();
  Canvas(recorder).drawImageRect(page, src, Rect.fromLTWH(0, 0, outW.toDouble(), outH.toDouble()), Paint()..filterQuality = FilterQuality.high);
  final img = await recorder.endRecording().toImage(outW, outH);
  final data = await img.toByteData(format: ui.ImageByteFormat.png);
  return data?.buffer.asUint8List();
}

/// The figures on a picture, found by [find] (by default on another thread).
Future<List<FigureBox>> figuresOn(ui.Image img, [FigureFinder find = _findAway]) async {
  final data = await img.toByteData(format: ui.ImageByteFormat.rawRgba);
  return data == null ? const [] : (await find(data.buffer.asUint8List(), img.width, img.height)).figures;
}

/// A picture (a photo of a figure) cut down by the tutor on the "Cut the figure" screen: the box starts round the figure found in it,
/// or round nearly all of it, so a photo of just the figure needs only "Use this cut". The cut as PNG bytes, or null when the tutor
/// backs out.
Future<Uint8List?> cutPicture(BuildContext context, Uint8List bytes, {FigureFinder find = _findAway}) async {
  final codec = await ui.instantiateImageCodec(bytes);
  final photo = (await codec.getNextFrame()).image;
  Future<List<FigureBox>> figures(ui.Image img) => figuresOn(img, find);
  final found = await figures(photo);
  if (!context.mounted) return null;
  final cut = await Navigator.of(context).push<Object>(MaterialPageRoute(
    builder: (_) => FigureCutScreen(load: (_) async => photo, page: 1, start: found.isNotEmpty ? found.first : const [0.03, 0.03, 0.97, 0.97], figures: figures),
  ));
  return cut is FigureCut ? cutOut(cut.image, cut.box) : null;
}

/// Uploads a figure cut out of a page. Returns its storage key.
Future<String> uploadFigure(Uint8List png) async {
  final up = await api.post('/teacher/uploads', {'size': png.length, 'type': 'png'});
  await api.putBytes('${up['put_url']}', png, contentType: 'image/png');
  return '${up['key']}';
}

/// A piece of a page picture: the part inside [box], a little wider so a cut line is never the question's edge.
class PagePiece extends StatefulWidget {
  const PagePiece({super.key, required this.pictures, required this.page, required this.box});
  final PaperPictures pictures;
  final int page;
  final PageBox box;

  @override
  State<PagePiece> createState() => _PagePieceState();
}

class _PagePieceState extends State<PagePiece> {
  ui.Image? _image;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(PagePiece old) {
    super.didUpdateWidget(old);
    if (old.page != widget.page) _load();
  }

  void _load() {
    setState(() {
      _image = null;
      _failed = false;
    });
    widget.pictures.image(widget.page).then((img) {
      if (mounted) {
        setState(() {
          _image = img;
          _failed = img == null;
        });
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final img = _image;
    if (img == null) {
      return Pressable(
        onTap: _failed ? _load : null,
        label: _failed ? 'Try loading the page again' : 'Loading the page',
        child: Container(
          height: 76,
          alignment: Alignment.center,
          child: Fig(_failed ? 'The page did not load. Tap to try again.' : 'Loading the page', style: labelStyle.copyWith(color: const Color(0xFF85858F))),
        ),
      );
    }
    final w = img.width.toDouble();
    final h = img.height.toDouble();
    final b = widget.box;
    final src = Rect.fromLTRB(
      (b[0] - 0.012).clamp(0.0, 1.0) * w,
      (b[1] - 0.007).clamp(0.0, 1.0) * h,
      (b[2] + 0.012).clamp(0.0, 1.0) * w,
      (b[3] + 0.007).clamp(0.0, 1.0) * h,
    );
    // A box with no area (or one far off the page) has nothing to show, and an aspect ratio of nothing would break the layout.
    if (src.width < 2 || src.height < 2) return const SizedBox.shrink();
    return Semantics(
      image: true,
      label: 'The question as printed on page ${widget.page}',
      child: AspectRatio(aspectRatio: src.width / src.height, child: CustomPaint(painter: _PiecePainter(img, src))),
    );
  }
}

class _PiecePainter extends CustomPainter {
  _PiecePainter(this.image, this.src);
  final ui.Image image;
  final Rect src;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawImageRect(image, src, Offset.zero & size, Paint()..filterQuality = FilterQuality.medium..isAntiAlias = true);
  }

  @override
  bool shouldRepaint(_PiecePainter old) => old.image != image || old.src != src;
}

const _paperInk = Color(0xFF85858F);
const _paperEdge = Color(0xFFE1E1E7);

/// "From your paper": the question as it is printed, on a white card like the paper itself, with a way to see its whole page.
class FromYourPaper extends StatelessWidget {
  const FromYourPaper({super.key, required this.pictures, required this.parts, required this.onWholePage});
  final PaperPictures pictures;
  final List<({int page, PageBox box})> parts;
  final void Function(int page) onWholePage;

  @override
  Widget build(BuildContext context) {
    final pages = [for (final p in parts) p.page];
    final label = pages.length == 1 ? 'page ${pages.first}' : 'pages ${pages.sublist(0, pages.length - 1).join(', ')} and ${pages.last}';
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Container(
        padding: const EdgeInsets.fromLTRB(11, 10, 11, 11),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: _paperEdge),
          boxShadow: const [BoxShadow(color: Color(0x0D000000), blurRadius: 2, offset: Offset(0, 1))],
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            const Icon(Ph.image, size: 13, color: _paperInk),
            const SizedBox(width: 6),
            Expanded(child: Text('FROM YOUR PAPER', style: kickerStyle.copyWith(color: _paperInk, fontSize: 10), maxLines: 1, overflow: TextOverflow.ellipsis)),
            Fig(label, style: labelStyle.copyWith(color: _paperInk, fontSize: 11), numColor: _paperInk),
          ]),
          const SizedBox(height: 7),
          for (final (i, p) in parts.indexed) ...[
            if (i > 0) ...[
              const SizedBox(height: 6),
              Row(children: [
                const Expanded(child: Divider(height: 1, color: _paperEdge)),
                Padding(padding: const EdgeInsets.symmetric(horizontal: 8), child: Fig('page ${p.page}', style: labelStyle.copyWith(color: _paperInk, fontSize: 10.5), numColor: _paperInk)),
                const Expanded(child: Divider(height: 1, color: _paperEdge)),
              ]),
              const SizedBox(height: 6),
            ],
            PagePiece(pictures: pictures, page: p.page, box: p.box),
          ],
        ]),
      ),
      Align(
        alignment: Alignment.centerLeft,
        child: Pressable(
          onTap: () => onWholePage(parts.first.page),
          label: 'See the whole page',
          child: Padding(
            padding: const EdgeInsets.only(top: 9, bottom: 2),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(Ph.arrowsOutSimple, size: 14, color: muted),
              const SizedBox(width: 6),
              Flexible(child: Fig('See the whole page', style: labelStyle.copyWith(color: muted, fontWeight: FontWeight.w600, fontSize: 12.5))),
            ]),
          ),
        ),
      ),
    ]);
  }
}

/// A figure cut from a page: the picture with where it came from and what can be done to it.
class CutFigure extends StatelessWidget {
  const CutFigure({super.key, required this.url, required this.caption, this.onCutAgain, this.onRemove});
  final String url;
  final String caption;
  final VoidCallback? onCutAgain;
  final VoidCallback? onRemove;

  Widget _tool(String label, IconData icon, VoidCallback? onTap) => Pressable(
        onTap: onTap,
        label: label,
        child: Container(
          height: 30,
          padding: const EdgeInsets.symmetric(horizontal: 10),
          decoration: BoxDecoration(color: const Color(0xFFF1F1F4), borderRadius: BorderRadius.circular(999)),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Icon(icon, size: 13, color: const Color(0xFF26262B)),
            const SizedBox(width: 5),
            Text(label, style: tagStyle.copyWith(fontSize: 11.5, color: const Color(0xFF26262B), fontWeight: FontWeight.w700), maxLines: 1),
          ]),
        ),
      );

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.fromLTRB(8, 8, 8, 8),
        decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(12), border: Border.all(color: _paperEdge)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 220),
            child: Image.network(url, fit: BoxFit.contain, webHtmlElementStrategy: WebHtmlElementStrategy.fallback, errorBuilder: (_, _, _) => const SizedBox(height: 60, child: Center(child: Icon(Ph.image, color: _paperInk)))),
          ),
          const SizedBox(height: 8),
          Wrap(spacing: 6, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
            Row(mainAxisSize: MainAxisSize.min, children: [
              const Icon(Ph.image, size: 13, color: _paperInk),
              const SizedBox(width: 6),
              Text(caption.toUpperCase(), style: kickerStyle.copyWith(color: _paperInk, fontSize: 10), maxLines: 1),
            ]),
            if (onCutAgain != null) _tool('Cut again', Ph.scissors, onCutAgain),
            if (onRemove != null) _tool('Remove', Ph.x, onRemove),
          ]),
        ]),
      );
}

/// The whole of one page, to look at: pinch to zoom. It says so while the page is coming, and when it cannot come it says that and
/// offers another try (on a new address when [fresh] can give one: an address stops working after an hour). A page that is neither
/// shown nor explained is a white screen.
class WholePageScreen extends StatefulWidget {
  const WholePageScreen({super.key, required this.url, required this.n, this.fresh});
  final String url;
  final int n;

  /// A new address for the page, or null when there is none.
  final Future<String?> Function()? fresh;

  @override
  State<WholePageScreen> createState() => _WholePageScreenState();
}

class _WholePageScreenState extends State<WholePageScreen> {
  late String _url = widget.url;
  int _attempt = 0;
  bool _asking = false;

  Future<void> _again() async {
    if (_asking) return;
    setState(() => _asking = true);
    String? fresh;
    try {
      fresh = await widget.fresh?.call();
    } catch (_) {}
    if (!mounted) return;
    setState(() {
      if (fresh != null) _url = fresh;
      _attempt++;
      _asking = false;
    });
  }

  Widget _note(String text, {VoidCallback? onTap}) {
    final words = Padding(padding: const EdgeInsets.all(gutter), child: Fig(text, style: bodyStyle.copyWith(color: muted), textAlign: TextAlign.center));
    return Center(child: onTap == null ? words : Pressable(onTap: onTap, label: 'Try loading the page again', child: words));
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        body: SafeArea(
          child: Column(children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(gutter, 8, gutter, 8),
              child: Row(children: [
                CircleBtn(icon: Ph.arrowLeft, label: 'Back', onTap: () => Navigator.of(context).pop()),
                const SizedBox(width: 14),
                Fig('Page ${widget.n}', style: sectionStyle),
              ]),
            ),
            Expanded(
              child: InteractiveViewer(
                maxScale: 5,
                child: Center(
                  child: Image.network(
                    _url,
                    key: ValueKey('$_url#$_attempt'),
                    webHtmlElementStrategy: WebHtmlElementStrategy.fallback,
                    frameBuilder: (context, child, frame, loadedAtOnce) => frame == null && !loadedAtOnce ? _note(_asking ? 'Getting the page again' : 'Loading the page') : child,
                    errorBuilder: (context, error, stack) => _note(_asking ? 'Getting the page again' : 'The page did not load. Tap to try again.', onTap: _asking ? null : _again),
                  ),
                ),
              ),
            ),
          ]),
        ),
      );
}

enum _Grab { topLeft, top, topRight, right, bottomRight, bottom, bottomLeft, left, move }

/// [img] turned a quarter turn clockwise.
Future<ui.Image> turnImage(ui.Image img) async {
  final recorder = ui.PictureRecorder();
  Canvas(recorder)
    ..translate(img.height.toDouble(), 0)
    ..rotate(math.pi / 2)
    ..drawImage(img, Offset.zero, Paint()..filterQuality = FilterQuality.high);
  return recorder.endRecording().toImage(img.height, img.width);
}

/// What the tutor cut on the "Cut the figure" screen: the page, the picture as it was shown ([turns] quarter turns clockwise from how it
/// is stored), and the box on that picture as fractions of it. [cutOut] cuts it; the box says where the figure is on the stored page
/// only when [turns] is 0.
class FigureCut {
  const FigureCut({required this.page, required this.image, required this.box, required this.turns});
  final int page;
  final ui.Image image;
  final PageBox box;
  final int turns;
}

/// "Cut the figure": a page (or a photo) with a box to drag so it holds only the figure. One finger on the box moves it, or a corner or
/// side of it; pinching zooms in for a close cut, and one finger off the box moves a zoomed picture. The figures found on the picture
/// are outlined, and a tap on one fits the box round it. A paper's other pages are a tap away, and a picture taken sideways can be
/// turned. Pops with a [FigureCut], or with [usePhoto] when the tutor would rather add a photo.
class FigureCutScreen extends StatefulWidget {
  const FigureCutScreen({super.key, required this.load, required this.page, required this.start, this.pages = 1, this.figures, this.offerPhoto = false});

  /// The picture of page [n] (a photo has only page 1), or null when it cannot be had.
  final Future<ui.Image?> Function(int n) load;

  /// How many pages there are to cut from.
  final int pages;
  final int page;

  /// Where the box starts on [page], as fractions of it.
  final PageBox start;

  /// The figures on a picture, found by edge detection, for a tap to fit the box round one. Without it none are outlined.
  final Future<List<FigureBox>> Function(ui.Image image)? figures;

  /// Offers "Use a photo instead", which pops with [usePhoto].
  final bool offerPhoto;

  /// What the screen pops with when the tutor asks for a photo instead of a cut.
  static const usePhoto = 'photo';

  @override
  State<FigureCutScreen> createState() => _FigureCutScreenState();
}

class _FigureCutScreenState extends State<FigureCutScreen> {
  late int _page = widget.page;
  int _turns = 0;
  ui.Image? _image;
  bool _failed = false;
  List<FigureBox> _figs = const [];
  late Rect _box = _rectOf(widget.start);

  /// Each picture opened gets a number, so an answer that comes after the tutor has moved on is thrown away.
  int _shownId = 0;

  /// How far the picture is zoomed in (1 = whole), and how far it is moved from where it sits unzoomed, in pixels.
  double _zoom = 1;
  Offset _pan = Offset.zero;

  /// The room the picture is drawn in, measured when laid out.
  Size _area = Size.zero;

  // The gesture under way: a box being dragged by [_grab], a zoomed picture being moved, or a pinch.
  _Grab? _grab;
  bool _panning = false;
  bool _pinching = false;
  int _fingers = 0;
  double _zoomAtPinch = 1;
  Offset _underFingers = Offset.zero;

  static const _minW = 0.04;
  static const _minH = 0.03;
  static const _maxZoom = 6.0;

  static Rect _rectOf(PageBox b) => Rect.fromLTRB(b[0].clamp(0.0, 1.0), b[1].clamp(0.0, 1.0), b[2].clamp(0.0, 1.0), b[3].clamp(0.0, 1.0));

  @override
  void initState() {
    super.initState();
    _open(widget.page, start: widget.start);
  }

  Future<List<FigureBox>> _find(ui.Image img) async {
    try {
      return await widget.figures?.call(img) ?? const [];
    } catch (_) {
      return const [];
    }
  }

  /// Opens page [page]. Without [start] (another page of the paper) the box goes round the page's first figure, or across its middle.
  Future<void> _open(int page, {PageBox? start}) async {
    final id = ++_shownId;
    setState(() {
      _page = page;
      _image = null;
      _failed = false;
      _figs = const [];
      _turns = 0;
      _zoom = 1;
      _pan = Offset.zero;
      if (start != null) _box = _rectOf(start);
    });
    final img = await widget.load(page);
    if (!mounted || id != _shownId) return;
    setState(() {
      _image = img;
      _failed = img == null;
    });
    if (img == null) return;
    final figs = await _find(img);
    if (!mounted || id != _shownId) return;
    setState(() {
      _figs = figs;
      if (start == null) _box = _rectOf(figs.isNotEmpty ? figs.first : const [0.12, 0.3, 0.88, 0.6]);
    });
  }

  /// A quarter turn clockwise: the picture, the box with it, and the figures looked for again on the turned picture.
  Future<void> _turn() async {
    final img = _image;
    if (img == null) return;
    final id = ++_shownId;
    final turned = await turnImage(img);
    if (!mounted || id != _shownId) return;
    final b = _box;
    setState(() {
      _turns = (_turns + 1) % 4;
      _image = turned;
      _box = Rect.fromLTRB(1 - b.bottom, b.left, 1 - b.top, b.right);
      _figs = const [];
      _zoom = 1;
      _pan = Offset.zero;
    });
    final figs = await _find(turned);
    if (mounted && id == _shownId) setState(() => _figs = figs);
  }

  /// The picture fitted whole into the room, before any zoom.
  Rect _fitted(ui.Image img) {
    final s = math.min(_area.width / img.width, _area.height / img.height);
    final w = img.width * s, h = img.height * s;
    return Rect.fromLTWH((_area.width - w) / 2, (_area.height - h) / 2, w, h);
  }

  /// Where the picture is drawn now.
  Rect _shown(ui.Image img) {
    final f = _fitted(img);
    return Rect.fromLTWH(f.left + _pan.dx, f.top + _pan.dy, f.width * _zoom, f.height * _zoom);
  }

  /// Keeps a zoomed picture over the room (no empty band at an edge while there is picture to show there), and an unzoomed one centred.
  Offset _keptOver(ui.Image img, Offset pan) {
    final f = _fitted(img);
    double axis(double p, double start, double size, double room) => size <= room ? (room - size) / 2 - start : p.clamp(room - size - start, -start);
    return Offset(axis(pan.dx, f.left, f.width * _zoom, _area.width), axis(pan.dy, f.top, f.height * _zoom, _area.height));
  }

  Offset _onPicture(ui.Image img, Offset p) {
    final s = _shown(img);
    return Offset((p.dx - s.left) / s.width, (p.dy - s.top) / s.height);
  }

  Rect _onScreen(ui.Image img, Rect r) {
    final s = _shown(img);
    return Rect.fromLTRB(s.left + r.left * s.width, s.top + r.top * s.height, s.left + r.right * s.width, s.top + r.bottom * s.height);
  }

  Map<_Grab, Offset> _handles(Rect r) => {
        _Grab.topLeft: r.topLeft,
        _Grab.top: r.topCenter,
        _Grab.topRight: r.topRight,
        _Grab.right: r.centerRight,
        _Grab.bottomRight: r.bottomRight,
        _Grab.bottom: r.bottomCenter,
        _Grab.bottomLeft: r.bottomLeft,
        _Grab.left: r.centerLeft,
      };

  /// What a gesture does, decided when it starts and again whenever a finger is added or lifted.
  void _begin(ui.Image img, Offset at, int fingers) {
    _fingers = fingers;
    _grab = null;
    _panning = false;
    _pinching = fingers >= 2;
    if (_pinching) {
      _zoomAtPinch = _zoom;
      _underFingers = _onPicture(img, at);
      return;
    }
    final r = _onScreen(img, _box);
    _Grab? best;
    var bestDist = 30.0;
    for (final e in _handles(r).entries) {
      final d = (e.value - at).distance;
      if (d < bestDist) {
        best = e.key;
        bestDist = d;
      }
    }
    _grab = best ?? (r.inflate(6).contains(at) ? _Grab.move : null);
    _panning = _grab == null;
  }

  void _scaleStart(ScaleStartDetails d) {
    final img = _image;
    if (img != null) _begin(img, d.localFocalPoint, d.pointerCount);
  }

  void _scaleUpdate(ScaleUpdateDetails d) {
    final img = _image;
    if (img == null) return;
    if (d.pointerCount != _fingers) {
      _begin(img, d.localFocalPoint, d.pointerCount);
      // A pinch measures its scale from where it began; a pinch that starts mid-gesture starts from the zoom of now.
      if (_pinching) _zoomAtPinch = _zoom / (d.scale == 0 ? 1 : d.scale);
      return;
    }
    if (_pinching) {
      final zoom = (_zoomAtPinch * d.scale).clamp(1.0, _maxZoom);
      final f = _fitted(img);
      // The point of the picture that was under the fingers stays under them.
      final pan = Offset(d.localFocalPoint.dx - f.left - _underFingers.dx * f.width * zoom, d.localFocalPoint.dy - f.top - _underFingers.dy * f.height * zoom);
      setState(() {
        _zoom = zoom;
        _pan = _keptOver(img, pan);
      });
    } else if (_panning) {
      setState(() => _pan = _keptOver(img, _pan + d.focalPointDelta));
    } else if (_grab != null) {
      final s = _shown(img);
      _drag(_grab!, d.focalPointDelta.dx / s.width, d.focalPointDelta.dy / s.height);
    }
  }

  void _scaleEnd(ScaleEndDetails d) {
    _grab = null;
    _panning = false;
    _pinching = false;
    _fingers = 0;
  }

  void _drag(_Grab g, double dx, double dy) {
    var l = _box.left, t = _box.top, r = _box.right, b = _box.bottom;
    switch (g) {
      case _Grab.move:
        final w = r - l, h = b - t;
        l = (l + dx).clamp(0.0, 1 - w);
        t = (t + dy).clamp(0.0, 1 - h);
        r = l + w;
        b = t + h;
      case _Grab.topLeft:
        l += dx;
        t += dy;
      case _Grab.top:
        t += dy;
      case _Grab.topRight:
        r += dx;
        t += dy;
      case _Grab.right:
        r += dx;
      case _Grab.bottomRight:
        r += dx;
        b += dy;
      case _Grab.bottom:
        b += dy;
      case _Grab.bottomLeft:
        l += dx;
        b += dy;
      case _Grab.left:
        l += dx;
    }
    l = l.clamp(0.0, r - _minW);
    r = r.clamp(l + _minW, 1.0);
    t = t.clamp(0.0, b - _minH);
    b = b.clamp(t + _minH, 1.0);
    setState(() => _box = Rect.fromLTRB(l, t, r, b));
  }

  /// A tap on a figure fits the box round it (the smallest figure under the finger, when one lies inside another).
  void _tap(TapUpDetails d) {
    final img = _image;
    if (img == null) return;
    final p = _onPicture(img, d.localPosition);
    FigureBox? hit;
    double area(FigureBox f) => (f[2] - f[0]) * (f[3] - f[1]);
    for (final f in _figs) {
      if (p.dx >= f[0] && p.dx <= f[2] && p.dy >= f[1] && p.dy <= f[3] && (hit == null || area(f) < area(hit))) hit = f;
    }
    if (hit != null) setState(() => _box = _rectOf(hit!));
  }

  void _use() {
    final img = _image;
    if (img == null) return;
    Navigator.of(context).pop(FigureCut(page: _page, image: img, box: [_box.left, _box.top, _box.right, _box.bottom], turns: _turns));
  }

  @override
  Widget build(BuildContext context) {
    final img = _image;
    return Scaffold(
      body: SafeArea(
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(gutter, 8, gutter, 0),
            child: Row(children: [
              CircleBtn(icon: Ph.arrowLeft, label: 'Back', onTap: () => Navigator.of(context).pop()),
              const SizedBox(width: 14),
              Expanded(child: Fig('Cut the figure', style: sectionStyle)),
              if (widget.offerPhoto) TextAction('Use a photo', color: ink, onTap: () => Navigator.of(context).pop(FigureCutScreen.usePhoto)),
            ]),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(gutter, 10, gutter, 8),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Fig(
                _figs.isEmpty
                    ? 'Drag the corners so the box holds only the figure. Pinch to zoom in.'
                    : 'Tap a figure to put the box round it, or drag the corners. Pinch to zoom in.',
                style: bodyStyle.copyWith(color: muted),
              ),
            ),
          ),
          if (widget.pages > 1)
            Padding(
              padding: const EdgeInsets.fromLTRB(gutter, 0, gutter, 8),
              child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                CircleBtn(icon: Ph.caretLeft, size: 36, label: 'Page before', onTap: _page > 1 ? () => _open(_page - 1) : null),
                const SizedBox(width: 14),
                Fig('Page $_page of ${widget.pages}', style: labelStyle.copyWith(color: ink, fontWeight: FontWeight.w700)),
                const SizedBox(width: 14),
                CircleBtn(icon: Ph.caretRight, size: 36, label: 'Next page', onTap: _page < widget.pages ? () => _open(_page + 1) : null),
              ]),
            ),
          Expanded(
            child: img == null
                ? Center(child: Fig(_failed ? 'The page did not load.' : 'Loading the page', style: bodyStyle.copyWith(color: muted)))
                : Padding(
                    padding: const EdgeInsets.symmetric(horizontal: gutter),
                    child: LayoutBuilder(builder: (context, c) {
                      _area = Size(c.maxWidth, c.maxHeight);
                      return ClipRect(
                        child: GestureDetector(
                          behavior: HitTestBehavior.opaque,
                          onScaleStart: _scaleStart,
                          onScaleUpdate: _scaleUpdate,
                          onScaleEnd: _scaleEnd,
                          onTapUp: _tap,
                          child: CustomPaint(
                            size: _area,
                            painter: _CutPainter(img, _shown(img), _onScreen(img, _box), [for (final f in _figs) _onScreen(img, _rectOf(f))]),
                          ),
                        ),
                      );
                    }),
                  ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(gutter, 12, gutter, 12),
            child: Row(children: [
              SecondaryButton('Turn', icon: Ph.arrowClockwise, onTap: img == null ? null : _turn),
              const SizedBox(width: 10),
              Expanded(child: PrimaryButton('Use this cut', icon: Ph.scissors, onTap: img == null ? null : _use)),
            ]),
          ),
        ]),
      ),
    );
  }
}

class _CutPainter extends CustomPainter {
  _CutPainter(this.image, this.shown, this.box, this.figures);
  final ui.Image image;

  /// Where the picture is drawn, the box, and the figures found, all in the painter's pixels.
  final Rect shown;
  final Rect box;
  final List<Rect> figures;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawImageRect(image, Rect.fromLTWH(0, 0, image.width.toDouble(), image.height.toDouble()), shown, Paint()..filterQuality = FilterQuality.medium);
    // The figures the app found, outlined lightly: a tap on one fits the box round it.
    final outline = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5
      ..color = const Color(0xB3707078);
    for (final f in figures) {
      _dashed(canvas, f, outline);
    }
    // Everything outside the box is dimmed, so what will be cut stands out.
    final outside = Path.combine(PathOperation.difference, Path()..addRect(Offset.zero & size), Path()..addRect(box));
    canvas.drawPath(outside, Paint()..color = const Color(0x73000000));
    canvas.drawRect(box, Paint()..style = PaintingStyle.stroke..strokeWidth = 2..color = aiAccent);
    for (final h in [box.topLeft, box.topCenter, box.topRight, box.centerRight, box.bottomRight, box.bottomCenter, box.bottomLeft, box.centerLeft]) {
      canvas.drawCircle(h, 8, Paint()..color = Colors.white);
      canvas.drawCircle(h, 8, Paint()..style = PaintingStyle.stroke..strokeWidth = 2..color = aiAccent);
    }
  }

  static void _dashed(Canvas canvas, Rect r, Paint paint) {
    const dash = 6.0, gap = 4.0;
    void line(Offset a, Offset b) {
      final length = (b - a).distance;
      final dir = (b - a) / (length == 0 ? 1 : length);
      for (var s = 0.0; s < length; s += dash + gap) {
        canvas.drawLine(a + dir * s, a + dir * math.min(s + dash, length), paint);
      }
    }

    line(r.topLeft, r.topRight);
    line(r.topRight, r.bottomRight);
    line(r.bottomRight, r.bottomLeft);
    line(r.bottomLeft, r.topLeft);
  }

  @override
  bool shouldRepaint(_CutPainter old) => old.image != image || old.shown != shown || old.box != box || old.figures.length != figures.length;
}
