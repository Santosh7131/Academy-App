-- Attendance (23 November 2026): a tutor takes a class's register for a day by marking who did not come; everyone else in
-- the class is marked present. A class is a group (a class level and a subject, the way tests name one) or a course.
--
--   attendance_days    one register: its class, its day in India's calendar, who took it and when. There is one per class
--                      per day, so two tutors taking the same class's register update the same one.
--   attendance_marks   one row per student on a register, present or not, so a register still says who was there after a
--                      student changes class or leaves it.
--
-- A group's registers are found by its class level and subject, as its tests are, so removing a group and adding it again
-- keeps them. Deleting a course, a subject or the tuition takes their registers with it. A student's marks go when their
-- account is deleted, and when a tutor removes them from the tuition (routes/teacher.ts), as their results do.
--
-- Only adds, so the API from before keeps working against it.

create table if not exists attendance_days (
  id           uuid primary key default gen_random_uuid(),
  tuition_id   uuid not null references tuitions(id) on delete cascade,
  class_level  smallint,
  subject_id   uuid references subjects(id) on delete cascade,
  course_id    uuid references courses(id) on delete cascade,
  day          date not null,
  taken_by     uuid references users(id) on delete set null,
  taken_at     timestamptz not null default now(),
  constraint attendance_days_class check (
    (course_id is not null and class_level is null and subject_id is null)
    or (course_id is null and class_level is not null and subject_id is not null)
  )
);

-- One register per class per day; routes/attendance.ts saves with `on conflict` on these.
create unique index if not exists attendance_days_group_day on attendance_days (tuition_id, class_level, subject_id, day) where course_id is null;
create unique index if not exists attendance_days_course_day on attendance_days (course_id, day) where course_id is not null;

create table if not exists attendance_marks (
  day_id      uuid not null references attendance_days(id) on delete cascade,
  student_id  uuid not null references users(id) on delete cascade,
  present     boolean not null,
  primary key (day_id, student_id)
);

-- A student's page, a report for parents and the student's Home read one student's marks.
create index if not exists attendance_marks_student on attendance_marks (student_id);
