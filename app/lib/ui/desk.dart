import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../theme.dart';
import 'kit.dart';

// The app in a computer's browser. On the web, a window at least [deskMinWidth] wide shows a signed-in person the desk layout:
// a sidebar that stays on the left (features/desk_frame.dart) and the page beside it. A page laid out for the wide screen (the
// tutor's Home, a group's or a course's page) takes all of it; every other page keeps to a column of [deskColumn] in the middle.
// Phones, tablets and narrower windows keep the phone's column ([PhoneColumn]).

/// Whether the desk layout and the pointer's controls (the hand over what can be clicked, hover, Tab and Enter) are on: in a
/// browser only. The screenshot tests turn it on to draw the desk layout.
bool deskAllowed = kIsWeb;

/// The narrowest window that gets the desk layout.
const deskMinWidth = 1024.0;

/// The sidebar's width.
const deskSideWidth = 252.0;

/// The column a page not laid out for the wide screen keeps to.
const deskColumn = 760.0;

/// The widest a wide page's content grows.
const deskWide = 1200.0;

/// Marks the pages shown beside the sidebar.
class DeskScope extends InheritedWidget {
  const DeskScope({super.key, required super.child});

  @override
  bool updateShouldNotify(DeskScope oldWidget) => false;
}

/// True for a page shown beside the sidebar.
bool onDesk(BuildContext context) => context.dependOnInheritedWidgetOfExactType<DeskScope>() != null;

/// The app is made for phones. On a tablet, or in a narrow browser window, its screens would stretch across the whole width, with
/// fields a hand's length long and a receipt the size of a poster, so it keeps to a column in the middle, edged with a hairline on
/// each side. Everything inside, dialogs included, sees the column's width as the screen's.
class PhoneColumn extends StatelessWidget {
  const PhoneColumn({super.key, required this.child, this.width = 720, this.edges = true});

  final Widget child;
  final double width;

  /// A hairline down each side of the column.
  final bool edges;

  @override
  Widget build(BuildContext context) {
    final mq = MediaQuery.of(context);
    if (mq.size.width <= width + 2) return child;
    return ColoredBox(
      color: bg,
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (edges) ColoredBox(color: hairline, child: const SizedBox(width: 1)),
          SizedBox(
            width: width,
            child: MediaQuery(data: mq.copyWith(size: Size(width, mq.size.height)), child: child),
          ),
          if (edges) ColoredBox(color: hairline, child: const SizedBox(width: 1)),
        ],
      ),
    );
  }
}

/// A page in the desk frame. A [wide] page lays itself out for the room beside the sidebar; any other keeps to a column of
/// [deskColumn] and sees the column as the screen. The column starts where a wide page's content starts, so a page's title stays in
/// one place from page to page. Outside the desk frame it is the page as it is.
class DeskPage extends StatelessWidget {
  const DeskPage({super.key, required this.child, this.wide = false});

  final Widget child;
  final bool wide;

  @override
  Widget build(BuildContext context) {
    if (!onDesk(context)) return child;
    // Words on a page can be selected with the mouse and copied, as on any web page.
    final page = SelectionArea(child: child);
    if (wide) return page;
    final mq = MediaQuery.of(context);
    // A wide page's content starts 44 in from its box; a phone page has a gutter of its own (theme.dart), the rest of the 44.
    final left = math.max(0.0, (mq.size.width - deskWide) / 2) + 44 - gutter;
    final width = math.min(deskColumn, mq.size.width - left);
    return ColoredBox(
      color: bg,
      child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        SizedBox(width: left),
        SizedBox(width: width, child: MediaQuery(data: mq.copyWith(size: Size(width, mq.size.height)), child: page)),
      ]),
    );
  }
}

/// A wide page's body: its content up to [deskWide] across, in the middle, scrolling.
class DeskScroll extends StatelessWidget {
  const DeskScroll({super.key, required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) => ListView(
        padding: EdgeInsets.zero,
        children: [
          Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: deskWide),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(44, 30, 44, 64),
                child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children),
              ),
            ),
          ),
        ],
      );
}

/// The top of a wide page: a link back to the page it belongs under, a kicker, the title, and the page's buttons. The buttons sit at
/// the right of the title when there is room, and under it when the window is narrow.
class DeskHead extends StatelessWidget {
  const DeskHead({super.key, required this.title, this.kicker, this.crumb, this.onCrumb, this.under, this.actions = const []});

