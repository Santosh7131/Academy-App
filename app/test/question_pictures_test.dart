// The pictures of a paper's pages and what is done with them: where a question or a figure sits on a page, the page loaded once, a
// figure cut out of it, the question shown "from your paper" beside what AI typed, the box dragged to cut a figure again, and the
// editor that opens with the picture on top and symbols to tap. Pages are made-up PNGs with coloured blocks (test/support/page_images.dart).
//   flutter test test/question_pictures_test.dart
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:tuition_app/features/teacher/page_pictures.dart';
import 'package:tuition_app/features/teacher/papers_screens.dart' show DraftEditor;
import 'package:tuition_app/ui/icons.dart';
import 'package:tuition_app/ui/kit.dart' show Pressable;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image_picker/image_picker.dart' show ImageSource;

import 'support/page_images.dart';

/// A made-up paper: page 1 has a red block (a figure) low on the page, page 2 a blue one at its top.
Future<FakePages> _pages(WidgetTester t, {Map<int, List<Block>>? blocks}) async {
  final spec = blocks ??
      {
        1: [(box: const [0.1, 0.8, 0.9, 0.95], color: red)],
        2: [(box: const [0.1, 0.05, 0.9, 0.2], color: blue)],
      };
  final pages = <int, Uint8List>{};
  for (final e in spec.entries) {
    pages[e.key] = (await t.runAsync(() => pagePng(blocks: e.value)))!;
  }
  final fake = FakePages(pages);
  await t.runAsync(fake.warm);
  return fake;
}

/// What a screen opened with a push gave back.
class _Opened {
  Object? result;
  bool closed = false;
}

/// Opens [screen] on top of a first page, as the review screen does, and keeps what it gives back.
Future<_Opened> _push(WidgetTester t, Widget screen, {Size view = const Size(1200, 4000)}) async {
  t.view.physicalSize = view;
  t.view.devicePixelRatio = 2;
  addTearDown(t.view.reset);
  final o = _Opened();
  await t.pumpWidget(MaterialApp(
    home: Builder(
      builder: (context) => Scaffold(
        body: Center(
          child: TextButton(
            onPressed: () async {
              o.result = await Navigator.of(context).push<Object>(MaterialPageRoute(builder: (_) => screen));
              o.closed = true;
            },
            child: const Text('open'),
          ),
        ),
      ),
    ),
  ));
  await t.tap(find.text('open'));
  await t.pump();
  await t.pump(const Duration(milliseconds: 400));
  await settle(t, rounds: 2);
  return o;
}

Future<void> _tap(WidgetTester t, Finder f) async {
  await t.ensureVisible(f);
  await t.tap(f);
  await t.pump();
  await t.pump(const Duration(milliseconds: 400));
}

/// The colour at fractions of a drawn widget, read from its picture. The widget must sit under a RepaintBoundary with [key].
Future<Color Function(double fx, double fy)> _grab(WidgetTester t, GlobalKey key) async {
  final grabbed = await t.runAsync(() async {
    final boundary = t.renderObject<RenderRepaintBoundary>(find.byKey(key));
    final img = await boundary.toImage(pixelRatio: 1);
    return (img.width, img.height, (await img.toByteData(format: ui.ImageByteFormat.rawRgba))!);
  });
  final (w, h, data) = grabbed!;
  return (fx, fy) {
    final col = (fx * w).floor().clamp(0, w - 1);
    final row = (fy * h).floor().clamp(0, h - 1);
    final at = (row * w + col) * 4;
    return Color.fromARGB(data.getUint8(at + 3), data.getUint8(at), data.getUint8(at + 1), data.getUint8(at + 2));
  };
}

