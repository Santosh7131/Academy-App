import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:image/image.dart' as im;
import 'package:path_provider/path_provider.dart';
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;
import 'package:share_plus/share_plus.dart';

import '../../core/api.dart';
import '../../core/format.dart' as f;
import '../../core/levels.dart';
import '../../core/session.dart';
import '../../core/web_bits.dart' show saveOrShareFile, savesFiles;
import '../../theme.dart';
import '../../ui/kit.dart';
import '../../ui/math_text.dart';
import 'common.dart';

// A4 in PDF points. A point is a logical pixel here: a page is drawn 595 by 842 and saved at three pixels a point.
const _pageW = 595.0;
const _pageH = 842.0;
const _margin = 40.0;
const _contentW = _pageW - 2 * _margin;
const _footerH = 24.0;
const _contentH = _pageH - 2 * _margin - _footerH;
const _gap = 14.0;
const _pixelRatio = 3.0;

/// The most room a figure takes on a page, in points.
const _figureW = 300.0;
const _figureH = 220.0;

/// The answer key lists this many answers a row, and goes in blocks of this many rows (a long key can turn a page).
const _keyColumns = 5;
const _keyRowsABlock = 10;

/// A test as a PDF to print, for students without a phone or a written exam. The tuition's name heads the first page;
/// the questions are drawn by the app's own widgets, so maths, tables, figures, Hindi and Tamil come out as on screen
/// (each page goes into the PDF as a picture). No question is split across pages, and the answer key has a page of its
/// own at the end. The tutor sees the pages before sharing them.
class PrintTestScreen extends StatefulWidget {
  const PrintTestScreen({super.key, required this.id});

  final String id;

  /// Around each page, so the screenshot tests can save the very pages that go into the PDF.
  static ValueKey<String> pageKey(int i) => ValueKey('print-page-$i');

  /// On what a page holds above its foot, which has [contentHeight] to fit in.
  static ValueKey<String> contentKey(int i) => ValueKey('print-content-$i');
  static const contentHeight = _contentH;

  /// On a page whose one question is taller than a page, drawn smaller to fit it.
  static ValueKey<String> shrunkKey(int i) => ValueKey('print-shrunk-$i');

  @override
  State<PrintTestScreen> createState() => _PrintTestScreenState();
}

/// Puts blocks on pages in order, none split: a block that does not fit what is left of a page starts the next one,
/// and so does a block that must start a page. A block taller than a page has a page to itself.
List<List<int>> paginate(List<double> heights, List<bool> startsPage, {double room = _contentH, double gap = _gap}) {
  final pages = <List<int>>[[]];
  var used = 0.0;
  for (var i = 0; i < heights.length; i++) {
    final page = pages.last;
    final need = page.isEmpty ? heights[i] : used + gap + heights[i];
    if (page.isNotEmpty && (startsPage[i] || need > room)) {
      pages.add([i]);
      used = heights[i];
    } else {
      page.add(i);
      used = need;
    }
  }
  return pages;
}

/// The pages as an A4 PDF, each page a picture three pixels a point. The pictures go in as JPEG, which a PDF keeps as
/// it is: a long test stays small, in the phone's memory while it is made and in the chat it is sent through.
Future<Uint8List> testPdf(List<RenderRepaintBoundary> pages, {required String title, required String author}) async {
  final doc = pw.Document(title: title, author: author, creator: author);
  for (final page in pages) {
    final image = await page.toImage(pixelRatio: _pixelRatio);
    final (w, h) = (image.width, image.height);
    final rgba = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
    image.dispose();
    // On another thread: a page takes the phone a moment, and the screen keeps answering meanwhile.
    final jpeg = await compute(_jpegOf, (rgba!.buffer.asUint8List(rgba.offsetInBytes, rgba.lengthInBytes), w, h));
    doc.addPage(pw.Page(
      pageFormat: PdfPageFormat.a4,
      margin: pw.EdgeInsets.zero,
      build: (_) => pw.Image(pw.MemoryImage(jpeg), fit: pw.BoxFit.fill, width: PdfPageFormat.a4.width, height: PdfPageFormat.a4.height),
    ));
  }
  return doc.save();
}

