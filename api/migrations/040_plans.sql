-- Plans (24 Nov 2026): each tuition is on Free, Basic or Pro, which sets how many students and tutors it can have and how much AI
-- it gets (lib/plans.ts). Santosh's sizes: Free 20 students, 1 tutor and the one-time free start of AI credit; Basic 100 students,
-- 3 tutors and ₹300 of AI a month; Pro 300 students, 10 tutors and ₹900 of AI a month. When a month's AI is used up, AI waits for
-- the next month or a bigger plan: there are no top-ups on a plan. Every number, and the prices, live in app_settings, where the
-- admin app changes them. No price is set here: until the developer sets one, a plan cannot be bought.
--
-- A tutor pays by UPI with the tuition's payment code in the note and taps "I have paid" (plan_requests); the developer finds the
-- payment and marks the request received, which starts or extends the plan. The developer can also set a plan by hand.
--
--   tuitions.plan            'free', 'basic' or 'pro': the plan bought last.
--   tuitions.plan_from       the day the plan's current stretch began; its months are counted from this day.
--   tuitions.plan_until      the first day it no longer covers. A plan past it counts as Free; nothing is deleted, and only adding
--                            students or tutors past Free's sizes, and AI past what is left, waits.
--   tuitions.plan_refilled   the first day of the last plan month whose AI was given (credit_ledger kind 'plan'): each month of a
--                            plan tops the credit up to the plan's AI once, never lowering it, on the first AI work that month.
--   plan_requests            a tutor's "I have paid" for a plan, waiting until the developer has checked the payment.
--   plan_periods             every stretch of a plan given: paid (from a request, or a payment the developer found) or given free.
--                            The money stays on record when the tuition is deleted, with its name, as credit payments do.
--
-- 012 made tuitions.plan ('free', 'tutor', 'tuition' or 'institute') and plan_until (a time) for plans that were never sold: no
-- code ever set them, so every tuition is on 'free' with no end. They become these plans, and plan_until a day.
--
-- Otherwise it only adds, so the API from before keeps working against it.

alter table tuitions add column if not exists plan text not null default 'free';
alter table tuitions drop constraint if exists tuitions_plan_check;
alter table tuitions add column if not exists plan_from date;
alter table tuitions add column if not exists plan_until date;
alter table tuitions alter column plan_until type date using (plan_until at time zone 'Asia/Kolkata')::date;
alter table tuitions add column if not exists plan_refilled date;
update tuitions set plan = 'free', plan_until = null
 where plan not in ('basic', 'pro') and (plan <> 'free' or plan_until is not null);
alter table tuitions drop constraint if exists tuitions_plan_known;
alter table tuitions add constraint tuitions_plan_known check (plan in ('free', 'basic', 'pro'));
alter table tuitions drop constraint if exists tuitions_plan_dates;
alter table tuitions add constraint tuitions_plan_dates
  check ((plan = 'free') = (plan_until is null) and (plan_from is null) = (plan_until is null) and (plan_until is null or plan_until > plan_from));

-- A plan's monthly AI goes in as its own kind of credit line, which goes with the tuition like the free start.
alter table credit_ledger drop constraint if exists credit_ledger_kind_check;
alter table credit_ledger add constraint credit_ledger_kind_check
  check (kind in ('start', 'topup', 'by_hand', 'page', 'questions', 'solutions', 'plan'));

create table if not exists plan_requests (
  id            uuid primary key default gen_random_uuid(),
  tuition_id    uuid not null references tuitions(id) on delete cascade,
  plan          text not null check (plan in ('basic', 'pro')),
  months        smallint not null check (months between 1 and 12),
  -- What the tutor was shown and paid, as it was then: the price for the months, the code and the UPI id.
  amount_paise  integer not null check (amount_paise > 0),
  code          text not null,
  upi_id        text not null,
  status        text not null default 'waiting' check (status in ('waiting', 'received', 'declined')),
  asked_by      uuid references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  decided_at    timestamptz,
  decided_by    uuid references users(id) on delete set null,
  check ((status = 'waiting') = (decided_at is null))
);
create index if not exists plan_requests_waiting_idx on plan_requests(created_at) where status = 'waiting';
create index if not exists plan_requests_tuition_idx on plan_requests(tuition_id, created_at desc);

create table if not exists plan_periods (
  id            uuid primary key default gen_random_uuid(),
  tuition_id    uuid references tuitions(id) on delete set null,
  -- The tuition's name, written when the tuition is deleted, so the developer can still tell whose payment it was.
  client_name   text,
  plan          text not null check (plan in ('basic', 'pro')),
  months        smallint not null check (months between 1 and 24),
  -- What was paid; 0 for a stretch the developer gave.
  amount_paise  integer not null check (amount_paise >= 0),
  period_from   date not null,
  period_until  date not null check (period_until > period_from),
  request_id    uuid,
  -- The payment's reference: the code, or the UPI transaction id the developer typed.
  ref           text,
  by_user       uuid references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  check (tuition_id is not null or client_name is not null)
);
create index if not exists plan_periods_tuition_idx on plan_periods(tuition_id, created_at desc);
create index if not exists plan_periods_month_idx on plan_periods(created_at);

-- Deleting a tuition in any way keeps what it paid for plans, under its name (as 035 does for credit).
create or replace function plan_periods_before_tuition_delete() returns trigger
language plpgsql as $$
begin
  update plan_periods set client_name = coalesce(client_name, old.name) where tuition_id = old.id;
  return old;
end $$;

drop trigger if exists tuitions_keep_plan_payments on tuitions;
create trigger tuitions_keep_plan_payments before delete on tuitions
  for each row execute function plan_periods_before_tuition_delete();

-- The sizes Santosh chose. No prices: a plan is not on sale until the developer sets its price in the admin app.
-- plan_pay_where says where a plan can be bought: 'both' (the app and the web version), 'web' or 'app'.
insert into app_settings (key, value) values
  ('plan_free_students', '20'),
  ('plan_free_tutors', '1'),
  ('plan_basic_students', '100'),
  ('plan_basic_tutors', '3'),
  ('plan_basic_ai_paise', '30000'),
  ('plan_pro_students', '300'),
  ('plan_pro_tutors', '10'),
  ('plan_pro_ai_paise', '90000'),
  ('plan_pay_where', '"both"')
on conflict (key) do nothing;
