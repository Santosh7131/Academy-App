import 'package:flutter_test/flutter_test.dart';
import 'package:tuition_app/core/changes.dart';

// Which screens load again after a write (lib/core/changes.dart), for the newest routes.
void main() {
  test('adding ready-made questions reloads the screens that list questions', () {
    expect(areasOf('/teacher/ready-made'), {Area.questions});
    expect(areasOf('/teacher/ready-made?class=9'), {Area.questions});
  });

  test('a class time reloads the group and course pages', () {
    expect(areasOf('/teacher/class-times'), {Area.students, Area.courses});
    expect(areasOf('/teacher/class-times/ct-1'), {Area.students, Area.courses});
  });
}