Uint8List _jpegOf((Uint8List, int, int) page) {
  final (rgba, w, h) = page;
  final image = im.Image.fromBytes(width: w, height: h, bytes: rgba.buffer, bytesOffset: rgba.offsetInBytes, numChannels: 4, order: im.ChannelOrder.rgba);
  return im.encodeJpg(image, quality: 90, chroma: im.JpegChroma.yuv420);
}

/// A figure as a page draws it: decoded no larger than a saved page needs, and the room it takes on the page.
typedef _Figure = ({ui.Image image, Size size});

Future<_Figure> _decodeFigure(Uint8List bytes) async {
  var size = Size.zero;
  try {
    final buffer = await ui.ImmutableBuffer.fromUint8List(bytes);
    final codec = await ui.instantiateImageCodecWithSize(buffer, getTargetSize: (w, h) {
      // On the page: a pixel a point, made smaller to fit the room but never larger.
      final fit = math.min(1.0, math.min(_figureW / w, _figureH / h));
      size = Size(w * fit, h * fit);
      // In memory: as many pixels as the saved page shows of it, and never more than the picture has.
      final keep = math.min(1.0, math.min(_figureW * _pixelRatio / w, _figureH * _pixelRatio / h));
      return ui.TargetImageSize(width: math.max(1, (w * keep).round()), height: math.max(1, (h * keep).round()));
    });
    try {
      return (image: (await codec.getNextFrame()).image, size: size);
    } finally {
      codec.dispose();
    }
  } catch (_) {
    throw ApiException(0, 'bad_figure', "A figure in this test could not be opened. Try again, or look at that question's figure.");
  }
}

/// One part of a page: the heading, a question, or a part of the answer key.
class _Block {
  const _Block(this.child, {this.startsPage = false});

  final Widget child;
  final bool startsPage;
}

class _PrintTestScreenState extends State<PrintTestScreen> {
  Map<String, dynamic>? _test;
  List<Map<String, dynamic>> _questions = const [];
  final _figures = <String, _Figure>{};
  String? _error;

  /// Off to begin with: a PDF sent on to students or a print shop must not carry the answers unless the tutor asks for them.
  var _withKey = false;
  var _sharing = false;

  // Measured once laid out off screen, then put on pages.
  List<GlobalKey>? _measureKeys;
  List<double> _heights = const [];
  List<List<int>>? _pages;
  List<GlobalKey> _pageKeys = const [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _forgetFigures();
    super.dispose();
  }

  void _forgetFigures() {
    for (final fig in _figures.values) {
      fig.image.dispose();
    }
    _figures.clear();
  }

  Future<void> _load() async {
    final figures = <String, _Figure>{};
    try {
      final d = Map<String, dynamic>.from(await api.get('/teacher/tests/${widget.id}'));
      final questions = (d['questions'] as List).cast<Map<String, dynamic>>();
      // The figures come first, four at a time: a page is measured and drawn with them in it.
      final withFigure = [for (final q in questions) if ('${q['image_url'] ?? ''}'.isNotEmpty) q];
      for (var i = 0; i < withFigure.length; i += 4) {
        await Future.wait([
          for (final q in withFigure.skip(i).take(4))
            api.getBytes('${q['image_url']}').then((bytes) async {
              figures['${q['id']}'] = await _decodeFigure(bytes is Uint8List ? bytes : Uint8List.fromList(bytes));
            }),
        ]);
      }
      if (!mounted) {
        for (final fig in figures.values) {
          fig.image.dispose();
        }
        return;
      }
      setState(() {
        _forgetFigures();
        _figures.addAll(figures);
        _test = Map<String, dynamic>.from(d['test']);
        _questions = questions;
        _error = null;
      });
      _layOut();
    } on ApiException catch (e) {
      for (final fig in figures.values) {
        fig.image.dispose();
      }
      if (mounted) setState(() => _error = e.message);
    }
  }

  /// Lays every block out at the page's width, off screen, to measure it; the pages are made from the heights.
  void _layOut() {
    setState(() {
      _pages = null;
      _measureKeys = [for (final _ in _blocks(_test!)) GlobalKey()];
    });
    _measureAfterFrame(tries: 3);
  }

