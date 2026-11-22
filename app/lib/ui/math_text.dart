import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_math_fork/flutter_math.dart';

import '../theme.dart';

final _tex = RegExp(r'\$([^$]+)\$');
final _openingRun = RegExp(r'''[(\[{"'“‘-]+$''');
final _touchingRun = RegExp(r'^[^\s$]{1,12}');

/// The line of dashes under a table's heading row: `|---|---|`, `---|---` or `| :--- | :---: |`.
final _tableRule = RegExp(r'^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$');

/// A table's rows of cells, the first row its heading.
typedef TextTable = List<List<String>>;

/// The cells of one row of a table: the parts between its | marks, leaving alone a | inside a formula (`$|x|$`). The marks at
/// either end may be left off.
List<String> _cellsOf(String line) {
  final cells = <String>[];
  final cell = StringBuffer();
  var inFormula = false;
  for (var i = 0; i < line.length; i++) {
    final c = line[i];
    if (c == r'$') inFormula = !inFormula;
    if (c == '|' && !inFormula) {
      cells.add(cell.toString().trim());
      cell.clear();
    } else {
      cell.write(c);
    }
  }
  cells.add(cell.toString().trim());
  if (cells.length > 1 && cells.first.isEmpty) cells.removeAt(0);
  if (cells.length > 1 && cells.last.isEmpty) cells.removeLast();
  return cells;
}

/// A question's text cut into what it holds: runs of text (each a String) and the tables written in it the way the reader writes a
/// table printed with a question ([TextTable]): a heading row, a line of dashes under it, then a row a line, cells between | marks.
/// Text with no table is the one String, as it came.
List<Object> splitTables(String source) {
  if (!source.contains('|')) return [source];
  final lines = source.split('\n');
  final parts = <Object>[];
  final text = <String>[];
  void endText() {
    // The blank lines round a table are the table's: the text keeps its own lines and nothing more.
    while (text.isNotEmpty && text.first.trim().isEmpty) {
      text.removeAt(0);
    }
    while (text.isNotEmpty && text.last.trim().isEmpty) {
      text.removeLast();
    }
    if (text.isNotEmpty) parts.add(text.join('\n'));
    text.clear();
  }

  var tables = 0;
  for (var i = 0; i < lines.length;) {
    final heading = lines[i].contains('|') && i + 1 < lines.length && _tableRule.hasMatch(lines[i + 1]) ? _cellsOf(lines[i]) : const <String>[];
    if (heading.length < 2) {
      text.add(lines[i++]);
      continue;
    }
    final rows = [heading];
    var j = i + 2;
    for (; j < lines.length && lines[j].contains('|') && lines[j].trim().isNotEmpty; j++) {
      rows.add(_cellsOf(lines[j]));
    }
    // Every row as wide as the widest, so a row the reader gave a cell short still lines up.
    final width = rows.map((r) => r.length).reduce(math.max);
    endText();
    parts.add(<List<String>>[for (final r in rows) [...r, for (var k = r.length; k < width; k++) '']]);
    tables++;
    i = j;
  }
  endText();
  return tables == 0 ? [source] : parts;
}

/// The text with each table run into one line (cells by commas, rows by semicolons): for a preview a line or two long.
String _tablesInLine(List<Object> parts) => [
      for (final p in parts) p is String ? p : (p as TextTable).where((r) => r.any((c) => c.trim().isNotEmpty)).map((r) => r.join(', ')).join('; '),
    ].join(' ');

/// The text for a preview a line or two long: tables run into the line (see [_tablesInLine]), and a question that starts with its
/// group's passage (long paragraphs, often under a "Case study" heading, a blank line, the question last) shows the question first
/// and the passage after it, so the questions of one case study do not all look alike in a list.
String previewOf(String source) {
  final paras = source.split(RegExp(r'\n[ \t]*\n')).map((p) => p.trim()).where((p) => p.isNotEmpty).toList();
  String inLine(String s) {
    final parts = splitTables(s);
    return parts.length == 1 && parts.single is String ? s : _tablesInLine(parts);
  }

  final before = paras.length >= 2 ? paras.sublist(0, paras.length - 1).join('\n\n') : '';
  final passage = before.length >= 100 && !before.contains('|') && !paras.last.contains('|');
  if (!passage) return inLine(source);
  return '${paras.last} · ${before.replaceAll(RegExp(r'\s*\n\s*'), ' ')}';
}

