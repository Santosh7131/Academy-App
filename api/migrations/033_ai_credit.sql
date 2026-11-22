-- AI credit (stage 1 of paying for AI, decided on 2026-10-10). Each tuition has a balance in rupees that pays for AI work:
-- reading a page of a paper (with finding every answer on it) and writing a question with "Describe it to AI" each have a price.
-- Tests, students and results never need credit. A new tuition starts with a small free amount, the app shows the price before
-- each AI job, the credit is set aside while the job runs, and only work that finishes is charged: a page that fails costs nothing.
-- AI stops when the credit runs out. A tutor adds credit by paying the developer by UPI with the tuition's code in the payment
-- note and tapping "I have paid"; the developer finds the payment and marks the request received in the admin app, or adds credit
-- by hand. Every amount is in whole paise.
--
--   tuitions.credit_paise   what the tuition has left; never below zero.
--   tuitions.credit_code    four characters ("7K3Q", shown as CR-7K3Q) the tutor writes in the UPI payment note; made when first needed.
--   credit_ledger           every change to a balance: the free start, credit added (a request received, or by hand) and AI work.
--   credit_holds            credit set aside for AI work under way, so two jobs at once cannot spend the same rupees.
--   credit_requests         a tutor's "I have paid", waiting until the developer has checked the payment.
--   app_settings credit_*   the prices, the free start, whether new clients may use AI, and the UPI details tutors pay to.
--
-- A tuition made before this gets the free start, as a new one does. Only adds, so the API from before keeps working against it.

alter table tuitions add column if not exists credit_paise integer not null default 0;
alter table tuitions drop constraint if exists tuitions_credit_not_negative;
alter table tuitions add constraint tuitions_credit_not_negative check (credit_paise >= 0);
alter table tuitions add column if not exists credit_code text unique;
alter table tuitions drop constraint if exists tuitions_credit_code_shape;
alter table tuitions add constraint tuitions_credit_code_shape check (credit_code is null or credit_code ~ '^[A-HJ-NP-Z2-9]{4}$');

create table if not exists credit_ledger (
  id             uuid primary key default gen_random_uuid(),
  tuition_id     uuid not null references tuitions(id) on delete cascade,
  kind           text not null check (kind in ('start', 'topup', 'by_hand', 'page', 'questions')),
  -- Paise added (more than 0) or spent (less than 0), and the balance after it.
  amount_paise   integer not null check (amount_paise <> 0),
  balance_paise  integer not null check (balance_paise >= 0),
  -- AI work: the paper; for a page its number and the picture read (a hash of it), so reading the same picture again is free.
  paper_id       uuid references papers(id) on delete set null,
  page_no        smallint,
  picture        text,
  questions      integer check (questions is null or questions > 0),
  -- The paper's name when the work was done, which the line keeps if the paper is deleted.
  label          text,
  -- Credit added: the request it answered, and the payment's reference (the code, or the UPI transaction id the developer typed).
  request_id     uuid,
  ref            text,
  by_user        uuid references users(id) on delete set null,
  created_at     timestamptz not null default now(),
  check ((kind = 'page') = (page_no is not null and picture is not null)),
  check ((kind = 'questions') = (questions is not null)),
  check ((kind in ('page', 'questions')) = (amount_paise < 0))
);
create index if not exists credit_ledger_tuition_idx on credit_ledger(tuition_id, created_at desc);
create index if not exists credit_ledger_month_idx on credit_ledger(created_at);
-- One charge for each picture of a page.
create unique index if not exists credit_ledger_page_once on credit_ledger(paper_id, page_no, picture) where kind = 'page';

create table if not exists credit_holds (
  id            uuid primary key default gen_random_uuid(),
  tuition_id    uuid not null references tuitions(id) on delete cascade,
  amount_paise  integer not null check (amount_paise > 0),
  created_at    timestamptz not null default now()
);
create index if not exists credit_holds_tuition_idx on credit_holds(tuition_id, created_at);

create table if not exists credit_requests (
  id            uuid primary key default gen_random_uuid(),
  tuition_id    uuid not null references tuitions(id) on delete cascade,
  amount_paise  integer not null check (amount_paise > 0),
  -- The code and UPI id the tutor was shown, as they were then.
  code          text not null,
  upi_id        text not null,
  status        text not null default 'waiting' check (status in ('waiting', 'received', 'declined')),
  asked_by      uuid references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  decided_at    timestamptz,
  decided_by    uuid references users(id) on delete set null,
  check ((status = 'waiting') = (decided_at is null))
);
create index if not exists credit_requests_waiting_idx on credit_requests(created_at) where status = 'waiting';
create index if not exists credit_requests_tuition_idx on credit_requests(tuition_id, created_at desc);

-- The prices and the rest, as the admin app shows them. The server falls back to these same values when a key is missing.
insert into app_settings (key, value) values
  ('credit_page_paise', '240'),
  ('credit_question_paise', '60'),
  ('credit_start_paise', '2000'),
  ('credit_new_clients_ai', 'true'),
  ('credit_upi_id', '""'),
  ('credit_upi_name', '""')
on conflict (key) do nothing;

-- The tuitions that exist already start as a new one does.
with given as (
  update tuitions set credit_paise = 2000
   where credit_paise = 0 and not exists (select 1 from credit_ledger l where l.tuition_id = tuitions.id)
  returning id
)
insert into credit_ledger (tuition_id, kind, amount_paise, balance_paise)
select id, 'start', 2000, 2000 from given;