  void _measureAfterFrame({required int tries}) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final keys = _measureKeys;
      if (!mounted || keys == null) return;
      final sizes = [for (final k in keys) k.currentContext?.size];
      if (sizes.contains(null) && tries > 0) {
        _measureAfterFrame(tries: tries - 1);
        WidgetsBinding.instance.scheduleFrame();
        return;
      }
      final starts = [for (final b in _blocks(_test!)) b.startsPage];
      setState(() {
        _heights = [for (final s in sizes) s?.height ?? 0];
        _pages = paginate(_heights, starts);
        _pageKeys = [for (final _ in _pages!) GlobalKey()];
        _measureKeys = null;
      });
    });
  }

  List<_Block> _blocks(Map<String, dynamic> t) {
    final marks = [for (final q in _questions) (q['marks'] as num?) ?? 1];
    final sameMarks = marks.toSet().length <= 1;
    final texts = [for (final q in _questions) '${q['text'] ?? ''}'];
    final passages = [for (final s in texts) passageOf(s)];
    bool sameAs(int i, int j) => j >= 0 && j < passages.length && passages[j]?.passage == passages[i]!.passage;
    Widget question(int i) {
      final q = _questions[i];
      final p = passages[i];
      // A case study's questions each carry its passage: it is printed once, above the first of them, and each shows its own question.
      final shared = p != null && (sameAs(i, i - 1) || sameAs(i, i + 1));
      final drawn = _Question(n: i + 1, q: q, text: shared ? p.question : texts[i], figure: _figures['${q['id']}'], marks: sameMarks ? null : marks[i]);
      if (!shared || sameAs(i, i - 1)) return drawn;
      var last = i;
      while (sameAs(i, last + 1)) {
        last++;
      }
      // One block with the first question, so a passage never ends a page without a question of its own under it.
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        _Passage(text: p.passage, from: i + 1, to: last + 1),
        const SizedBox(height: _gap),
        drawn,
      ]);
    }

    return [
      _Block(_Heading(test: t, questions: _questions.length, marks: marks.fold<num>(0, (a, b) => a + b))),
      for (var i = 0; i < _questions.length; i++) _Block(question(i)),
      if (_withKey) ...[
        _Block(_KeyTitle(title: '${t['title']}'), startsPage: true),
        for (var from = 0; from < _questions.length; from += _keyColumns * _keyRowsABlock)
          _Block(_KeyRows(questions: _questions, from: from, count: _keyColumns * _keyRowsABlock)),
      ],
    ];
  }

  Future<void> _share(Map<String, dynamic> t) async {
    setState(() => _sharing = true);
    try {
      final pages = [for (final k in _pageKeys) k.currentContext?.findRenderObject()];
      if (pages.any((p) => p is! RenderRepaintBoundary)) throw StateError('A page is not drawn yet.');
      final bytes = await testPdf(pages.cast<RenderRepaintBoundary>(), title: '${t['title']}', author: session.tuitionName);
      var name = '${t['title']}'.replaceAll(RegExp(r'[\\/:*?"<>|\r\n]'), '').trim();
      if (name.length > 80) name = name.substring(0, 80).trim();
      // Named for what it holds, so the copy with the answers is not sent to students by mistake.
      final fileName = '${name.isEmpty ? 'Test' : name}${_withKey ? ' with answer key' : ''}.pdf';
      final text = '${t['title']}, from ${session.tuitionName}.';
      if (kIsWeb) {
        await saveOrShareFile(bytes, name: fileName, mimeType: 'application/pdf', text: text);
        return;
      }
      final dir = await getTemporaryDirectory();
      final file = File('${dir.path}/$fileName');
      await file.writeAsBytes(bytes, flush: true);
      await SharePlus.instance.share(ShareParams(files: [XFile(file.path, mimeType: 'application/pdf')], text: text));
    } catch (e) {
      if (mounted) await showProblem(context, e);
    } finally {
      if (mounted) setState(() => _sharing = false);
    }
  }

  /// Drawn at the page's own size whatever the phone's text settings, so what is measured is what is printed.
  Widget _paper(Widget child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(textScaler: TextScaler.noScaling, boldText: false),
        child: LightPaper(child: child),
      );

  @override
  Widget build(BuildContext context) {
    final t = _test;
    final pages = _pages;
    final blocks = t == null ? const <_Block>[] : _blocks(t);
    return PushedPanel(
      kicker: t == null ? 'Test' : '${t['title']}',
      title: 'Print',
      footer: PrimaryButton(
        savesFiles ? 'Save as PDF' : 'Share as PDF',
        icon: Ph.filePdf,
        busy: _sharing,
        onTap: t == null || pages == null || _questions.isEmpty || _sharing ? null : () => _share(t),
      ),
      children: [
        const SizedBox(height: 18),
        if (t == null && _error != null)
          ErrorState(
            message: _error!,
            onRetry: () {
              setState(() => _error = null);
              _load();
            },
          )
        else if (t == null)
          const LoadingState(rows: 4)
        else if (_questions.isEmpty)
          Text('This test has no questions yet.', style: bodyStyle.copyWith(color: muted))
        else ...[
          SegmentedToggle(
            labels: const ['Questions only', 'With answer key'],
            index: _withKey ? 1 : 0,
            onChanged: (i) {
              // Not while the PDF is being made from the pages on screen.
              if (_sharing || (i == 1) == _withKey) return;
              setState(() => _withKey = i == 1);
              _layOut();
            },
          ),
          const SizedBox(height: 16),
          // One child of the list, so every page is laid out and drawn wherever the list is scrolled to: the PDF is
          // made from them.
          Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            // Laid out, not drawn: only to measure each block at the page's width.
            if (_measureKeys != null)
              Offstage(
                child: FittedBox(
                  child: _paper(SizedBox(
                    width: _contentW,
                    child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
                      for (final (i, b) in blocks.indexed) KeyedSubtree(key: _measureKeys![i], child: b.child),
                    ]),
                  )),
                ),
              ),
            if (pages == null)
              const LoadingState(rows: 3)
            else
              for (final (i, page) in pages.indexed) ...[
                if (i > 0) const SizedBox(height: 14),
                DecoratedBox(
                  position: DecorationPosition.foreground,
                  decoration: BoxDecoration(border: Border.all(color: faint), borderRadius: BorderRadius.circular(rSmall)),
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(rSmall),
                    child: FittedBox(
                      fit: BoxFit.fitWidth,
                      child: KeyedSubtree(
                        key: PrintTestScreen.pageKey(i),
                        child: RepaintBoundary(
                          key: _pageKeys[i],
                          child: _paper(_Page(
                            index: i,
                            blocks: [for (final b in page) blocks[b].child],
                            tooTall: page.length == 1 && _heights[page.first] > _contentH,
                            foot: '${session.tuitionName} · ${t['title']}',
                            of: pages.length,
                          )),
                        ),
                      ),
                    ),
                  ),
                ),
              ],
          ]),
          const SizedBox(height: 12),
          Text('A4 pages, white whatever your phone shows.', style: bodyStyle.copyWith(color: muted)),
        ],
      ],
    );
  }
}