/// Text with `$...$` LaTeX segments rendered inline. A formula that fails to parse
/// falls back to its source so a typo never blanks out a question. A table written in
/// the text (see [splitTables]) is drawn as a table, unless the text is cut to a few lines.
class MathText extends StatelessWidget {
  const MathText(this.source, {super.key, required this.style, this.maxLines, this.textAlign = TextAlign.start, this.display = false});

  final String source;
  final TextStyle style;
  final int? maxLines;
  final TextAlign textAlign;

  /// Display style sets fractions full size; used for answer options so 3/5 is easy to read.
  final bool display;

  @override
  Widget build(BuildContext context) {
    if (maxLines != null) return _text(previewOf(source));
    final parts = splitTables(source);
    if (parts.length == 1 && parts.single is String) return _text(source);
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: textAlign == TextAlign.center ? CrossAxisAlignment.center : CrossAxisAlignment.start,
      children: [
        for (final p in parts)
          if (p is String) _text(p) else Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: _Table(rows: p as TextTable, style: style)),
      ],
    );
  }

  Widget _text(String source) {
    final parts = <(bool, String)>[];
    var last = 0;
    for (final m in _tex.allMatches(source)) {
      if (m.start > last) parts.add((false, source.substring(last, m.start)));
      parts.add((true, m.group(1)!));
      last = m.end;
    }
    if (last < source.length) parts.add((false, source.substring(last)));

    // Normal weight keeps variables in math italic; a bold surrounding style would
    // otherwise switch KaTeX to upright bold letters.
    final mathStyle = style.copyWith(fontSize: (style.fontSize ?? 14) * 1.08, letterSpacing: 0, fontWeight: FontWeight.normal);
    final spans = <InlineSpan>[];
    for (var i = 0; i < parts.length; i++) {
      final (isMath, value) = parts[i];
      if (!isMath) {
        spans.add(TextSpan(text: value));
        continue;
      }
      // Characters touching the formula ("(", "4,", "y-axis?") go into the same piece:
      // the layout treats an embedded formula as a break point, so they would otherwise wrap apart.
      var lead = '';
      if (spans.isNotEmpty && spans.last is TextSpan) {
        final prev = (spans.last as TextSpan).text ?? '';
        final m = _openingRun.firstMatch(prev);
        if (m != null) {
          lead = m.group(0)!;
          spans[spans.length - 1] = TextSpan(text: prev.substring(0, m.start));
        }
      }
      var trail = '';
      if (i + 1 < parts.length && !parts[i + 1].$1) {
        final next = parts[i + 1].$2;
        final m = _touchingRun.firstMatch(next);
        if (m != null) {
          trail = m.group(0)!;
          parts[i + 1] = (false, next.substring(m.end));
        }
      }
      spans.add(WidgetSpan(
        alignment: PlaceholderAlignment.baseline,
        baseline: TextBaseline.alphabetic,
        // A formula wider than the line (large text on a narrow phone) is shrunk to fit it, not cut off at the edge.
        child: FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: Row(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
            if (lead.isNotEmpty) Text(lead, style: style),
            Math.tex(
              value,
              mathStyle: display ? MathStyle.display : MathStyle.text,
              textStyle: mathStyle,
              onErrorFallback: (_) => Text(value, style: style),
            ),
            if (trail.isNotEmpty) Text(trail, style: style),
          ]),
        ),
      ));
    }
    return Text.rich(
      TextSpan(style: style, children: spans),
      semanticsLabel: plainMath(source),
      maxLines: maxLines,
      overflow: maxLines == null ? null : TextOverflow.ellipsis,
      textAlign: textAlign,
    );
  }
}

/// A table from a question's text: ruled cells, the heading row shaded, each cell's formulas set as formulas. Each column is as wide as
/// its widest cell (up to a limit, past which a cell wraps); a table wider than the screen slides sideways.
class _Table extends StatelessWidget {
  const _Table({required this.rows, required this.style});

  final TextTable rows;
  final TextStyle style;

  static const _padX = 10.0, _padY = 6.0, _widest = 240.0;

