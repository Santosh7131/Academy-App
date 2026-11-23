import 'format.dart' as f;

// The timetable (api/src/lib/timetable.ts): a class's times, each on a set of weekdays at one time of day in India, with an optional
// link to join the class online.

/// One time of a class. `weekdays` run from 1 (Monday) to 7 (Sunday); `startsAt` is "16:30".
class ClassTime {
  const ClassTime({required this.id, required this.weekdays, required this.startsAt, required this.minutes, this.joinUrl, this.note, this.name, this.kind, this.day});

  final String id;
  final List<int> weekdays;
  final String startsAt;
  final int minutes;
  final String? joinUrl;
  final String? note;

  /// On a student's Home: the class's name (the subject of a group, a course's name), 'group' or 'course', and for the next class,
  /// its day as "2026-11-26".
  final String? name;
  final String? kind;
  final String? day;

  static ClassTime? from(Object? j) {
    if (j is! Map || j['id'] is! String || j['weekdays'] is! List || j['starts_at'] is! String || j['minutes'] is! num) return null;
    String? text(Object? v) => v is String && v.isNotEmpty ? v : null;
    return ClassTime(
      id: j['id'] as String,
      weekdays: [for (final d in j['weekdays'] as List) if (d is num) d.toInt()],
      startsAt: j['starts_at'] as String,
      minutes: (j['minutes'] as num).toInt(),
      joinUrl: text(j['join_url']),
      note: text(j['note']),
      name: text(j['name']),
      kind: text(j['kind']),
      day: text(j['day']),
    );
  }

  static List<ClassTime> list(Object? j) => [for (final t in (j is List ? j : const [])) ?ClassTime.from(t)];

  /// What the server takes to add or change it.
  Map<String, Object?> toBody() => {'weekdays': weekdays, 'starts_at': startsAt, 'minutes': minutes, 'join_url': joinUrl ?? '', 'note': note ?? ''};
}

const weekdayShort = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/// "Every day", "Mon to Fri", "Mon to Sat", "Sat and Sun" or "Mon, Wed, Fri".
String daysLabel(List<int> days) {
  final d = [...{...days}]..sort();
  if (d.length == 7) return 'Every day';
  if (d.join(',') == '1,2,3,4,5') return 'Mon to Fri';
  if (d.join(',') == '1,2,3,4,5,6') return 'Mon to Sat';
  final names = [for (final x in d) if (x >= 1 && x <= 7) weekdayShort[x - 1]];
  if (names.length == 2) return '${names[0]} and ${names[1]}';
  return names.join(', ');
}

/// "4:30 pm" from "16:30".
String startLabel(String hhmm) {
  final p = hhmm.split(':');
  final h = p.isNotEmpty ? int.tryParse(p[0]) ?? 0 : 0;
  final m = p.length > 1 ? int.tryParse(p[1]) ?? 0 : 0;
  return f.time(DateTime(2026, 1, 1, h, m));
}

/// "45 min", "1 hr", "1 hr 30 min".
String lengthLabel(int minutes) {
  final h = minutes ~/ 60;
  final m = minutes % 60;
  if (h == 0) return '$m min';
  return m == 0 ? '$h hr' : '$h hr $m min';
}

/// "Mon, Wed, Fri · 4:30 pm · 1 hr".
String timeLine(ClassTime t) => '${daysLabel(t.weekdays)} · ${startLabel(t.startsAt)} · ${lengthLabel(t.minutes)}';