TextStyle get _qStyle => bodyStyle.copyWith(color: LightPaper.ink, fontSize: 12, height: 1.4);
TextStyle get _optStyle => bodyStyle.copyWith(color: LightPaper.ink, fontSize: 11.5, height: 1.35);
TextStyle get _small => labelStyle.copyWith(color: LightPaper.muted, fontSize: 9);

/// One A4 page: its blocks from the top, and the tuition, the test and the page number at the foot.
class _Page extends StatelessWidget {
  const _Page({required this.index, required this.blocks, required this.tooTall, required this.foot, required this.of});

  final int index;
  final List<Widget> blocks;
  final bool tooTall;
  final String foot;
  final int of;

  @override
  Widget build(BuildContext context) {
    final content = Column(key: PrintTestScreen.contentKey(index), crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
      for (final (i, b) in blocks.indexed) ...[if (i > 0) const SizedBox(height: _gap), b],
    ]);
    return SizedBox(
      width: _pageW,
      height: _pageH,
      child: ColoredBox(
        color: LightPaper.page,
        child: Padding(
          padding: const EdgeInsets.all(_margin),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            SizedBox(
              height: _contentH,
              // A question taller than a page (a very big figure) is shrunk to fit its page; anything else fits as
              // measured, and is held to the page if a fraction of a point is left over.
              child: tooTall
                  ? FittedBox(
                      key: PrintTestScreen.shrunkKey(index),
                      fit: BoxFit.contain,
                      alignment: Alignment.topLeft,
                      child: SizedBox(width: _contentW, child: content),
                    )
                  : ClipRect(
                      child: OverflowBox(alignment: Alignment.topCenter, minHeight: 0, maxHeight: double.infinity, child: content),
                    ),
            ),
            SizedBox(
              height: _footerH,
              child: Align(
                alignment: Alignment.bottomCenter,
                child: Row(children: [
                  Expanded(child: Text(foot, style: _small, maxLines: 1, overflow: TextOverflow.ellipsis)),
                  const SizedBox(width: 12),
                  Text('Page ${index + 1} of $of', style: _small),
                ]),
              ),
            ),
          ]),
        ),
      ),
    );
  }
}

