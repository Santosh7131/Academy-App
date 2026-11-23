import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/links.dart';
import '../../core/timetable.dart';
import '../../theme.dart';
import '../../ui/kit.dart';
import 'attendance_screens.dart' show ClassRef;
import 'common.dart' show showProblem;

// The timetable (api/src/routes/timetable.ts): a class's times, each on some weekdays at one time of day, with an optional link to
// join the class online (the tutor's own Google Meet, Zoom or Jitsi). The class's students see today's classes, or the next one, on
// their Home, with a Join button when there is a link. Any tutor of the tuition keeps it.

const _rule = EdgeInsets.fromLTRB(0, 26, 0, 12);

/// As the server allows (lib/timetable.ts).
const maxTimesPerClass = 10;

/// The app's own link to a class's timetable: [name] is the class's name, shown above the title.
String timetableLink(ClassRef ref, String name) => '/t/timetable?'
    '${ref.courseId != null ? 'course=${ref.courseId}' : 'class=${ref.classLevel}&subject=${ref.subjectId}'}&name=${Uri.encodeComponent(name)}';

/// The line on a group's or course's page that opens its timetable, saying what it holds.
class TimetableButton extends StatelessWidget {
  const TimetableButton({super.key, required this.times, required this.onTap});

  final List<ClassTime> times;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final label = switch (times.length) {
      0 => 'Add class times',
      1 => 'Timetable · ${daysLabel(times.first.weekdays)} · ${startLabel(times.first.startsAt)}',
      final n => 'Timetable · $n class times',
    };
    return SecondaryButton(label, icon: Ph.calendarBlank, onTap: onTap);
  }
}

// ---------------------------------------------------------------- a class's timetable

class TimetableScreen extends StatefulWidget {
  const TimetableScreen({super.key, required this.ref, required this.name});

  final ClassRef ref;

  /// The class's name: "9th Maths", or the course's.
  final String name;

  @override
  State<TimetableScreen> createState() => _TimetableScreenState();
}

class _TimetableScreenState extends State<TimetableScreen> {
  List<ClassTime>? _times;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await api.get('/teacher/class-times?${widget.ref.query}');
      if (mounted) {
        setState(() {
          _times = ClassTime.list(r is Map ? r['times'] : null);
          _error = null;
        });
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _edit([ClassTime? t]) async {
    final changed = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => ClassTimeScreen(ref: widget.ref, name: widget.name, time: t)),
    );
    if (changed == true && mounted) await _load();
  }

  @override
  Widget build(BuildContext context) {
    final times = _times;
    final full = (times?.length ?? 0) >= maxTimesPerClass;
    return PushedPanel(
      onRefresh: _load,
      kicker: widget.name,
      title: 'Timetable',
      footer: times == null || full ? null : PrimaryButton('Add a class time', leadingIcon: Ph.plus, onTap: () => _edit()),
      children: [
        if (times == null && _error != null)
          ErrorState(message: _error!, onRetry: _load)
        else if (times == null)
          const LoadingState(rows: 2)
        else ...[
          const SizedBox(height: 12),
          Fig(
            "When the class meets each week, and the link to join it online. Its students see today's classes on their Home, "
            'with a Join button when there is a link.',
            style: bodyStyle.copyWith(color: muted),
          ),
          if (times.isEmpty) ...[
            const SizedBox(height: 22),
            const EmptyState(
              icon: Ph.calendarBlank,
              title: 'No class times yet',
              body: 'Add when the class meets, and the link to your Google Meet, Zoom or Jitsi class if you teach online.',
            ),
          ] else ...[
            SectionRule('Each week', count: times.length, padding: _rule),
            for (final (i, t) in times.indexed) ...[
              if (i > 0) const SizedBox(height: 8),
              RowTile(
                leading: Icon(Ph.clock, size: 20, color: muted),
                title: timeLine(t),
                meta: [t.joinUrl != null ? 'Join on ${linkHost(t.joinUrl!)}' : 'No link to join online', ?t.note].join(' · '),
                chevron: true,
                onTap: () => _edit(t),
              ),
            ],
            if (full) ...[
              const SizedBox(height: 12),
              Fig('A class can have up to $maxTimesPerClass times. Change one to add another.', style: labelStyle),
            ],
          ],
        ],
      ],
    );
  }
}

// ---------------------------------------------------------------- one time, added or changed

/// Adding a time to a class, or changing one ([time]). Pops true once something was saved or taken off.
class ClassTimeScreen extends StatefulWidget {
  const ClassTimeScreen({super.key, required this.ref, required this.name, this.time});

  final ClassRef ref;
  final String name;
  final ClassTime? time;

