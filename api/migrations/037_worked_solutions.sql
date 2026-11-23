-- Worked solutions written by AI (23 November 2026). A tutor asks AI for the worked solutions of a test's questions that have
-- none; students see one after they hand the test in, as they see a solution the tutor wrote. Each costs AI credit, as reading a
-- page does. AI works a question out without being told the marked answer, and what it wrote is kept only when it reaches that
-- answer: one that reaches another answer, or needs a figure AI cannot see, is not kept and not charged. AI never replaces a
-- solution that is there already.
--
--   questions.solution_by_ai          true while the solution is the one AI wrote; the tutor changing it makes it the tutor's.
--   credit_ledger kind 'solutions'    AI work: `questions` worked solutions written for the test `test_id` (its name in `label`,
--                                     which the line keeps if the test is deleted).
--   app_settings credit_solution_paise   the price of one worked solution: 40 paise to start; the admin app changes it.
--
-- Only adds and widens, so the API from before keeps working against it.

alter table questions add column if not exists solution_by_ai boolean not null default false;

alter table credit_ledger add column if not exists test_id uuid references tests(id) on delete set null;
-- Deleting a test finds its lines by this, not by reading the whole ledger.
create index if not exists credit_ledger_test_idx on credit_ledger(test_id) where test_id is not null;

-- 033 left these three rules unnamed, so Postgres named them credit_ledger_kind_check, credit_ledger_check1 and
-- credit_ledger_check2 (read from pg_constraint on a database that ran every migration). They are put back wider, with names.
alter table credit_ledger drop constraint if exists credit_ledger_kind_check;
alter table credit_ledger add constraint credit_ledger_kind_check
  check (kind in ('start', 'topup', 'by_hand', 'page', 'questions', 'solutions'));

-- `questions` is how many questions a line of AI work covers: questions written, or worked solutions written.
alter table credit_ledger drop constraint if exists credit_ledger_check1;
alter table credit_ledger drop constraint if exists credit_ledger_counted;
alter table credit_ledger add constraint credit_ledger_counted check ((kind in ('questions', 'solutions')) = (questions is not null));

-- AI work takes credit away; nothing else does.
alter table credit_ledger drop constraint if exists credit_ledger_check2;
alter table credit_ledger drop constraint if exists credit_ledger_spent;
alter table credit_ledger add constraint credit_ledger_spent check ((kind in ('page', 'questions', 'solutions')) = (amount_paise < 0));

insert into app_settings (key, value) values ('credit_solution_paise', '40') on conflict (key) do nothing;