/// A line to write on.
class _WriteLine extends StatelessWidget {
  const _WriteLine();

  @override
  Widget build(BuildContext context) => const Padding(
        padding: EdgeInsets.only(top: 12),
        child: SizedBox(height: 0.8, child: ColoredBox(color: LightPaper.line)),
      );
}

/// The top of the first page: the tuition's name, the test, its time and marks, and lines for the name and date.
class _Heading extends StatelessWidget {
  const _Heading({required this.test, required this.questions, required this.marks});

  final Map<String, dynamic> test;
  final int questions;
  final num marks;

  @override
  Widget build(BuildContext context) {
    final t = test;
    final who = t['course_id'] != null
        ? '${t['course'] ?? 'Course'}'
        : t['subject'] == null
            ? className(t['class_level'])
            : groupName(t['class_level'] as int, '${t['subject']}');
    final facts = [
      f.count(questions, 'question'),
      '${f.marks(marks)} ${marks == 1 ? 'mark' : 'marks'}',
      if (t['time_limit_min'] != null) '${t['time_limit_min']} minutes',
    ].join(' · ');
    final line = bodyStyle.copyWith(color: LightPaper.ink, fontSize: 11);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text(session.tuitionName.toUpperCase(),
          textAlign: TextAlign.center, style: kickerStyle.copyWith(color: LightPaper.ink, fontSize: 17, fontWeight: FontWeight.w700, letterSpacing: 1.4)),
      const SizedBox(height: 6),
      Text('${t['title']}', textAlign: TextAlign.center, style: sectionStyle.copyWith(color: LightPaper.ink, fontSize: 14)),
      const SizedBox(height: 3),
      Text([if (who.isNotEmpty) who, facts].join(' · '), textAlign: TextAlign.center, style: bodyStyle.copyWith(color: LightPaper.body, fontSize: 10.5)),
      const SizedBox(height: 14),
      Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        Text('Name', style: line),
        const SizedBox(width: 8),
        const Expanded(flex: 3, child: _WriteLine()),
        const SizedBox(width: 22),
        Text('Date', style: line),
        const SizedBox(width: 8),
        const Expanded(child: _WriteLine()),
      ]),
      const SizedBox(height: 14),
      const SizedBox(height: 0.8, child: ColoredBox(color: LightPaper.ink)),
    ]);
  }
}

/// A case study's passage, printed once above its questions.
class _Passage extends StatelessWidget {
  const _Passage({required this.text, required this.from, required this.to});

  final String text;
  final int from;
  final int to;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(left: 26),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Read this and answer questions $from to $to.', style: _optStyle.copyWith(color: LightPaper.body, fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          MathText(text, style: _qStyle),
        ]),
      );
}

/// One question: its number, its words, its figure, and its options: four to a row when they are a few characters
/// each, two when they are short, one a row otherwise.
class _Question extends StatelessWidget {
  const _Question({required this.n, required this.q, required this.text, this.figure, this.marks});

  final int n;
  final Map<String, dynamic> q;

  /// Its words: all of them, or without the passage when that is printed above.
  final String text;
  final _Figure? figure;