  final String title;
  final String? kicker;

  /// The page this one belongs under, as a link: "Groups & courses".
  final String? crumb;
  final VoidCallback? onCrumb;

  /// A small action under the title, such as renaming.
  final Widget? under;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    final name = Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (kicker != null) ...[Kicker(kicker!), const SizedBox(height: 8)],
      Fig(title, style: displayStyle, maxLines: 2),
      ?under,
    ]);
    return Padding(
      padding: const EdgeInsets.only(bottom: 24),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (crumb != null) ...[
          Pressable(
            onTap: onCrumb,
            label: 'Back to $crumb',
            radius: 8,
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(Ph.arrowLeft, size: 15, color: muted),
                const SizedBox(width: 6),
                Text(crumb!, style: chipStyle.copyWith(color: muted, fontWeight: FontWeight.w600)),
              ]),
            ),
          ),
          const SizedBox(height: 12),
        ],
        LayoutBuilder(builder: (context, box) {
          if (actions.isEmpty) return name;
          if (box.maxWidth < 900) {
            return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              name,
              const SizedBox(height: 18),
              Wrap(spacing: 10, runSpacing: 10, children: actions),
            ]);
          }
          return Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Expanded(child: name),
            const SizedBox(width: 24),
            Row(mainAxisSize: MainAxisSize.min, children: [
              for (final (i, a) in actions.indexed) ...[if (i > 0) const SizedBox(width: 10), a],
            ]),
          ]);
        }),
      ]),
    );
  }
}

/// A button on a wide page: smaller than a phone's, for a pointer. [filled] for the page's main action.
class DeskButton extends StatelessWidget {
  const DeskButton(this.label, {super.key, this.icon, this.onTap, this.filled = false, this.tint});

  final String label;
  final IconData? icon;
  final VoidCallback? onTap;
  final bool filled;
  final Color? tint;

  @override
  Widget build(BuildContext context) => Pressable(
        onTap: onTap,
        label: label,
        radius: 12,
        child: Builder(builder: (context) {
          final hover = pressHover(context);
          final on = filled && onTap != null;
          final fg = onTap == null ? faint : (on ? actionInk : (tint ?? ink));
          return Container(
            height: 40,
            padding: const EdgeInsets.symmetric(horizontal: 16),
            decoration: on
                ? BoxDecoration(color: hover ? actionHover : actionFill, borderRadius: BorderRadius.circular(12), boxShadow: e4)
                : surface(radius: 12, shadow: hover ? e2 : e1, color: hover && isDark ? cardHi : null),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              if (icon != null) ...[Icon(icon, size: 17, color: fg), const SizedBox(width: 8)],
              Text(label, style: buttonStyle.copyWith(fontSize: 13.8, color: fg)),
            ]),
          );
        }),
      );
}

/// A section's heading on a wide page: the kicker, a count and a hairline, as on the phone, without the phone's side margins.
class DeskRule extends StatelessWidget {
  const DeskRule(this.label, {super.key, this.count, this.first = false, this.trailing});

  final String label;
  final int? count;

  /// The first heading of its column, with no space above it.
  final bool first;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) =>
      SectionRule(label, count: count, trailing: trailing, padding: EdgeInsets.fromLTRB(2, first ? 0 : 26, 2, 12));
}

/// A column of a [DeskTable]: its heading, and a fixed [width] or a share ([flex]) of the room the fixed ones leave.
class DeskColumn {
  const DeskColumn(this.heading, {this.width, this.flex = 1});

  final String heading;
  final double? width;
  final int flex;
}

/// A row of a [DeskTable]: one widget per column, and what clicking the row opens.
class DeskRow {
  const DeskRow(this.cells, {this.onTap, this.label});

  final List<Widget> cells;
  final VoidCallback? onTap;

  /// What a screen reader says for the row, when its cells alone would not say it well.
  final String? label;
}

/// A table on a wide page: a card with the columns' headings across the top and a row for each thing under them, a hairline apart.
/// A row that opens something answers the pointer and the keyboard.
class DeskTable extends StatelessWidget {
  const DeskTable({super.key, required this.columns, required this.rows});

