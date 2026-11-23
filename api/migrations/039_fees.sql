-- Fees: each student's monthly fee and the payments against it, with receipts (lib/fees.ts, routes/fees.ts). Only a tuition's
-- owner sees them. Parents pay the tutor straight to the tutor's UPI id, or in cash; the app never holds the money.
--
-- A fee is set from a month on (fee_rates): the fee in force for a month is the one set from the latest month not after it,
-- so a new fee leaves the months before it as they were, and a fee of 0 stops it. Nothing is owed for a month before the
-- student joined.
--
-- A payment (fee_payments) is for one month. A tutor's is confirmed at once and takes the tuition's next receipt number;
-- a student's "I have paid" is a claim until the tutor confirms it, and a student has one claim open for a month at most.
-- Payments are the tutor's records, so they outlive the student: removing a student from the tuition keeps them, and so does
-- the student deleting their account (student_id becomes null; the name stays). Deleting the tuition takes them.

alter table tuitions add column if not exists upi_id text;
alter table tuitions add column if not exists upi_name text;
-- The last receipt number given. Numbers are never given twice, even after a payment is taken away.
alter table tuitions add column if not exists fee_receipt_no integer not null default 0;
alter table tuitions drop constraint if exists tuitions_upi_id_shape;
alter table tuitions add constraint tuitions_upi_id_shape check (upi_id is null or upi_id ~ '^[a-z0-9._-]{2,200}@[a-z][a-z0-9.-]{1,63}$');
alter table tuitions drop constraint if exists tuitions_upi_name_length;
alter table tuitions add constraint tuitions_upi_name_length check (upi_name is null or length(upi_name) between 1 and 50);

create table if not exists fee_rates (
  tuition_id  uuid not null references tuitions(id) on delete cascade,
  student_id  uuid not null references users(id) on delete cascade,
  from_month  date not null check (extract(day from from_month) = 1),
  fee_paise   integer not null check (fee_paise between 0 and 10000000),
  due_day     smallint not null check (due_day between 1 and 28),
  set_by      uuid references users(id) on delete set null,
  set_at      timestamptz not null default now(),
  primary key (tuition_id, student_id, from_month)
);
create index if not exists fee_rates_student on fee_rates (student_id);

create table if not exists fee_payments (
  id            uuid primary key default gen_random_uuid(),
  tuition_id    uuid not null references tuitions(id) on delete cascade,
  student_id    uuid references users(id) on delete set null,
  student_name  text not null check (length(student_name) between 1 and 200),
  month         date not null check (extract(day from month) = 1),
  amount_paise  integer not null check (amount_paise between 1 and 100000000),
  method        text not null check (method in ('cash', 'upi', 'other')),
  paid_on       date not null,
  reference     text check (reference is null or length(reference) between 1 and 60),
  status        text not null check (status in ('claimed', 'confirmed')),
  receipt_no    integer,
  recorded_by   uuid references users(id) on delete set null,
  confirmed_by  uuid references users(id) on delete set null,
  confirmed_at  timestamptz,
  created_at    timestamptz not null default now(),
  constraint fee_payments_receipt check ((status = 'confirmed') = (receipt_no is not null))
);
create unique index if not exists fee_payments_receipt_no on fee_payments (tuition_id, receipt_no) where receipt_no is not null;
create unique index if not exists fee_payments_one_claim on fee_payments (tuition_id, student_id, month) where status = 'claimed';
create index if not exists fee_payments_month on fee_payments (tuition_id, month);
create index if not exists fee_payments_student on fee_payments (student_id);