  /// Shown beside the question only when the questions do not all carry the same marks.
  final num? marks;

  @override
  Widget build(BuildContext context) {
    final options = [for (final o in (q['options'] as List? ?? const [])) '$o'];
    final lengths = [for (final o in options) o.contains('\n') || o.contains('|') ? 999 : plainMath(o).length];
    final perRow = options.length <= 4 && lengths.every((l) => l <= 10)
        ? 4
        : options.length <= 6 && lengths.every((l) => l <= 30)
            ? 2
            : 1;
    // On the line of the text, so a letter sits level with the fraction bar or the formula beside it.
    Widget option(int i) => Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
          SizedBox(width: 22, child: Text('(${String.fromCharCode(97 + i)})', style: _optStyle)),
          // Display style, as the app shows options: fractions full size.
          Expanded(child: MathText(options[i], style: _optStyle, display: true)),
        ]);
    final fig = figure;
    return Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
      SizedBox(width: 26, child: Text('$n.', style: _qStyle.copyWith(fontWeight: FontWeight.w600))),
      Expanded(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          MathText(text, style: _qStyle),
          if (fig != null) ...[
            const SizedBox(height: 8),
            Align(
              child: SizedBox(
                width: fig.size.width,
                height: fig.size.height,
                child: RawImage(image: fig.image, fit: BoxFit.fill, filterQuality: FilterQuality.medium),
              ),
            ),
          ],
          if (options.isNotEmpty) ...[
            const SizedBox(height: 7),
            for (var i = 0; i < options.length; i += perRow)
              Padding(
                padding: const EdgeInsets.only(top: 3),
                child: Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
                  for (var c = 0; c < perRow; c++) ...[
                    if (c > 0) const SizedBox(width: 12),
                    Expanded(child: i + c < options.length ? option(i + c) : const SizedBox.shrink()),
                  ],
                ]),
              ),
          ],
        ]),
      ),
      if (marks != null) ...[
        const SizedBox(width: 8),
        Text('[${f.marks(marks!)}]', style: _optStyle.copyWith(color: LightPaper.body)),
      ],
    ]);
  }
}

/// The answer key's heading, at the top of a page of its own.
class _KeyTitle extends StatelessWidget {
  const _KeyTitle({required this.title});

  final String title;

  @override
  Widget build(BuildContext context) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text(session.tuitionName.toUpperCase(),
            textAlign: TextAlign.center, style: kickerStyle.copyWith(color: LightPaper.ink, fontSize: 13, fontWeight: FontWeight.w700, letterSpacing: 1.2)),
        const SizedBox(height: 6),
        Text('Answer key', textAlign: TextAlign.center, style: sectionStyle.copyWith(color: LightPaper.ink, fontSize: 15)),
        const SizedBox(height: 3),
        Text(title, textAlign: TextAlign.center, style: bodyStyle.copyWith(color: LightPaper.body, fontSize: 10.5)),
        const SizedBox(height: 12),
        const SizedBox(height: 0.8, child: ColoredBox(color: LightPaper.ink)),
      ]);
}

/// Some rows of the answer key: each question's number and its right option's letter.
class _KeyRows extends StatelessWidget {
  const _KeyRows({required this.questions, required this.from, required this.count});

  final List<Map<String, dynamic>> questions;
  final int from;
  final int count;

  @override
  Widget build(BuildContext context) {
    final to = math.min(from + count, questions.length);
    String answer(int i) {
      final c = questions[i]['correct_option'];
      return c is int ? '(${String.fromCharCode(97 + c)})' : 'not marked';
    }

    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      for (var r = from; r < to; r += _keyColumns)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(children: [
            for (var c = 0; c < _keyColumns; c++)
              Expanded(
                child: r + c < to
                    ? Text.rich(TextSpan(children: [
                        TextSpan(text: '${r + c + 1}. ', style: _optStyle.copyWith(color: LightPaper.body)),
                        TextSpan(text: answer(r + c), style: _optStyle.copyWith(fontWeight: FontWeight.w600)),
                      ]))
                    : const SizedBox.shrink(),
              ),
          ]),
        ),
    ]);
  }
}