  @override
  State<ClassTimeScreen> createState() => _ClassTimeScreenState();
}

class _ClassTimeScreenState extends State<ClassTimeScreen> {
  late final Set<int> _days = {...?widget.time?.weekdays};
  late String _start = widget.time?.startsAt ?? '16:00';
  late int _minutes = widget.time?.minutes ?? 60;
  late final _link = TextEditingController(text: widget.time?.joinUrl ?? '');
  late final _note = TextEditingController(text: widget.time?.note ?? '');
  bool _busy = false;
  String? _problem;

  static const _lengths = [30, 45, 60, 90, 120];

  @override
  void dispose() {
    _link.dispose();
    _note.dispose();
    super.dispose();
  }

  Future<void> _pickStart() async {
    final p = _start.split(':');
    final picked = await showTimePicker(
      context: context,
      initialTime: TimeOfDay(hour: int.tryParse(p.first) ?? 16, minute: int.tryParse(p.last) ?? 0),
      helpText: 'The class starts at',
    );
    if (picked != null && mounted) {
      setState(() => _start = '${picked.hour.toString().padLeft(2, '0')}:${picked.minute.toString().padLeft(2, '0')}');
    }
  }

  Future<void> _save() async {
    if (_days.isEmpty || _busy) return;
    final link = _link.text.trim();
    // The server says the same; saying it here saves a round trip for the commonest slip, a link copied without its start.
    if (link.isNotEmpty && !isOpenableLink(link)) {
      setState(() => _problem = 'The link must start with https://. Copy it from your Google Meet, Zoom or Jitsi class.');
      return;
    }
    setState(() {
      _busy = true;
      _problem = null;
    });
    final note = _note.text.trim();
    final body = ClassTime(
      id: widget.time?.id ?? '',
      weekdays: [..._days]..sort(),
      startsAt: _start,
      minutes: _minutes,
      joinUrl: link.isEmpty ? null : link,
      note: note.isEmpty ? null : note,
    ).toBody();
    try {
      if (widget.time == null) {
        await api.post('/teacher/class-times', {...widget.ref.body, ...body});
      } else {
        await api.put('/teacher/class-times/${widget.time!.id}', body);
      }
      if (mounted) Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _problem = e.message;
        });
      }
    }
  }

  Future<void> _takeOff() async {
    final t = widget.time!;
    final yes = await confirmCard(
      context,
      title: 'Take this time off?',
      body: '${timeLine(t)}. Students stop seeing it on their Home.',
      confirm: 'Take off',
      destructive: true,
    );
    if (!yes || !mounted) return;
    try {
      await api.delete('/teacher/class-times/${t.id}');
      if (mounted) Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      if (mounted) showProblem(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final lengths = {..._lengths, _minutes}.toList()..sort();
    return PushedPanel(
      kicker: widget.name,
      title: widget.time == null ? 'Add a class time' : 'Class time',
      footer: PrimaryButton(_busy ? 'Saving…' : 'Save', onTap: _days.isEmpty || _busy ? null : _save),
      children: [
        const SectionRule('Days', padding: _rule),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (var d = 1; d <= 7; d++)
            SegChip(
              weekdayShort[d - 1],
              selected: _days.contains(d),
              onTap: () => setState(() {
                if (!_days.remove(d)) _days.add(d);
              }),
            ),
        ]),
        const SectionRule('Starts at', padding: _rule),
        SelectField(value: startLabel(_start), onTap: _pickStart),
        const SectionRule('Runs for', padding: _rule),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final m in lengths) SegChip(lengthLabel(m), selected: m == _minutes, onTap: () => setState(() => _minutes = m)),
        ]),
        const SectionRule('Link to join online', padding: _rule),
        GroupedInputs(children: [
          BareField(
            controller: _link,
            placeholder: 'https://meet.google.com/…',
            keyboard: TextInputType.url,
            onChanged: (_) => setState(() => _problem = null),
          ),
        ]),
        const SizedBox(height: 8),
        Fig(
          'Paste the link of your Google Meet, Zoom or Jitsi class if you teach online: students tap Join to open it. Leave it empty '
          'for a class in person.',
          style: labelStyle,
        ),
        const SectionRule('A note for students', padding: _rule),
        GroupedInputs(children: [BareField(controller: _note, placeholder: 'Optional, such as "Bring the lab book"', maxLength: 80)]),
        if (_problem != null) ...[const SizedBox(height: 12), InlineNotice(_problem!, tone: Tone.danger, icon: Ph.warning)],
        if (widget.time != null) ...[
          const SizedBox(height: 26),
          SecondaryButton('Take this time off', icon: Ph.trash, tint: danger, onTap: _busy ? null : _takeOff),
        ],
      ],
    );
  }
}