Widget _wrap(Widget child) => MaterialApp(home: Scaffold(body: SingleChildScrollView(child: Padding(padding: const EdgeInsets.all(16), child: child))));

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  tearDown(forgetNetworkImages);

  group('boxes the server sends', () {
    test('a box is four numbers, the right way round', () {
      expect(pageBoxOf([0.1, 0.2, 0.5, 0.6]), [0.1, 0.2, 0.5, 0.6]);
      expect(pageBoxOf([0, 0, 1, 1]), [0.0, 0.0, 1.0, 1.0], reason: 'whole numbers are fine');
      expect(pageBoxOf([0.5, 0.2, 0.1, 0.6]), isNull, reason: 'left of right');
      expect(pageBoxOf([0.1, 0.6, 0.5, 0.2]), isNull, reason: 'top below bottom');
      expect(pageBoxOf([0.1, 0.2, 0.5]), isNull);
      expect(pageBoxOf(['a', 0.2, 0.5, 0.6]), isNull);
      expect(pageBoxOf('0.1,0.2,0.5,0.6'), isNull);
      expect(pageBoxOf(null), isNull);
    });

    test('a box on a page needs both', () {
      final at = placedOf({'page': 2, 'box': [0.1, 0.2, 0.5, 0.6]})!;
      expect(at.page, 2);
      expect(at.box, [0.1, 0.2, 0.5, 0.6]);
      expect(placedOf({'page': '2', 'box': [0.1, 0.2, 0.5, 0.6]}), isNull);
      expect(placedOf({'page': 2, 'box': [0.5, 0.2, 0.1, 0.6]}), isNull);
      expect(placedOf({'box': [0.1, 0.2, 0.5, 0.6]}), isNull);
      expect(placedOf(null), isNull);
    });

    test('a question is where its boxes are, one per page, and a damaged one is left out', () {
      final parts = questionParts({
        'question_boxes': [
          {'page': 1, 'box': [0.1, 0.8, 0.9, 0.95]},
          {'page': 2, 'box': 'nonsense'},
          {'page': 2, 'box': [0.1, 0.05, 0.9, 0.2]},
        ],
      });
      expect(parts.map((p) => p.page), [1, 2]);
      expect(questionParts({'question_boxes': null}), isEmpty);
      expect(questionParts({}), isEmpty);
    });

    test('a box that cannot be a question (a thin sliver) is given up, so the page is offered instead', () {
      expect(plausibleQuestionBox([0.08, 0.1, 0.92, 0.2]), isTrue);
      expect(plausibleQuestionBox([0.854, 0.115, 0.925, 0.956]), isFalse, reason: 'a model mixed up its numbers');
      expect(plausibleQuestionBox([0.1, 0.2, 0.9, 0.205]), isFalse, reason: 'a hairline');
      expect(questionParts({'question_boxes': [{'page': 1, 'box': [0.854, 0.115, 0.925, 0.956]}]}), isEmpty);
      expect(
        questionParts({'question_boxes': [{'page': 1, 'box': [0.08, 0.1, 0.92, 0.2]}, {'page': 2, 'box': [0.854, 0.115, 0.925, 0.956]}]}),
        isEmpty,
        reason: 'half a question would mislead',
      );
    });
  });

  group('the pages as pictures', () {
    test('a page is fetched once however often it is asked for', () async {
      final fake = FakePages({1: await pagePng()});
      final a = await fake.pictures.image(1);
      final b = await fake.pictures.image(1);
      expect(a, isNotNull);
      expect(identical(a, b), isTrue);
      expect(fake.fetched, [fake.url(1)]);
    });

    test('a page that cannot be loaded gives nothing, and asking again tries again', () async {
      final fake = FakePages({1: await pagePng()});
      fake.broken.add(fake.url(1));
      expect(await fake.pictures.image(1), isNull);
      fake.broken.clear();
      expect(await fake.pictures.image(1), isNotNull);
      expect(fake.fetched, hasLength(2));
    });

    test('a page without an address gives nothing and is not fetched', () async {
      final fake = FakePages({1: await pagePng()});
      expect(fake.pictures.url(7), isNull);
      expect(await fake.pictures.image(7), isNull);
      expect(fake.fetched, isEmpty);
    });

    test('pages not uploaded yet (no address) are not taken in', () async {
      final fake = FakePages({1: await pagePng(), 2: await pagePng()});
      final pics = PaperPictures(fetch: (_) async => null)..setPages(fake.rows(without: {2}));
      expect(pics.url(1), fake.url(1));
      expect(pics.url(2), isNull);
    });

    test('only the last four pages are kept, so a long paper does not fill the phone', () async {
      final fake = FakePages({for (var n = 1; n <= 5; n++) n: await pagePng(width: 60, height: 80)});
      for (var n = 1; n <= 5; n++) {
        await fake.pictures.image(n);
      }
      expect(fake.fetched, hasLength(5));
      await fake.pictures.image(5);
      expect(fake.fetched, hasLength(5), reason: 'the latest is still there');
      await fake.pictures.image(1);
      expect(fake.fetched, hasLength(6), reason: 'the first was let go and is fetched again');
    });

    test('a page whose address has run out is tried once more on a new address', () async {
      final png = await pagePng();
      final fetched = <String>[];
      var asked = 0;
      late PaperPictures pics;
      pics = PaperPictures(
        fetch: (u) async {
          fetched.add(u);
          return u.contains('new') ? png : null;
        },
        onStale: () async {
          asked++;
          pics.setPages([{'page_no': 1, 'image_url': 'https://pages.test/new1.png'}]);
        },
      )..setPages([{'page_no': 1, 'image_url': 'https://pages.test/old1.png'}]);
      expect(await pics.image(1), isNotNull);
      expect(asked, 1);
      expect(fetched, ['https://pages.test/old1.png', 'https://pages.test/new1.png']);
    });

    test('a page that will not load on its address and gets no new one gives nothing, after one more look only', () async {
      var asked = 0;
      final pics = PaperPictures(fetch: (_) async => null, onStale: () async => asked++)..setPages([{'page_no': 1, 'image_url': 'https://pages.test/p1.png'}]);
      expect(await pics.image(1), isNull);
      expect(asked, 1);
    });

    test('a screen that shows a page itself can ask for its new address, and keeps the old one when asking fails', () async {
      late PaperPictures pics;
      pics = PaperPictures(
        fetch: (_) async => null,
        onStale: () async => pics.setPages([{'page_no': 1, 'image_url': 'https://pages.test/new1.png'}]),
      )..setPages([{'page_no': 1, 'image_url': 'https://pages.test/old1.png'}]);
      expect(await pics.fresh(1), 'https://pages.test/new1.png');
      final offline = PaperPictures(fetch: (_) async => null, onStale: () async => throw StateError('offline'))..setPages([{'page_no': 1, 'image_url': 'https://pages.test/old1.png'}]);
      expect(await offline.fresh(1), 'https://pages.test/old1.png');
      expect(await PaperPictures(fetch: (_) async => null).fresh(4), isNull, reason: 'a page it has never heard of');
    });
  });

  group('cutting a figure out of a page', () {
    test('the cut holds the box and nothing else', () async {
      final png = await pagePng(blocks: [(box: const [0.2, 0.3, 0.6, 0.5], color: red)]);
      final page = await decodeImageFromList(png);
      final cut = (await cutOut(page, const [0.2, 0.3, 0.6, 0.5]))!;
      final size = await sizeOfPng(cut);
      expect(size.width, closeTo(240, 1));
      expect(size.height, closeTo(160, 1));
      expect(await pixelOfPng(cut, 0.5, 0.5), red);
      expect(await pixelOfPng(cut, 0.03, 0.03), red);
      expect(await pixelOfPng(cut, 0.97, 0.97), red);
    });

    test('a margin adds white room around it', () async {
      final png = await pagePng(blocks: [(box: const [0.2, 0.3, 0.6, 0.5], color: red)]);
      final page = await decodeImageFromList(png);
      final cut = (await cutOut(page, const [0.2, 0.3, 0.6, 0.5], margin: 0.01))!;
      final size = await sizeOfPng(cut);
      expect(size.width, closeTo(252, 1));
      expect(size.height, closeTo(172, 1));
      expect(await pixelOfPng(cut, 0.0, 0.0), white);
      expect(await pixelOfPng(cut, 0.5, 0.5), red);
    });

    test('a margin stops at the page edge', () async {
      final png = await pagePng(blocks: [(box: const [0.0, 0.0, 0.2, 0.2], color: red)]);
      final page = await decodeImageFromList(png);
      final cut = (await cutOut(page, const [0.0, 0.0, 0.2, 0.2], margin: 0.01))!;
      final size = await sizeOfPng(cut);
      expect(size.width, closeTo(126, 1), reason: 'only the margin on the inside');
      expect(await pixelOfPng(cut, 0.0, 0.0), red, reason: 'the corner of the page is the corner of the cut');
    });
  });

  group('the question as it is printed', () {
    testWidgets('a piece of a page shows the question box with a little room around it', (t) async {
      final fake = await _pages(t);
      final key = GlobalKey();
      await t.pumpWidget(MaterialApp(
        home: Scaffold(
          body: Align(
            alignment: Alignment.topLeft,
            child: SizedBox(width: 300, child: RepaintBoundary(key: key, child: PagePiece(pictures: fake.pictures, page: 1, box: const [0.1, 0.8, 0.9, 0.95]))),
          ),
        ),
      ));
      await settle(t, rounds: 2);
      final at = await _grab(t, key);
      expect(at(0.5, 0.5), red, reason: 'the box');
      expect(at(0.5, 0.01), white, reason: 'room above it');
      expect(at(0.003, 0.5), white, reason: 'room beside it');
      expect(find.text('Loading the page'), findsNothing);
    });

    testWidgets('a page that did not load says so, and a tap tries again', (t) async {
      final fake = await _pages(t);
      fake.pictures.setPages([
        {'page_no': 3, 'image_url': fake.url(3)},
      ]);
      fake.broken.add(fake.url(3));
      await t.pumpWidget(_wrap(PagePiece(pictures: fake.pictures, page: 3, box: const [0.1, 0.1, 0.9, 0.3])));
      expect(find.text('Loading the page'), findsOneWidget);
      await t.pump();
      expect(find.text('The page did not load. Tap to try again.'), findsOneWidget);
      // The page comes back (decoded here on the real loop; asking again finds it ready).
      fake.broken.clear();
      fake.pages[3] = (await t.runAsync(() => pagePng()))!;
      await t.runAsync(() => fake.pictures.image(3));
      await t.tap(find.text('The page did not load. Tap to try again.'));
      await settle(t, rounds: 2);
      expect(find.text('The page did not load. Tap to try again.'), findsNothing);
      expect(find.byType(AspectRatio), findsOneWidget, reason: 'the piece is drawn');
    });

    testWidgets('"From your paper" shows each page the question is on, with the pages named', (t) async {
      final fake = await _pages(t);
      final opened = <int>[];
      await t.pumpWidget(_wrap(FromYourPaper(
        pictures: fake.pictures,
        parts: [
          (page: 1, box: const [0.1, 0.8, 0.9, 0.95]),
          (page: 2, box: const [0.1, 0.05, 0.9, 0.2]),
        ],
        onWholePage: opened.add,
      )));
      await settle(t, rounds: 2);
      expect(find.text('FROM YOUR PAPER'), findsOneWidget);
      expect(find.byType(PagePiece), findsNWidgets(2));
      expect(find.text('pages 1 and 2'), findsOneWidget);
      expect(find.text('page 2'), findsOneWidget, reason: 'the line between the two parts');
      await t.tap(find.text('See the whole page'));
      expect(opened, [1]);
    });

    testWidgets('a question on one page says "page 3"', (t) async {
      final fake = await _pages(t, blocks: {3: [(box: const [0.1, 0.1, 0.9, 0.3], color: red)]});
      await t.pumpWidget(_wrap(FromYourPaper(pictures: fake.pictures, parts: [(page: 3, box: const [0.1, 0.1, 0.9, 0.3])], onWholePage: (_) {})));
      await settle(t, rounds: 2);
      expect(find.text('page 3'), findsOneWidget);
      expect(find.byType(PagePiece), findsOneWidget);
    });
  });

  group('a figure cut from a page', () {
    testWidgets('shows the picture, where it came from, and what can be done to it', (t) async {
      final fake = await _pages(t);
      await cacheNetworkImage(t, 'https://figs.test/f1.png', fake.pages[1]!);
      var again = 0, removed = 0;
      await t.pumpWidget(_wrap(CutFigure(url: 'https://figs.test/f1.png', caption: 'From page 1', onCutAgain: () => again++, onRemove: () => removed++)));
      await t.pump();
      expect(find.text('FROM PAGE 1'), findsOneWidget);
      expect(find.byType(Image), findsOneWidget);
      await t.tap(find.text('Cut again'));
      await t.tap(find.text('Remove'));
      expect([again, removed], [1, 1]);
    });

    testWidgets('a photo cannot be cut again from a page, so only Remove is offered', (t) async {
      await t.pumpWidget(_wrap(CutFigure(url: 'https://figs.test/photo.png', caption: 'Your photo', onRemove: () {})));
      expect(find.text('YOUR PHOTO'), findsOneWidget);
      expect(find.text('Cut again'), findsNothing);
      expect(find.text('Remove'), findsOneWidget);
    });

    testWidgets('a figure being cut cannot be changed meanwhile', (t) async {
      await t.pumpWidget(_wrap(const CutFigure(url: 'https://figs.test/photo.png', caption: 'From page 1')));
      expect(find.text('Cut again'), findsNothing);
      expect(find.text('Remove'), findsNothing);
    });
  });

  group('the whole page', () {
    testWidgets('a page that will not load says so, and a tap tries again on a new address', (t) async {
      final fake = await _pages(t);
      await cacheNetworkImage(t, fake.url(2), fake.pages[2]!);
      var asked = 0;
      await _push(t, WholePageScreen(url: 'https://pages.test/expired.png', n: 2, fresh: () async {
        asked++;
        return fake.url(2);
      }));
      await settle(t, rounds: 12);
      const said = 'The page did not load. Tap to try again.';
      expect(find.text(said), findsOneWidget, reason: 'never a blank screen');
      await t.tap(find.text(said));
      await t.pump();
      await t.pump(const Duration(milliseconds: 400));
      expect(asked, 1);
      expect(find.text(said), findsNothing);
      expect(find.text('Getting the page again'), findsNothing);
    });

    testWidgets('a page with no new address to try still offers another try', (t) async {
      await _push(t, const WholePageScreen(url: 'https://pages.test/never.png', n: 5));
      await settle(t, rounds: 12);
      await t.tap(find.text('The page did not load. Tap to try again.'));
      await t.pump();
      await settle(t, rounds: 12);
      expect(find.text('The page did not load. Tap to try again.'), findsOneWidget);
    });

    testWidgets('a box that holds nothing (off the page) shows nothing and does not break the screen', (t) async {
      final fake = await _pages(t);
      await t.pumpWidget(_wrap(PagePiece(pictures: fake.pictures, page: 1, box: const [1.2, 0.5, 1.5, 0.6])));
      await settle(t, rounds: 3);
      expect(t.takeException(), isNull);
      expect(find.byType(AspectRatio), findsNothing);
    });

    testWidgets('opens with its number and goes back', (t) async {
      final fake = await _pages(t);
      await cacheNetworkImage(t, fake.url(2), fake.pages[2]!);
      final o = await _push(t, WholePageScreen(url: fake.url(2), n: 2));
      expect(find.text('Page 2'), findsOneWidget);
      expect(find.byType(InteractiveViewer), findsOneWidget);
      await _tap(t, find.byIcon(Ph.arrowLeft));
      expect(o.closed, isTrue);
    });
  });

  group('cutting the figure by hand', () {
    Finder area() => find.byWidgetPredicate((w) => w is CustomPaint && w.painter.runtimeType.toString() == '_CutPainter');

    /// What the screen has drawn, read from its painter: where the picture is, the box and the figures outlined, in the drawing's pixels.
    dynamic painter(WidgetTester t) => t.widget<CustomPaint>(area()).painter;
    Rect boxOnScreen(WidgetTester t) => painter(t).box as Rect;
    Rect shown(WidgetTester t) => painter(t).shown as Rect;
    Offset at(WidgetTester t, Offset inArea) => t.getTopLeft(area()) + inArea;

    Future<_Opened> open(WidgetTester t, FakePages fake, {int page = 1, PageBox start = const [0.2, 0.3, 0.6, 0.5], int pages = 1, bool photo = false, Size view = const Size(1200, 4000)}) async {
      final o = await _push(t, FigureCutScreen(load: fake.pictures.image, page: page, start: start, pages: pages, figures: fake.pictures.findOn, offerPhoto: photo), view: view);
      await settle(t, rounds: 4);
      return o;
    }

    FigureCut cut(_Opened o) => o.result! as FigureCut;

    Future<void> drag(WidgetTester t, Offset from, Offset step, int steps) async {
      final g = await t.startGesture(from);
      for (var i = 0; i < steps; i++) {
        await g.moveBy(step);
        await t.pump();
      }
      await g.up();
      await t.pump();
    }

    testWidgets('"Use this cut" gives back the page and the box it started with when nothing was moved', (t) async {
      final fake = await _pages(t);
      final o = await open(t, fake);
      expect(find.text('Cut the figure'), findsOneWidget);
      await _tap(t, find.text('Use this cut'));
      expect(o.closed, isTrue);
      expect(cut(o).page, 1);
      expect(cut(o).box, [0.2, 0.3, 0.6, 0.5]);
      expect(cut(o).turns, 0);
    });

    testWidgets('dragging a corner makes the box smaller there and nowhere else', (t) async {
      final fake = await _pages(t);
      final o = await open(t, fake);
      await drag(t, at(t, boxOnScreen(t).bottomRight), const Offset(-6, -3), 12);
      await _tap(t, find.text('Use this cut'));
      final box = cut(o).box;
      expect(box[0], 0.2);
      expect(box[1], 0.3);
      expect(box[2], inExclusiveRange(0.2, 0.6));
      expect(box[3], inExclusiveRange(0.3, 0.5));
    });

    testWidgets('dragging inside the box moves all of it', (t) async {
      final fake = await _pages(t);
      final o = await open(t, fake);
      await drag(t, at(t, boxOnScreen(t).center), const Offset(5, 0), 14);
      await _tap(t, find.text('Use this cut'));
      final box = cut(o).box;
      expect(box[0], greaterThan(0.2));
      expect(box[2] - box[0], closeTo(0.4, 1e-9), reason: 'the same width');
      expect(box[3] - box[1], closeTo(0.2, 1e-9), reason: 'the same height');
    });

    testWidgets('the whole page is shown at once, with nothing more to show', (t) async {
      final fake = await _pages(t);
      await open(t, fake);
      final s = shown(t);
      final size = t.getSize(area());
      expect(s.left, greaterThanOrEqualTo(-0.5));
      expect(s.top, greaterThanOrEqualTo(-0.5));
      expect(s.right, lessThanOrEqualTo(size.width + 0.5));
      expect(s.bottom, lessThanOrEqualTo(size.height + 0.5));
      expect(math.max(s.width / size.width, s.height / size.height), closeTo(1, 0.01), reason: 'as big as the room allows');
      expect(find.text('Show more of the page'), findsNothing);
    });

    // A phone's shape: a page zoomed in a little more than twice fills the room both ways, so nothing has to stay centred.
    const phone = Size(800, 1600);

    testWidgets('pinching zooms in on the page round the fingers, and the box stays on the same part of the page', (t) async {
      final fake = await _pages(t);
      final o = await open(t, fake, view: phone);
      final before = shown(t);
      // Away from the box and its corners, so the pinch is a pinch from its first touch.
      final c = at(t, Offset(before.left + before.width * 0.5, before.top + before.height * 0.75));
      final a = await t.startGesture(c - const Offset(30, 0), pointer: 7);
      final b = await t.startGesture(c + const Offset(30, 0), pointer: 8);
      for (var i = 0; i < 10; i++) {
        await a.moveBy(const Offset(-9, 0));
        await b.moveBy(const Offset(9, 0));
        await t.pump();
      }
      await a.up();
      await b.up();
      await t.pump();
      final after = shown(t);
      expect(after.width, greaterThan(before.width * 1.8), reason: 'zoomed in');
      // The part of the page under the fingers is still under them.
      final under = (c - t.getTopLeft(area()) - after.topLeft);
      expect(under.dx / after.width, closeTo(0.5, 0.03));
      expect(under.dy / after.height, closeTo(0.75, 0.03));
      await _tap(t, find.text('Use this cut'));
      expect(cut(o).box, [0.2, 0.3, 0.6, 0.5], reason: 'zooming moves the view, not the box');
    });

    testWidgets('one finger off the box moves a zoomed page, but never so far that the page leaves an empty edge', (t) async {
      final fake = await _pages(t);
      await open(t, fake, view: phone);
      final s0 = shown(t);
      final c = at(t, Offset(s0.left + s0.width * 0.5, s0.top + s0.height * 0.75));
      final a = await t.startGesture(c - const Offset(30, 0), pointer: 7);
      final b = await t.startGesture(c + const Offset(30, 0), pointer: 8);
      for (var i = 0; i < 10; i++) {
        await a.moveBy(const Offset(-9, 0));
        await b.moveBy(const Offset(9, 0));
        await t.pump();
      }
      await a.up();
      await b.up();
      await t.pump();
      final zoomed = shown(t);
      // Off the box: low on the page, where the red figure is.
      await drag(t, at(t, Offset(zoomed.left + zoomed.width * 0.5, zoomed.top + zoomed.height * 0.9).translate(0, 0)), const Offset(20, 0), 5);
      expect(shown(t).left, greaterThan(zoomed.left), reason: 'the page moved with the finger');
      final size = t.getSize(area());
      // From low on the right, well off the box (which sits high on the zoomed page), far down and to the right.
      expect(boxOnScreen(t).inflate(30).contains(Offset(size.width - 40, size.height - 40)), isFalse);
      await drag(t, at(t, Offset(size.width - 40, size.height - 40)), const Offset(200, 200), 10);
      expect(shown(t).left, lessThanOrEqualTo(0.5), reason: 'no empty band at the left');
      expect(shown(t).top, lessThanOrEqualTo(0.5), reason: 'no empty band at the top');
      expect(shown(t).right, greaterThanOrEqualTo(size.width - 0.5));
    });

    testWidgets('the figures on the page are outlined, and a tap on one puts the box round it', (t) async {
      final fake = await _pages(t);
      final o = await open(t, fake);
      final figs = (painter(t).figures as List).cast<Rect>();
      expect(figs, hasLength(1), reason: 'the red block');
      await t.tapAt(at(t, figs.single.center));
      await t.pump();
      await _tap(t, find.text('Use this cut'));
      final box = cut(o).box;
      // The block runs from 0.1 to 0.9 across and 0.8 to 0.95 down: the box holds it with a little room, and nothing much more.
      expect(box[0], inInclusiveRange(0.07, 0.1));
      expect(box[1], inInclusiveRange(0.77, 0.8));
      expect(box[2], inInclusiveRange(0.9, 0.93));
      expect(box[3], inInclusiveRange(0.95, 0.98));
    });

    testWidgets('the arrows leaf through the paper, and the box goes round the figure on the page opened', (t) async {
      final fake = await _pages(t);
      final o = await open(t, fake, pages: 2);
      expect(find.text('Page 1 of 2'), findsOneWidget);
      await _tap(t, find.byIcon(Ph.caretRight));
      await settle(t, rounds: 4);
      expect(find.text('Page 2 of 2'), findsOneWidget);
      await _tap(t, find.text('Use this cut'));
      expect(cut(o).page, 2);
      final box = cut(o).box;
      // Page 2's blue block: 0.1 to 0.9 across, 0.05 to 0.2 down.
      expect(box[0], lessThanOrEqualTo(0.1));
      expect(box[1], lessThanOrEqualTo(0.05));
      expect(box[2], greaterThanOrEqualTo(0.9));
      expect(box[3], inInclusiveRange(0.2, 0.25));
    });

    testWidgets('"Turn" turns the page a quarter turn clockwise, and the box turns with it', (t) async {
      final fake = await _pages(t);
      final o = await open(t, fake);
      final before = painter(t).image as ui.Image;
      await _tap(t, find.text('Turn'));
      await settle(t, rounds: 4);
      final after = painter(t).image as ui.Image;
      expect(after.width, before.height);
      expect(after.height, before.width);
      // The red block, low on the page and across it, is now down its left side.
      final px = await t.runAsync(() async => (await after.toByteData(format: ui.ImageByteFormat.rawRgba))!);
      Color colour(double fx, double fy) {
        final i = ((fy * after.height).floor() * after.width + (fx * after.width).floor()) * 4;
        return Color.fromARGB(255, px!.getUint8(i), px.getUint8(i + 1), px.getUint8(i + 2));
      }
      expect(colour(0.12, 0.5), red);
      expect(colour(0.12, 0.05), isNot(red));
      expect(colour(0.88, 0.5), isNot(red));
      await _tap(t, find.text('Use this cut'));
      expect(cut(o).turns, 1);
      // [0.2, 0.3, 0.6, 0.5] turned clockwise: left = 1 - bottom, top = left, right = 1 - top, bottom = right.
      final box = cut(o).box;
      expect(box[0], closeTo(0.5, 1e-9));
      expect(box[1], closeTo(0.2, 1e-9));
      expect(box[2], closeTo(0.7, 1e-9));
      expect(box[3], closeTo(0.6, 1e-9));
    });

    testWidgets('a page that did not load cannot be cut, and says so', (t) async {
      final fake = await _pages(t);
      fake.pictures.setPages([
        {'page_no': 9, 'image_url': fake.url(9)},
      ]);
      fake.broken.add(fake.url(9));
      await open(t, fake, page: 9);
      expect(find.text('The page did not load.'), findsOneWidget);
      final use = find.ancestor(of: find.text('Use this cut'), matching: find.byType(Pressable)).first;
      expect(t.widget<Pressable>(use).enabled, isFalse);
    });

    testWidgets('"Use a photo" is there when asked for, and says the tutor would rather add a photo', (t) async {
      final fake = await _pages(t);
      final o = await open(t, fake, photo: true);
      await _tap(t, find.text('Use a photo'));
      expect(o.closed, isTrue);
      expect(o.result, FigureCutScreen.usePhoto);
    });

    testWidgets('"Use a photo" is not offered unless asked for', (t) async {
      final fake = await _pages(t);
      await open(t, fake);
      expect(find.text('Use a photo'), findsNothing);
    });

    testWidgets('a photo opens on the cut screen with the box round the figure in it, and the cut is that part of the photo', (t) async {
      final fake = await _pages(t);
      // A photo of just a figure on white: a blue block in the middle of an 800 by 1130 picture.
      fake.photo = (await t.runAsync(() => pagePng(blocks: [(box: const [0.3, 0.3, 0.7, 0.6], color: blue)])))!;
      Uint8List? png;
      var done = false;
      t.view.physicalSize = const Size(1200, 4000);
      t.view.devicePixelRatio = 2;
      addTearDown(t.view.reset);
      await t.pumpWidget(MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () async {
                  png = await fake.pictures.cutPhoto(context, ImageSource.gallery);
                  done = true;
                },
                child: const Text('photo'),
              ),
            ),
          ),
        ),
      ));
      await t.tap(find.text('photo'));
      await settle(t, rounds: 8);
      expect(find.text('Cut the figure'), findsOneWidget);
      expect(find.textContaining('Page 1 of'), findsNothing, reason: 'a photo has no pages to leaf through');
      await _tap(t, find.text('Use this cut'));
      await settle(t, rounds: 4);
      expect(done, isTrue);
      final img = await t.runAsync(() async => (await (await ui.instantiateImageCodec(png!)).getNextFrame()).image);
      final photo = await t.runAsync(() async => (await (await ui.instantiateImageCodec(fake.photo!)).getNextFrame()).image);
      // The block is 0.4 of the photo wide and 0.3 high; the cut holds it with a little room.
      expect(img!.width / photo!.width, inInclusiveRange(0.4, 0.45));
      expect(img.height / photo.height, inInclusiveRange(0.3, 0.35));
    });

    testWidgets('backing out of the camera or gallery cuts nothing', (t) async {
      final fake = await _pages(t);
      Uint8List? png = Uint8List(1);
      var done = false;
      await t.pumpWidget(MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () async {
                  png = await fake.pictures.cutPhoto(context, ImageSource.camera);
                  done = true;
                },
                child: const Text('photo'),
              ),
            ),
          ),
        ),
      ));
      await t.tap(find.text('photo'));
      await settle(t, rounds: 4);
      expect(done, isTrue);
      expect(png, isNull);
      expect(find.text('Cut the figure'), findsNothing);
    });
  });

  group('fixing a question', () {
    const original = r'The sum of the first $n$ terms of an AP is $3n^2 + 5n$. Its 10th term is';
    Map<String, dynamic> draft({bool joined = false, bool boxes = true, String text = original}) => {
          'id': 'd1', 'page_no': 1, 'number_label': '7.', 'kind': 'mcq', 'text': text, 'options': ['62', '65', r'$59$', '68'], 'correct_option': null,
          'question_boxes': boxes
              ? [
                  {'page': 1, 'box': [0.1, 0.8, 0.9, 0.95]},
                  if (joined) {'page': 2, 'box': [0.1, 0.05, 0.9, 0.2]},
                ]
              : null,
          'joined': joined,
          'joined_from': joined
              ? {
                  'before': {'options': ['62', '65']},
                  'part': {'page_no': 2},
                }
              : null,
        };

    String field(WidgetTester t, int i) => t.widget<EditableText>(find.byType(EditableText).at(i)).controller.text;

    testWidgets('opens with the picture on top, the words in plain symbols, and the options', (t) async {
      final fake = await _pages(t);
      await _push(t, DraftEditor(draft: draft(), pictures: fake.pictures));
      await t.pump();
      expect(find.text('Fix question'), findsOneWidget);
      expect(find.text('PAGE 1 · QUESTION 7'), findsOneWidget);
      expect(find.byType(FromYourPaper), findsOneWidget);
      expect(field(t, 0), 'The sum of the first n terms of an AP is 3n² + 5n. Its 10th term is', reason: 'no dollar signs');
      expect([for (var i = 1; i <= 4; i++) field(t, i)], ['62', '65', '59', '68']);
      expect(find.text('Tap a symbol to put it in the box.'), findsOneWidget);
      expect(find.text('Options. Tap the circle of the right answer.'), findsOneWidget);
      expect(find.text('Save question'), findsOneWidget);
    });

    testWidgets('a question joined from two pages names both pages and shows both parts', (t) async {
      final fake = await _pages(t);
      await _push(t, DraftEditor(draft: draft(joined: true), pictures: fake.pictures));
      await t.pump();
      expect(find.text('PAGES 1 AND 2 · QUESTION 7'), findsOneWidget);
      expect(find.byType(PagePiece), findsNWidgets(2));
    });

    testWidgets('without the question\'s boxes the page can still be looked at', (t) async {
      final fake = await _pages(t);
      await _push(t, DraftEditor(draft: draft(boxes: false), pictures: fake.pictures));
      await t.pump();
      expect(find.byType(FromYourPaper), findsNothing);
      expect(find.text('See page 1'), findsOneWidget);
    });

    testWidgets('without page pictures there is no picture and no link', (t) async {
      await _push(t, DraftEditor(draft: draft()));
      await t.pump();
      expect(find.byType(FromYourPaper), findsNothing);
      expect(find.textContaining('See page'), findsNothing);
      expect(find.text('Fix question'), findsOneWidget);
    });

    testWidgets('a symbol tapped goes into the box being typed in', (t) async {
      await _push(t, const DraftEditor(draft: {'id': 'd1', 'page_no': 1, 'number_label': '3', 'kind': 'mcq', 'text': 'Area of a circle is r', 'options': ['a', 'b', 'c', 'd']}));
      await t.pump();
      await t.tap(find.byType(EditableText).first);
      await t.pump();
      await t.tap(find.text('x²'));
      await t.pump();
      await t.tap(find.text('π'));
      await t.pump();
      final text = field(t, 0);
      expect(text, contains('²'));
      expect(text, contains('π'));
      expect(text, isNot(contains(r'$')));
      // And into an option when that is the box being typed in.
      await t.tap(find.byType(EditableText).at(2));
      await t.pump();
      await t.tap(find.text('√'));
      await t.pump();
      expect(field(t, 2), contains('√'));
      expect(field(t, 0), isNot(contains('√')));
    });

    testWidgets('saving without touching a box gives back what AI read, formulas and all', (t) async {
      final o = await _push(t, DraftEditor(draft: draft()));
      await t.pump();
      await _tap(t, find.text('Save question'));
      final r = o.result as Map<String, dynamic>;
      expect(r['text'], original, reason: 'a question nobody touched keeps its maths for the students');
      expect(r['options'], ['62', '65', r'$59$', '68']);
      expect(r['kind'], 'mcq');
      expect(r.containsKey('correct_option'), isFalse, reason: 'AI is still free to look for the answer');
    });

    testWidgets('a box that was typed in gives back what was typed', (t) async {
      final o = await _push(t, DraftEditor(draft: draft()));
      await t.pump();
      await t.enterText(find.byType(EditableText).first, 'The 10th term of 3n² + 5n is');
      await t.pump();
      await _tap(t, find.text('Save question'));
      final r = o.result as Map<String, dynamic>;
      expect(r['text'], 'The 10th term of 3n² + 5n is');
      expect(r['options'], ['62', '65', r'$59$', '68'], reason: 'the options were not touched');
    });

    testWidgets('tapping the circle of the right answer gives it back, and tapping it again takes it away', (t) async {
      final o = await _push(t, DraftEditor(draft: draft()));
      await t.pump();
      await _tap(t, find.text('B'));
      await _tap(t, find.text('Save question'));
      expect((o.result as Map)['correct_option'], 1);

      final p = await _push(t, DraftEditor(draft: {...draft(), 'correct_option': 2}));
      await t.pump();
      await _tap(t, find.byIcon(Ph.check)); // option C is marked; this unmarks it
      await _tap(t, find.text('Save question'));
      expect((p.result as Map)['correct_option'], isNull);
      expect((p.result as Map).containsKey('correct_option'), isTrue);
    });

    testWidgets('a question that is not multiple choice has no options', (t) async {
      final o = await _push(t, DraftEditor(draft: draft()));
      await t.pump();
      await _tap(t, find.text('This is not a multiple choice question'));
      expect(find.text('Make it multiple choice'), findsOneWidget);
      await _tap(t, find.text('Save question'));
      final r = o.result as Map<String, dynamic>;
      expect(r['kind'], 'other');
      expect(r['options'], isEmpty);
    });

    testWidgets('it cannot be saved empty, and says why', (t) async {
      final o = await _push(t, DraftEditor(draft: draft()));
      await t.pump();
      expect(find.text('The question cannot be empty.'), findsNothing);
      await t.enterText(find.byType(EditableText).first, '');
      await t.pump();
      expect(find.text('The question cannot be empty.'), findsOneWidget);
      await t.tap(find.text('Save question'), warnIfMissed: false);
      await t.pump();
      expect(o.closed, isFalse);
      await t.enterText(find.byType(EditableText).first, 'Something');
      await t.enterText(find.byType(EditableText).at(3), '');
      await t.pump();
      expect(find.text('Fill in all four options.'), findsOneWidget);
    });
  });
}
