import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tuition_app/features/teacher/print_test.dart';

void main() {
  test('blocks that fit share a page, with the gaps between them counted', () {
    expect(paginate([100, 200, 300], [false, false, false], room: 640, gap: 20), [
      [0, 1, 2],
    ]);
    expect(paginate([100, 200, 300], [false, false, false], room: 639, gap: 20), [
      [0, 1],
      [2],
    ]);
  });

  test('a question never splits: one that does not fit goes over whole', () {
    expect(paginate([300, 300, 300, 300, 300], List.filled(5, false), room: 740, gap: 14), [
      [0, 1],
      [2, 3],
      [4],
    ]);
  });

  test('the answer key starts a page, but never leaves one empty', () {
    expect(paginate([100, 50, 50], [false, true, false], room: 700, gap: 10), [
      [0],
      [1, 2],
    ]);
    expect(paginate([100, 50], [true, false], room: 700, gap: 10), [
      [0, 1],
    ]);
  });

  test('a block taller than a page has a page to itself', () {
    expect(paginate([100, 900, 100], [false, false, false], room: 700, gap: 10), [
      [0],
      [1],
      [2],
    ]);
  });

  testWidgets('the PDF has a page for each page drawn, each kept as a JPEG', (t) async {
    final keys = [GlobalKey(), GlobalKey()];
    await t.pumpWidget(Directionality(
      textDirection: TextDirection.ltr,
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        for (final k in keys) RepaintBoundary(key: k, child: const SizedBox(width: 59.5, height: 84.2, child: ColoredBox(color: Colors.white))),
      ]),
    ));
    final bytes = (await t.runAsync(() => testPdf([for (final k in keys) t.renderObject<RenderRepaintBoundary>(find.byKey(k))], title: 'Unit test 3', author: 'Priya Maths Classes')))!;
    final text = String.fromCharCodes(bytes);
    expect(text.startsWith('%PDF-'), isTrue);
    expect(RegExp(r'/Type\s*/Page\b').allMatches(text).length, 2);
    expect(RegExp(r'/DCTDecode').allMatches(text).length, 2);
    expect(text.contains('Priya Maths Classes'), isTrue, reason: 'the tuition is the PDF author');
  });
}
