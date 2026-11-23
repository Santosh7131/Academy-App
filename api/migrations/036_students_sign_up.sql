-- Students make their own accounts (a username and password, or Google) and join a group or a course with the link
-- or QR code its tutor shares. A tutor lets each one in. Tutors no longer make students' logins on the live server.

-- Google sign-in keeps only Google's number for the account ("sub"), never the email address.
alter table users add column if not exists google_sub text;
create unique index if not exists users_google_sub_key on users (google_sub) where google_sub is not null;

-- One link for each group and each course. Its code is long and random (about 50 bits), so nobody can guess
-- another group's link; making a new one replaces the old, which then stops working.
create table if not exists join_links (
  id          uuid primary key default gen_random_uuid(),
  tuition_id  uuid not null references tuitions(id) on delete cascade,
  code        text not null unique check (code ~ '^[A-HJ-NP-Z2-9]{10}$'),
  group_id    uuid references groups(id) on delete cascade,
  course_id   uuid references courses(id) on delete cascade,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  check ((group_id is null) <> (course_id is null))
);
create unique index if not exists join_links_group_key on join_links (group_id) where group_id is not null;
create unique index if not exists join_links_course_key on join_links (course_id) where course_id is not null;
create index if not exists join_links_tuition_idx on join_links (tuition_id);

-- A student who opened a link and asked to join its group or course. A tutor lets them in, or declines, from Home.
-- A student new to the tuition also has a pending membership while they wait, as with the tuition's join code.
create table if not exists join_requests (
  id          uuid primary key default gen_random_uuid(),
  tuition_id  uuid not null references tuitions(id) on delete cascade,
  student_id  uuid not null references users(id) on delete cascade,
  group_id    uuid references groups(id) on delete cascade,
  course_id   uuid references courses(id) on delete cascade,
  asked_at    timestamptz not null default now(),
  check ((group_id is null) <> (course_id is null))
);
create unique index if not exists join_requests_group_key on join_requests (student_id, group_id) where group_id is not null;
create unique index if not exists join_requests_course_key on join_requests (student_id, course_id) where course_id is not null;
create index if not exists join_requests_tuition_idx on join_requests (tuition_id, asked_at);
