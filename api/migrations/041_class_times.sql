-- The timetable (24 November 2026): when each class meets, and the link to join it online. A tutor gives a class one or more
-- times, each on a set of weekdays at one time of day, with an optional link to the tutor's own Google Meet, Zoom, Jitsi or other
-- online class. The class's students see today's classes, or the next one, on their Home, with a Join button when there is a
-- link. The app has no video of its own: joining opens the tutor's chosen service outside the app.
--
--   class_times   one time of a class: the group or course it belongs to, its weekdays (1 Monday to 7 Sunday), the time it starts
--                 in India, how many minutes it runs, the link to join it (https only) and a short note.
--
-- A time belongs to the group or course row itself, so removing a group or deleting a course removes its times, and renaming a
-- subject keeps them (the group is updated in place). Deleting a subject or the tuition takes them too.
--
-- Only adds, so the API from before keeps working against it.

create table if not exists class_times (
  id          uuid primary key default gen_random_uuid(),
  tuition_id  uuid not null references tuitions(id) on delete cascade,
  group_id    uuid references groups(id) on delete cascade,
  course_id   uuid references courses(id) on delete cascade,
  weekdays    smallint[] not null,
  starts_at   time not null,
  minutes     smallint not null check (minutes between 10 and 360),
  join_url    text check (join_url is null or (join_url like 'https://%' and length(join_url) <= 500)),
  note        text check (note is null or length(note) <= 80),
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint class_times_class check ((group_id is null) <> (course_id is null)),
  constraint class_times_days check (cardinality(weekdays) between 1 and 7 and weekdays <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[])
);

create index if not exists class_times_group on class_times (group_id) where group_id is not null;
create index if not exists class_times_course on class_times (course_id) where course_id is not null;
create index if not exists class_times_tuition on class_times (tuition_id);