  @override
  Widget build(BuildContext context) {
    // The cells no heavier than medium, so the heading row stands out even where the question is set in bold.
    final cells = (style.fontWeight?.value ?? 400) > 500 ? style.copyWith(fontWeight: FontWeight.w500) : style;
    final heading = style.copyWith(fontWeight: FontWeight.w700);
    // A grid of numbers printed without headings comes with a blank heading row: that row is left out, and no row is shaded.
    final headed = rows.first.any((c) => c.trim().isNotEmpty);
    final shown = headed ? rows : rows.sublist(1);
    if (shown.isEmpty) return const SizedBox.shrink();
    TextStyle styleOf(int r) => headed && r == 0 ? heading : cells;
    final scaler = MediaQuery.textScalerOf(context);
    final direction = Directionality.of(context);
    // Measured as plain text: a formula widget cannot be asked its width ahead of laying it out, and is shrunk to fit if it runs over.
    final widths = <int, TableColumnWidth>{};
    for (var c = 0; c < shown.first.length; c++) {
      var w = 0.0;
      for (var r = 0; r < shown.length; r++) {
        final tp = TextPainter(text: TextSpan(text: plainMath(shown[r][c]), style: styleOf(r)), textDirection: direction, textScaler: scaler, maxLines: 1)
          ..layout();
        w = math.max(w, tp.width);
        tp.dispose();
      }
      widths[c] = FixedColumnWidth(math.min(_widest, w * 1.1 + 4) + 2 * _padX);
    }
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Table(
        columnWidths: widths,
        border: TableBorder.all(color: faint, width: 0.8),
        defaultVerticalAlignment: TableCellVerticalAlignment.middle,
        children: [
          for (var r = 0; r < shown.length; r++)
            TableRow(
              decoration: headed && r == 0 ? BoxDecoration(color: fill) : null,
              children: [
                for (final cell in shown[r])
                  Padding(padding: const EdgeInsets.symmetric(horizontal: _padX, vertical: _padY), child: MathText(cell, style: styleOf(r))),
              ],
            ),
        ],
      ),
    );
  }
}

/// Plain text for screen readers: what a sighted student reads, without the LaTeX.
/// `$\frac{\sqrt{3}}{4}$` becomes "√3/4" and `$A = \{1, 2\}$` keeps its set braces.
String plainMath(String s) {
  var t = s.replaceAll(r'\{', _openSet).replaceAll(r'\}', _closeSet);
  t = t.replaceAllMapped(_command, (m) {
    final name = m[1]!;
    if (_structural.contains(name)) return m[0]!;
    return _commands[name] ?? name;
  });
  // Innermost groups first, so a root inside a fraction comes out whole.
  for (var before = ''; before != t;) {
    before = t;
    t = t
        .replaceAllMapped(_sqrt, (m) => '√${_group(m[1]!)}')
        .replaceAllMapped(_frac, (m) => '${_group(m[1]!)}/${_group(m[2]!)}')
        .replaceAllMapped(_bracedPower, (m) => _power(m[1]!));
  }
  return t
      .replaceAll(RegExp(r'\\sqrt\s*'), '√')
      .replaceAllMapped(RegExp(r'\^([0-9°])'), (m) => _power(m[1]!))
      .replaceAll(RegExp(r'\\[,;:! ]'), '')
      .replaceAll(RegExp(r'[\$\\{}]'), '')
      .replaceAll(_openSet, '{')
      .replaceAll(_closeSet, '}')
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();
}

const _openSet = '\uE000';
const _closeSet = '\uE001';
final _command = RegExp(r'\\([a-zA-Z]+)');
final _sqrt = RegExp(r'\\sqrt\{([^{}]*)\}');
final _frac = RegExp(r'\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}');
final _bracedPower = RegExp(r'\^\{([^{}]*)\}');
final _token = RegExp(r'^[\p{L}\p{N}√.°]+$', unicode: true);
const _structural = {'frac', 'dfrac', 'tfrac', 'sqrt'};
const _commands = {
  'times': '×', 'div': '÷', 'cdot': '·', 'pm': '±', 'circ': '°', 'degree': '°',
  'le': '≤', 'leq': '≤', 'ge': '≥', 'geq': '≥', 'ne': '≠', 'neq': '≠', 'approx': '≈',
  'pi': 'π', 'theta': 'θ', 'alpha': 'α', 'beta': 'β', 'infty': '∞',
  'cap': '∩', 'cup': '∪', 'in': '∈', 'ldots': '…', 'dots': '…', 'cdots': '…',
  'left': '', 'right': '', 'text': '', 'mathrm': '', 'displaystyle': '',
};

String _group(String x) {
  final t = x.trim();
  return _token.hasMatch(t) ? t : '($t)';
}

String _power(String p) => switch (p.trim()) {
      '2' => '²',
      '3' => '³',
      '°' => '°',
      final t => '^${_group(t)}',
    };