  final List<DeskColumn> columns;
  final List<DeskRow> rows;

  static const _gap = 16.0;

  Widget _line(List<Widget> cells) => Row(children: [
        for (final (i, c) in columns.indexed) ...[
          if (i > 0) const SizedBox(width: _gap),
          if (c.width == null) Expanded(flex: c.flex, child: cells[i]) else SizedBox(width: c.width, child: cells[i]),
        ],
      ]);

  @override
  Widget build(BuildContext context) => Container(
        clipBehavior: Clip.antiAlias,
        decoration: surface(radius: rCard, shadow: e2),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Container(
            height: 40,
            padding: const EdgeInsets.symmetric(horizontal: 20),
            child: _line([
              for (final c in columns)
                Text(c.heading.toUpperCase(), style: kickerStyle.copyWith(fontSize: 10.5), maxLines: 1, overflow: TextOverflow.ellipsis),
            ]),
          ),
          for (final r in rows) ...[
            Container(height: 1, color: hairline),
            Pressable(
              onTap: r.onTap,
              label: r.label,
              radius: 0,
              ringInside: true,
              child: Builder(
                builder: (context) => Container(
                  constraints: const BoxConstraints(minHeight: 58),
                  color: pressHover(context) ? rowHover : null,
                  padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
                  alignment: Alignment.centerLeft,
                  child: _line(r.cells),
                ),
              ),
            ),
          ],
        ]),
      );
}

/// A short list in one card, for the side of a wide page: each line opens something.
class DeskList extends StatelessWidget {
  const DeskList(this.items, {super.key});

  final List<DeskItem> items;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(6),
        decoration: surface(radius: rCard, shadow: e2),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: items),
      );
}

/// A line of a [DeskList]: an icon on a soft amber square for something that needs doing, a title and a detail, and a short
/// green [note] at the end ("1 open").
class DeskItem extends StatelessWidget {
  const DeskItem({super.key, this.icon, required this.title, required this.meta, this.note, required this.onTap});

  final IconData? icon;
  final String title;
  final String meta;
  final String? note;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Pressable(
        onTap: onTap,
        radius: 14,
        child: Builder(builder: (context) {
          final hover = pressHover(context);
          return Container(
            padding: const EdgeInsets.fromLTRB(12, 11, 10, 11),
            decoration: BoxDecoration(color: hover ? fill : null, borderRadius: BorderRadius.circular(14)),
            child: Row(children: [
              if (icon != null) ...[
                Container(
                  width: 36,
                  height: 36,
                  decoration: BoxDecoration(color: warningSoft, borderRadius: BorderRadius.circular(11)),
                  child: Icon(icon, size: 18, color: warning),
                ),
                const SizedBox(width: 12),
              ],
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Fig(title, style: rowTitleStyle.copyWith(fontSize: 14), maxLines: 2),
                  const SizedBox(height: 1),
                  Fig(meta, style: labelStyle.copyWith(fontSize: 12.3, color: muted), maxLines: 2),
                ]),
              ),
              if (note != null) ...[const SizedBox(width: 8), Fig(note!, style: labelStyle.copyWith(color: success, fontWeight: FontWeight.w700))],
              const SizedBox(width: 6),
              Icon(Ph.caretRight, size: 16, color: hover ? ink : faint),
            ]),
          );
        }),
      );
}

/// A table cell: the thing's name, in the row title's type.
Widget deskCellTitle(String text) => Fig(text, style: rowTitleStyle, maxLines: 2);

/// A table cell: a detail, in body type.
Widget deskCell(String text, {Color? color}) => Fig(text, style: bodyStyle.copyWith(fontSize: 13, color: color ?? body), maxLines: 2);

/// The arrow at the end of a row that opens something.
Widget deskChevron() => Builder(
      builder: (context) => Align(
        alignment: Alignment.centerRight,
        child: Icon(Ph.caretRight, size: 16, color: pressHover(context) ? ink : faint),
      ),
    );

/// A row of a table under the pointer.
Color get rowHover => Color.lerp(card, fill, 0.55)!;

/// The main action's fill under the pointer: a step lighter.
Color get actionHover => Color.lerp(actionFill, actionInk, 0.13)!;
