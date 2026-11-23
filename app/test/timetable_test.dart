import 'package:flutter_test/flutter_test.dart';
import 'package:tuition_app/core/links.dart';
import 'package:tuition_app/core/timetable.dart';

// The timetable's wording and the rule for which join links the app opens (lib/core/timetable.dart, lib/core/links.dart).
void main() {
  test('days read as people say them', () {
    expect(daysLabel([1, 2, 3, 4, 5, 6, 7]), 'Every day');
    expect(daysLabel([5, 4, 3, 2, 1]), 'Mon to Fri');
    expect(daysLabel([1, 2, 3, 4, 5, 6]), 'Mon to Sat');
    expect(daysLabel([6, 7]), 'Sat and Sun');
    expect(daysLabel([1, 3, 5]), 'Mon, Wed, Fri');
    expect(daysLabel([3, 3]), 'Wed');
  });

  test('lengths and starts', () {
    expect(lengthLabel(45), '45 min');
    expect(lengthLabel(60), '1 hr');
    expect(lengthLabel(90), '1 hr 30 min');
    expect(startLabel('16:30').replaceAll(' ', ' '), anyOf('4:30 pm', '4:30 pm'));
  });

  test('only plain https links with a website are opened', () {
    expect(isOpenableLink('https://meet.google.com/abc-defg-hij'), isTrue);
    expect(isOpenableLink('https://zoom.us/j/123?pwd=x'), isTrue);
    expect(isOpenableLink('http://meet.google.com/abc'), isFalse);
    expect(isOpenableLink('javascript:alert(1)'), isFalse);
    expect(isOpenableLink('intent://scan/#Intent;scheme=zxing;end'), isFalse);
    expect(isOpenableLink('https://user:pw@meet.google.com/abc'), isFalse);
    expect(isOpenableLink('https://localhost/x'), isFalse);
    expect(isOpenableLink(null), isFalse);
    expect(linkHost('https://meet.google.com/abc-defg-hij'), 'meet.google.com');
  });

  test('a time reads from the server and goes back as it came', () {
    final t = ClassTime.from({'id': 'ct-1', 'weekdays': [1, 3], 'starts_at': '07:00', 'minutes': 45, 'join_url': null, 'note': ''})!;
    expect(t.joinUrl, isNull);
    expect(t.note, isNull);
    expect(timeLine(t), contains('Mon and Wed'));
    expect(t.toBody(), {'weekdays': [1, 3], 'starts_at': '07:00', 'minutes': 45, 'join_url': '', 'note': ''});
    expect(ClassTime.from({'id': 'x'}), isNull);
    expect(ClassTime.list([{'id': 'x'}, null, 'junk']), isEmpty);
  });
}
